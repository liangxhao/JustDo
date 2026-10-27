'use strict';

// This verifies the plugin against bare locked SDK wrappers, not a frozen
// packaged Gateway. No Gateway, user state, transcript or public endpoint runs.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { deflateSync } = require('node:zlib');

const { THREE_FIXTURE, readThreeModules } = require('./three-fixture.cjs');

const repoRoot = path.resolve(__dirname, '../../../..');
const outputRoot = path.join(repoRoot, 'build/smart-canvas/image-loading-verification');
const runtimeIndex = process.argv.indexOf('--runtime');
const runtimeRoot = path.resolve(
  runtimeIndex < 0
    ? path.join(repoRoot, 'vendor/openclaw-runtime/current/dist')
    : process.argv[runtimeIndex + 1],
);
const assetHostname = 'images.widget-fixture.example';
const cdnHostname = 'cdn.jsdelivr.net';
const assetOrigin = `https://${assetHostname}`;
const imageAdapterPath = '/__smart_canvas__/image-loading.js';
const scenarios = [
  { name: 'native-esm-document', document: true, granted: true },
  { name: 'native-esm-fragment', document: false, granted: true },
  { name: 'no-connect-grant', document: true, granted: false },
];

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: repoRoot,
    env,
    windowsHide: true,
    stdio: 'inherit',
  });
  child.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
  });
} else {
  void main().catch(error => {
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(
      path.join(outputRoot, 'failure.json'),
      JSON.stringify({ error: error.stack ?? error.message }, null, 2),
    );
    console.error(error.stack ?? error.message);
    require('electron').app.exit(1);
  });
}

/** Runs as ordinary author code in the native opaque inner iframe. */
async function probeImages(options, THREE, OrbitControls) {
  const { location, parent, document, Image } = globalThis;
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = (promise, message) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 10000)),
    ]);
  const imageResult = (image, setSource) =>
    deadline(
      new Promise(resolve => {
        image.addEventListener('load', () => resolve('load'), { once: true });
        image.addEventListener('error', () => resolve('error'), { once: true });
        setSource();
      }),
      'Image did not settle',
    );
  let renderer;
  try {
    check(location.origin === 'null', 'Native widget must have an opaque origin');
    check(typeof process === 'undefined', 'Node leaked into author code');
    let parentBlocked = false;
    try {
      void parent.document;
    } catch {
      parentBlocked = true;
    }
    check(parentBlocked, 'Author can access sandbox parent');
    check(globalThis.__imageAdapterBeforeAuthor === true, 'Adapter did not precede author code');
    check(
      THREE.REVISION === options.threeRevision && typeof OrbitControls === 'function',
      'Real CDN modules did not load',
    );
    const violations = [];
    document.addEventListener('securitypolicyviolation', event =>
      violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }),
    );
    const result = {
      opaqueOrigin: true,
      parentBlocked: true,
      adapterBeforeAuthor: true,
      module: 'actual-three-module',
      threeRevision: THREE.REVISION,
    };
    if (!options.granted) {
      const image = new Image();
      let errors = 0;
      image.addEventListener('error', () => errors++);
      check(
        (await imageResult(image, () => (image.src = `${options.origin}/ungranted.png`))) ===
          'error',
        'Unapproved image must fail through native connect-src',
      );
      await pause(80);
      check(errors === 1, 'Denied image must dispatch one error');
      check(
        violations.some(item => item.directive === 'connect-src'),
        'Native connect CSP missing',
      );
      result.deniedWithoutGrant = true;
    } else {
      const textures = [];
      let loaded = 0;
      let textureErrors = 0;
      const manager = new THREE.LoadingManager();
      let managerLoaded = 0;
      manager.onLoad = () => managerLoaded++;
      const loader = new THREE.TextureLoader(manager);
      await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          deadline(
            new Promise((resolve, reject) => {
              // The original globe uses this unmodified TextureLoader URL API.
              const texture = loader.load(
                `${options.origin}/texture-${index}.png`,
                () => {
                  loaded++;
                  textures[index] = texture;
                  resolve();
                },
                undefined,
                error => {
                  textureErrors++;
                  reject(error);
                },
              );
            }),
            'TextureLoader did not complete',
          ),
        ),
      );
      check(
        loaded === 4 && textureErrors === 0 && managerLoaded === 1,
        'LoadingManager completion',
      );
      check(
        textures.every(
          texture =>
            texture.image.naturalWidth === 2 && texture.image.src.startsWith('data:image/png;'),
        ),
        'HTTPS images were not decoded from data URLs',
      );
      renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
      renderer.setSize(400, 260);
      renderer.setClearColor(0x071224);
      document.getElementById('display').append(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, 400 / 260, 0.1, 100);
      camera.position.z = 5;
      for (let index = 0; index < 4; index++) {
        textures[index].colorSpace = THREE.SRGBColorSpace;
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.8, 0.8, 0.8),
          new THREE.MeshBasicMaterial({ map: textures[index] }),
        );
        mesh.position.x = ((index % 2) - 0.5) * 1.1;
        mesh.position.y = (index < 2 ? 1 : -1) * 0.6;
        scene.add(mesh);
      }
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.update();
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      const pixel = new Uint8Array(4);
      gl.readPixels(165, 160, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      check(
        renderer.info.render.triangles === 48 && pixel[0] > pixel[2],
        'Texture did not reach WebGL',
      );
      Object.assign(result, {
        textures: loaded,
        loadingManager: managerLoaded,
        triangles: renderer.info.render.triangles,
        pixel: Array.from(pixel),
      });

      const staticImage = document.getElementById('static-image');
      for (let attempt = 0; staticImage.naturalWidth === 0 && attempt < 100; attempt++)
        await pause(20);
      check(
        staticImage.naturalWidth === 2 && staticImage.src.startsWith('data:image/png;'),
        `Normalized static image did not load: ${JSON.stringify({
          width: staticImage.naturalWidth,
          complete: staticImage.complete,
          source: staticImage.getAttribute('src')?.slice(0, 60),
          marker: staticImage.getAttribute('data-smart-canvas-asset-src'),
        })}`,
      );
      check(!staticImage.hasAttribute('data-smart-canvas-asset-src'), 'Static marker was not consumed');
      const attributeImage = new Image();
      check(
        (await imageResult(attributeImage, () =>
          attributeImage.setAttribute('src', `${options.origin}/attribute.png`),
        )) === 'load' && attributeImage.naturalWidth === 2,
        'setAttribute image did not load',
      );
      result.staticAndAttribute = true;

      const decodedImage = new Image();
      decodedImage.src = `${options.origin}/decode.png`;
      check(!decodedImage.complete, 'Image reported complete while its HTTPS source was pending');
      await deadline(decodedImage.decode(), 'HTTPS image decode did not settle');
      check(
        decodedImage.complete && decodedImage.naturalWidth === 2,
        'HTTPS image decode did not wait for native pixels',
      );
      const markedContainer = document.createElement('div');
      markedContainer.innerHTML = `<img data-smart-canvas-asset-src="${options.origin}/marked-decode.png">`;
      const markedImage = markedContainer.querySelector('img');
      const markedDecoded = markedImage.decode();
      check(!markedImage.complete, 'Static marker decode did not begin conversion synchronously');
      await deadline(markedDecoded, 'Static marker decode did not settle');
      check(markedImage.complete && markedImage.naturalWidth === 2, 'Static marker decode failed');
      const dataImage = new Image();
      dataImage.src = textures[1].image.src;
      await deadline(dataImage.decode(), 'Native data URL decode did not settle');
      check(dataImage.complete && dataImage.naturalWidth === 2, 'Native data URL decode changed');
      result.decodeAndComplete = true;

      for (const file of ['missing.png', 'not-image.png']) {
        const image = new Image();
        let errors = 0;
        let loads = 0;
        let decoded;
        image.addEventListener('error', () => errors++);
        image.addEventListener('load', () => loads++);
        check(
          (await imageResult(image, () => {
            image.src = `${options.origin}/${file}`;
            decoded = image.decode().then(
              () => 'resolved',
              error => error.name,
            );
          })) === 'error',
          'HTTP/decode failure must dispatch image error',
        );
        check(
          (await deadline(decoded, 'Failed image decode did not settle')) === 'EncodingError',
          'Failed image decode did not reject',
        );
        await pause(50);
        check(errors === 1 && loads === 0, 'Image failure dispatched duplicate/unexpected events');
      }
      result.errorsOnce = true;

      for (const replacement of ['https', 'data', 'remove']) {
        const image = new Image();
        let loads = 0;
        let errors = 0;
        image.addEventListener('load', () => loads++);
        image.addEventListener('error', () => errors++);
        image.src = `${options.origin}/slow-${replacement}.png`;
        const oldDecoded = image.decode().then(
          () => 'resolved',
          error => error.name,
        );
        check(!image.complete, 'Slow HTTPS image reported complete');
        await pause(40);
        if (replacement === 'remove') image.removeAttribute('src');
        else {
          const src =
            replacement === 'https' ? `${options.origin}/fast.png` : textures[1].image.src;
          check(
            (await imageResult(image, () => (image.src = src))) === 'load',
            'Replacement image failed',
          );
        }
        check(
          (await deadline(oldDecoded, 'Replaced image decode did not settle')) === 'EncodingError',
          'Source replacement did not reject the old decode',
        );
        await pause(450);
        check(
          errors === 0 && loads === (replacement === 'remove' ? 0 : 1),
          'Stale image emitted an event',
        );
        if (replacement === 'remove')
          check(!image.hasAttribute('src'), 'Old request restored removed src');
        else check(image.src.startsWith('data:image/png;'), 'Old request replaced newer image');
      }
      result.staleRaces = ['https', 'data', 'remove'];

      // srcset remains native: the adapter must not widen img-src or connect-src.
      const directImage = new Image();
      check(
        (await imageResult(directImage, () => {
          directImage.srcset = `${options.origin}/native-srcset.png 1x`;
        })) === 'error',
        'Native img-src must still deny srcset HTTPS',
      );
      check(
        violations.some(item => item.directive === 'img-src'),
        'Native img CSP missing',
      );
      result.nativeImgPolicyUnchanged = true;
    }
    parent.postMessage({ type: 'widget-image-probe', phase: 'ready', result }, '*');
  } catch (error) {
    parent.postMessage(
      { type: 'widget-image-probe', phase: 'failed', error: error.stack ?? String(error) },
      '*',
    );
  }
}

function png(color) {
  const chunk = (name, bytes) => {
    const data = Buffer.concat([Buffer.from(name), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, data, checksum]);
  };
  const dimensions = Buffer.alloc(13);
  dimensions.writeUInt32BE(2);
  dimensions.writeUInt32BE(2, 4);
  dimensions[8] = 8;
  dimensions[9] = 6;
  const row = Buffer.from([0, ...color, 255, ...color, 255]);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', dimensions),
    chunk('IDAT', deflateSync(Buffer.concat([row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function createAssets(directory, modules) {
  const key = path.join(directory, 'key.pem');
  const cert = path.join(directory, 'cert.pem');
  const config = path.join(directory, 'openssl.cnf');
  fs.writeFileSync(config, '[req]\ndistinguished_name=dn\n[dn]\n');
  await promisify(execFile)(
    process.env.WIDGET_FIXTURE_OPENSSL ?? 'openssl',
    [
      'req',
      '-config',
      config,
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-sha256',
      '-subj',
      `/CN=${assetHostname}`,
      '-addext',
      `subjectAltName=DNS:${assetHostname},DNS:${cdnHostname}`,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { windowsHide: true },
  );
  const certificate = fs.readFileSync(cert, 'utf8');
  const audit = [];
  const connections = new Set();
  let scenario;
  const assets = https.createServer(
    { key: fs.readFileSync(key), cert: certificate },
    (request, response) => {
      audit.push({
        scenario,
        host: request.headers.host,
        path: request.url,
        method: request.method,
        origin: request.headers.origin,
        cookie: !!request.headers.cookie,
        authorization: !!request.headers.authorization,
      });
      response.setHeader('Access-Control-Allow-Origin', 'null');
      response.setHeader('Cache-Control', 'no-store');
      if (request.headers.host === cdnHostname && modules.has(request.url)) {
        response
          .writeHead(200, { 'Content-Type': 'text/javascript' })
          .end(modules.get(request.url));
        return;
      }
      if (request.headers.host !== assetHostname) return response.writeHead(404).end();
      if (request.url === '/missing.png') return response.writeHead(404).end();
      if (request.url === '/not-image.png')
        return response.writeHead(200, { 'Content-Type': 'image/png' }).end('invalid-png');
      const match = /^\/texture-([0-3])\.png$/.exec(request.url);
      const colors = [
        [240, 30, 25],
        [25, 220, 50],
        [25, 60, 240],
        [240, 210, 25],
      ];
      const body = png(match ? colors[Number(match[1])] : [25, 220, 50]);
      const send = () => response.writeHead(200, { 'Content-Type': 'image/png' }).end(body);
      if (request.url.startsWith('/slow-')) setTimeout(send, 350);
      else send();
    },
  );
  await listen(assets);
  const proxyAudit = [];
  const proxy = http.createServer((_request, response) => response.writeHead(403).end());
  proxy.on('connect', (request, client, head) => {
    proxyAudit.push(request.url);
    if (![`${assetHostname}:443`, `${cdnHostname}:443`].includes(request.url)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(assets.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    for (const socket of [client, upstream]) {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
  });
  await listen(proxy);
  return {
    audit,
    proxyAudit,
    proxyPort: proxy.address().port,
    fingerprint: new X509Certificate(certificate).fingerprint256,
    setScenario(value) {
      scenario = value;
    },
    close() {
      for (const socket of connections) socket.destroy();
      proxy.close();
      assets.close();
    },
  };
}

async function waitFor(window) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const messages = await window.webContents.executeJavaScript('window.__probeMessages ?? []');
    const failure = messages.find(
      item => item.type === 'widget-image-probe' && item.phase === 'failed',
    );
    if (failure) throw new Error(failure.error);
    const ready = messages.find(
      item => item.type === 'widget-image-probe' && item.phase === 'ready',
    );
    if (ready) return ready;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Image verification timed out');
}

async function main() {
  const { app, BrowserWindow, session } = require('electron');
  fs.mkdirSync(outputRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(outputRoot, 'fixture-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const kindPath = path.join(fixture, 'content-kind.cjs');
  require('esbuild').buildSync({
    entryPoints: [path.join(repoRoot, 'plugins/extensions/smart-canvas/document/content-kind.ts')],
    outfile: kindPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const kind = require(kindPath).htmlPageContentKind;
  assert.equal(kind.kind, 'html-page');
  assert.deepEqual(kind.resources.paths, [imageAdapterPath]);
  const [{ n: buildSandboxHostDocument }, { t: buildWidgetDocument }, { t: cdnOrigins }] =
    await Promise.all([
      import(pathToFileURL(path.join(runtimeRoot, 'sandbox-host-C4L4QQ2a.mjs')).href),
      import(pathToFileURL(path.join(runtimeRoot, 'wrap-D-D-PZV6.mjs')).href),
      import(pathToFileURL(path.join(runtimeRoot, 'widget-html-DuR2hZeB.mjs')).href),
    ]);
  const archiveIndex = process.argv.indexOf('--three-archive');
  const { modules, version } = readThreeModules(
    repoRoot,
    archiveIndex < 0 ? undefined : process.argv[archiveIndex + 1],
  );
  const assets = await createAssets(fixture, modules);
  const fixtureWindows = new Set();
  const certificateError = (event, contents, url, _error, certificate, callback) => {
    let permitted = false;
    try {
      permitted =
        fixtureWindows.has(contents.id) &&
        [assetOrigin, `https://${cdnHostname}`].includes(new URL(url).origin) &&
        new X509Certificate(certificate.data).fingerprint256 === assets.fingerprint;
    } catch {
      /* A malformed or unrelated certificate remains rejected. */
    }
    // Concurrent TLS verification may also arrive through this Electron event.
    // Trust stays scoped to this test window, two exact origins and one key.
    if (permitted) event.preventDefault();
    callback(permitted);
  };
  app.on('certificate-error', certificateError);
  const failures = [];
  const blocked = [];
  const networkEvents = [];
  const certificateEvents = [];
  const resourceRequests = [];
  let scenario;
  let sandboxOrigin;
  let sandboxDocument;
  const sandboxServer = http.createServer(async (request, response) => {
    try {
      if (request.url === '/sandbox')
        return response.writeHead(200, sandboxDocument.headers).end(sandboxDocument.html);
      assert.equal(request.url, imageAdapterPath, 'Unexpected local widget resource');
      const resource = await kind.resources.readPublicResource(imageAdapterPath);
      assert(resource, 'Image adapter resource missing');
      resourceRequests.push({ scenario: scenario.name, path: imageAdapterPath });
      response.writeHead(200, {
        'Content-Type': resource.contentType,
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      response.end(Buffer.from(resource.body));
    } catch (error) {
      failures.push(error.message);
      response.writeHead(500).end();
    }
  });
  sandboxOrigin = await listen(sandboxServer);
  const resourceUrls = { [imageAdapterPath]: imageAdapterPath };
  const hostServer = http.createServer((request, response) => {
    if (request.url === '/view') {
      const options = {
        origin: assetOrigin,
        granted: scenario.granted,
        threeRevision: version.split('.')[1],
      };
      const moduleBase = `https://${cdnHostname}/npm/three@${version}`;
      const imports = JSON.stringify({
        imports: {
          three: `${moduleBase}/build/three.module.js`,
          'three/addons/': `${moduleBase}/examples/jsm/`,
        },
      });
      const firstAuthor = `<script>globalThis.__imageAdapterBeforeAuthor=Object.prototype.hasOwnProperty.call(HTMLImageElement.prototype,Symbol.for('smart-canvas.image-loading'));</script>`;
      const styles = '<style>body{padding:12px}img{width:40px;height:40px}</style>';
      const content = `<h1>Image loading verification</h1><div id="display"></div>${scenario.granted ? `<img id="static-image" src="${assetOrigin}/static.png">` : ''}`;
      const script = `<script type="importmap">${imports}</script><script type="module">import * as THREE from 'three';import { OrbitControls } from 'three/addons/controls/OrbitControls.js';void (${probeImages.toString()})(${JSON.stringify(options)},THREE,OrbitControls);</script>`;
      const source = scenario.document
        ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Image probe</title>${firstAuthor}${styles}</head><body>${content}${script}</body></html>`
        : `${firstAuthor}${styles}${content}${script}`;
      kind.validateSource(source);
      const body = kind.composeDocument({
        source,
        title: scenario.name,
        resourceUrls,
        promptGranted: false,
      });
      const wrapped = buildWidgetDocument(scenario.name, body, {
        scriptOrigins: ["'self'"],
        connectOrigins: scenario.granted ? [assetOrigin] : [],
      });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ html: wrapped, renderId: scenario.name }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      `<!doctype html><html><body><script>window.__probeMessages=[];const frame=document.createElement('iframe');frame.style.cssText='border:0;width:100%;height:650px';frame.src=${JSON.stringify(sandboxOrigin + '/sandbox')};addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.origin!==${JSON.stringify(sandboxOrigin)})return;window.__probeMessages.push(event.data);if(event.data?.method==='ui/notifications/sandbox-proxy-ready'){const view=await(await fetch('/view')).json();frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-resource-ready',params:{...view,allowScripts:true}},${JSON.stringify(sandboxOrigin)});}});document.body.append(frame);</script></body></html>`,
    );
  });
  const hostOrigin = await listen(hostServer);
  const results = [];
  let certificates = 0;
  try {
    for (const test of scenarios) {
      scenario = test;
      assets.setScenario(test.name);
      sandboxDocument = buildSandboxHostDocument({
        blockDescendantFrames: true,
        resourceDomains: [...cdnOrigins],
        connectDomains: test.granted ? [assetOrigin] : [],
      });
      const isolated = session.fromPartition(`widget-image-${process.pid}-${test.name}`, {
        cache: false,
      });
      await isolated.setProxy({
        mode: 'fixed_servers',
        proxyRules: `http=127.0.0.1:${assets.proxyPort};https=127.0.0.1:${assets.proxyPort}`,
        proxyBypassRules: '<local>',
      });
      isolated.setCertificateVerifyProc((request, callback) => {
        let fingerprint;
        try {
          fingerprint = new X509Certificate(request.certificate.data).fingerprint256;
        } catch {
          /* Reject other certificates. */
        }
        certificateEvents.push({
          scenario: test.name,
          host: request.hostname,
          fingerprint,
          expectedFingerprint: assets.fingerprint,
          result: request.verificationResult,
        });
        if (
          [assetHostname, cdnHostname].includes(request.hostname) &&
          fingerprint === assets.fingerprint
        ) {
          certificates++;
          callback(0);
        } else callback(-3);
      });
      isolated.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        const allowed =
          [hostOrigin, sandboxOrigin, assetOrigin, `https://${cdnHostname}`].includes(url.origin) ||
          ['data:', 'about:'].includes(url.protocol);
        if (!allowed) blocked.push(details.url);
        callback({ cancel: !allowed });
      });
      isolated.webRequest.onErrorOccurred(details => {
        networkEvents.push({ scenario: test.name, url: details.url, error: details.error });
      });
      const window = new BrowserWindow({
        show: false,
        width: 850,
        height: 700,
        webPreferences: {
          session: isolated,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      fixtureWindows.add(window.webContents.id);
      try {
        await window.loadURL(hostOrigin);
        const ready = await waitFor(window);
        const messages = await window.webContents.executeJavaScript('window.__probeMessages');
        assert.equal(
          messages.filter(message => message.type === 'openclaw:widget-runtime-error').length,
          0,
          JSON.stringify(messages),
        );
        assert.equal(resourceRequests.filter(request => request.scenario === test.name).length, 1);
        results.push({
          name: test.name,
          source: test.document ? 'complete-html' : 'html-fragment',
          connectOrigins: test.granted ? [assetOrigin] : [],
          ...ready.result,
        });
        if (test.granted)
          fs.writeFileSync(
            path.join(outputRoot, `${test.name}.png`),
            (await window.webContents.capturePage()).toPNG(),
          );
      } catch (error) {
        fs.writeFileSync(
          path.join(outputRoot, 'failed-scenario.json'),
          JSON.stringify(
            {
              scenario: test.name,
              error: error.stack ?? String(error),
              messages: await window.webContents.executeJavaScript('window.__probeMessages'),
              requests: assets.audit,
              proxyTargets: assets.proxyAudit,
              networkEvents,
              certificateEvents,
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        fixtureWindows.delete(window.webContents.id);
        window.destroy();
      }
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(blocked, []);
    assert(certificates > 0);
    assert(
      assets.proxyAudit.every(target =>
        [`${assetHostname}:443`, `${cdnHostname}:443`].includes(target),
      ),
    );
    assert(assets.proxyAudit.includes(`${assetHostname}:443`));
    assert(assets.proxyAudit.includes(`${cdnHostname}:443`));
    assert(
      assets.audit.every(
        request => request.method === 'GET' && !request.cookie && !request.authorization,
      ),
    );
    assert(
      !assets.audit.some(request =>
        ['ungranted.png', 'native-srcset.png'].some(file => request.path.includes(file)),
      ),
    );
    for (const test of scenarios)
      assert.deepEqual(
        assets.audit
          .filter(request => request.scenario === test.name && request.host === cdnHostname)
          .map(request => request.path)
          .sort(),
        [...modules.keys()].sort(),
      );
    assert(
      assets.audit
        .filter(request => request.host === assetHostname)
        .every(request => request.origin === 'null'),
    );
    for (const { name } of scenarios.filter(test => test.granted)) {
      assert.equal(
        assets.audit.filter(
          request => request.scenario === name && /^\/texture-[0-3]\.png$/.test(request.path),
        ).length,
        4,
      );
    }
    const report = {
      success: true,
      scope: 'bare locked SDK wrappers plus candidate plugin; not frozen Gateway/Main integration',
      runtimeDist: runtimeRoot,
      nativePackageVersion: JSON.parse(
        fs.readFileSync(path.join(runtimeRoot, '../package.json'), 'utf8'),
      ).version,
      electron: process.versions.electron,
      threeVersion: version,
      threeFixture: {
        integrity: THREE_FIXTURE.integrity,
        source: 'verified test-only archive served as CDN ESM',
        packaged: false,
      },
      policies: {
        nativeOuterHttpCsp: true,
        nativeInnerMetaCsp: true,
        opaqueInnerIframe: true,
        extraConnectOrigins: false,
      },
      network: {
        controlledLoopbackConnectProxy: true,
        exactCertificateFingerprintOnly: true,
        publicRequests: 0,
      },
      results,
      adapterRequests: resourceRequests,
      requests: assets.audit,
      proxyTargets: assets.proxyAudit,
    };
    fs.writeFileSync(path.join(outputRoot, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ success: true, scenarios: results.length, output: outputRoot }));
  } finally {
    app.removeListener('certificate-error', certificateError);
    assets.close();
    hostServer.close();
    sandboxServer.close();
  }
  app.quit();
}
