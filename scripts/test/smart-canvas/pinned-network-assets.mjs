import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';

import threeFixture from '../../../plugins/extensions/smart-canvas/tests/three-fixture.cjs';

const { THREE_FIXTURE, readThreeModules } = threeFixture;
const hostname = 'assets.widget-fixture.example';
const cdnHostname = 'cdn.jsdelivr.net';
export const PINNED_ASSET_ORIGIN = `https://${hostname}`;

function png(color) {
  const chunk = (name, bytes) => {
    const data = Buffer.concat([Buffer.from(name), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, data, checksum]);
  };
  const size = Buffer.alloc(13);
  size.writeUInt32BE(2);
  size.writeUInt32BE(2, 4);
  size[8] = 8;
  size[9] = 6;
  const row = Buffer.from([0, ...color, 255, ...color, 255]);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', size),
    chunk('IDAT', deflateSync(Buffer.concat([row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Serialized as authored code, running without Electron/Node privileges. */
export async function probePinnedTextures(origin, THREE, OrbitControls) {
  const require = (condition, reason) => {
    if (!condition) throw new Error(reason);
  };
  const dataUrl = blob =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  let renderer;
  try {
    require(location.origin === 'null', 'Native inner origin must be opaque');
    require(typeof process === 'undefined' &&
      typeof widgetViewer === 'undefined', 'Preload leaked into author');
    let blockedParent = false;
    try {
      void parent.document;
    } catch {
      blockedParent = true;
    }
    require(blockedParent, 'Native sandbox isolation missing');
    const textures = [];
    for (let index = 0; index < 4; index++) {
      const response = await fetch(`${origin}/texture-${index}.png`, {
        credentials: index === 0 ? 'include' : 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      require(response.ok &&
        response.headers.get('content-type') === 'image/png', 'HTTPS texture failed');
      const url = await dataUrl(await response.blob());
      require(url.startsWith('data:image/png;'), 'Image must enter native img-src via data URL');
      const texture = await new Promise((resolve, reject) =>
        new THREE.TextureLoader().load(url, resolve, undefined, reject),
      );
      require(texture.image.width === 2 && texture.image.height === 2, 'Texture decode failed');
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.push(texture);
    }
    renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: false });
    renderer.setSize(400, 260);
    renderer.setClearColor(0x071224);
    document.body.append(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 400 / 260, 0.1, 100);
    camera.position.z = 5;
    for (let index = 0; index < 4; index++) {
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
    require(renderer.info.render.triangles === 48, 'Three must draw four textured cubes');
    const gl = renderer.getContext();
    const pixel = new Uint8Array(4);
    gl.readPixels(165, 160, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    require(pixel[0] > pixel[2], 'Red texture must reach WebGL output');
    const head = await fetch(`${origin}/head`, { method: 'HEAD', credentials: 'omit' });
    require(head.ok, 'Business HEAD should be supported');
    let uploadBlocked = false;
    try {
      await fetch(`${origin}/upload`, {
        method: 'POST',
        body: 'synthetic-body',
        credentials: 'omit',
      });
    } catch {
      uploadBlocked = true;
    }
    require(uploadBlocked, 'Main must block POST even when native connect permits the origin');
    let authBlocked = false;
    try {
      await fetch(`${origin}/authorization`, {
        headers: { Authorization: 'synthetic-never-leave' },
      });
    } catch {
      authBlocked = true;
    }
    require(authBlocked, 'Authorization preflight must not reach an origin');
    const publicScriptExecuted = await new Promise(resolve => {
      const script = document.createElement('script');
      script.onload = () => resolve(globalThis.widgetFixtureCdnExecutions === 1);
      script.onerror = () => resolve(false);
      // Native CDN script policy is independent of declared connect origins.
      script.src = 'https://cdn.jsdelivr.net/widget-fixture.js';
      document.head.append(script);
    });
    require(publicScriptExecuted, 'Native CDN script must load and execute without a connect grant');
    const publicModuleExecuted = await new Promise(resolve => {
      const script = document.createElement('script');
      script.type = 'module';
      script.onload = () => resolve(globalThis.widgetFixtureModuleValue === 'native-module-7');
      script.onerror = () => resolve(false);
      script.src = 'https://cdn.jsdelivr.net/widget-module.js';
      document.head.append(script);
    });
    require(publicModuleExecuted, 'Native CDN ESM and its static import must execute');
    const styleProbe = document.createElement('span');
    styleProbe.id = 'widget-cdn-style-probe';
    styleProbe.textContent = 'MathABC123';
    document.body.append(styleProbe);
    const publicStylesheetLoaded = await new Promise(resolve => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/widget-fixture.css';
      link.onload = () => resolve(getComputedStyle(styleProbe).color === 'rgb(13, 91, 207)');
      link.onerror = () => resolve(false);
      document.head.append(link);
    });
    require(publicStylesheetLoaded, 'Native CDN stylesheet must apply without a connect grant');
    const loadedFonts = await document.fonts.load('20px WidgetFixtureCDN', 'MathABC123');
    const publicFontLoaded = loadedFonts.some(
      font => font.family === 'WidgetFixtureCDN' && font.status === 'loaded',
    );
    require(publicFontLoaded &&
      styleProbe.getBoundingClientRect().width > 0, 'Native CDN font must decode and render');
    const nativeScriptBlocked = await new Promise(resolve => {
      const script = document.createElement('script');
      script.onload = () => resolve(false);
      script.onerror = () => resolve(true);
      script.src = `${origin}/native-blocked.js`;
      document.head.append(script);
    });
    require(nativeScriptBlocked, 'A connect grant must not widen native script-src');
    const nativeStylesheetBlocked = await new Promise(resolve => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.onload = () => resolve(false);
      link.onerror = () => resolve(true);
      link.href = `${origin}/native-blocked.css`;
      document.head.append(link);
    });
    require(nativeStylesheetBlocked, 'A connect grant must not widen native style-src');
    let nativeFontBlocked = false;
    try {
      await new FontFace('NativeBlockedFont', `url(${origin}/native-blocked.woff2)`).load();
    } catch {
      nativeFontBlocked = true;
    }
    require(nativeFontBlocked, 'A connect grant must not widen native font-src');
    let ungrantedFetchBlocked = false;
    try {
      await fetch('https://cdn.jsdelivr.net/widget-fixture-fetch', { credentials: 'omit' });
    } catch {
      ungrantedFetchBlocked = true;
    }
    require(ungrantedFetchBlocked, 'Native CDN resource access must not grant fetch access');
    const nativeRedirectBlocked = await new Promise(resolve => {
      const script = document.createElement('script');
      script.onload = () => resolve(false);
      script.onerror = () => resolve(true);
      script.src = 'https://cdn.jsdelivr.net/widget-redirect.js';
      document.head.append(script);
    });
    require(nativeRedirectBlocked, 'Native CSP must independently check a resource redirect target');
    const directImageBlocked = await new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve(false);
      image.onerror = () => resolve(true);
      image.srcset = `${origin}/direct-image.png 1x`;
    });
    require(directImageBlocked, 'Native img-src still applies to srcset outside the adapter');
    require((await openclaw.prompt.send('programmatic-fixture')) ===
      false, 'Programmatic prompt must lack activation');
    globalThis.pinnedNetworkProbe = {
      done: true,
      opaqueOrigin: true,
      parentBlocked: true,
      noPreload: true,
      decodedTextures: textures.length,
      triangles: renderer.info.render.triangles,
      pixel: Array.from(pixel),
      uploadBlocked,
      authBlocked,
      publicScriptExecuted,
      publicModuleExecuted,
      publicStylesheetLoaded,
      publicFontLoaded,
      nativeScriptBlocked,
      nativeStylesheetBlocked,
      nativeFontBlocked,
      ungrantedFetchBlocked,
      nativeRedirectBlocked,
      directImageBlocked,
    };
  } catch (error) {
    globalThis.pinnedNetworkProbe = { done: true, error: String(error.message ?? error) };
  }
}

export async function startPinnedAssetFixture(directory) {
  const { modules } = readThreeModules();
  const key = path.join(directory, 'asset-key.pem');
  const certificate = path.join(directory, 'asset-cert.pem');
  const config = path.join(directory, 'openssl.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\n[dn]\n');
  const openssl = process.env.WIDGET_FIXTURE_OPENSSL ?? 'openssl';
  await promisify(execFile)(
    openssl,
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
      `/CN=${hostname}`,
      '-addext',
      `subjectAltName=DNS:${hostname},DNS:${cdnHostname}`,
      '-keyout',
      key,
      '-out',
      certificate,
    ],
    { windowsHide: true },
  );
  const cert = await readFile(certificate, 'utf8');
  const font = await readFile(
    new URL('../../../node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2', import.meta.url),
  );
  const audit = [];
  const connections = new Set();
  const colors = [
    [240, 30, 25],
    [25, 220, 50],
    [25, 60, 240],
    [240, 210, 25],
  ];
  const assets = https.createServer({ key: await readFile(key), cert }, (request, response) => {
    audit.push({
      method: request.method,
      path: request.url,
      host: request.headers.host,
      cookie: !!request.headers.cookie,
      authorization: !!request.headers.authorization,
      origin: request.headers.origin,
    });
    response.setHeader('Access-Control-Allow-Origin', 'null');
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader(
      'Set-Cookie',
      'asset-cookie=must-not-persist; Secure; SameSite=None; Path=/',
    );
    const match = /^\/texture-([0-3])\.png$/.exec(request.url);
    if (request.headers.host === cdnHostname && modules.has(request.url)) {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(modules.get(request.url));
    } else if (match) {
      response.setHeader('Content-Type', 'image/png');
      response.end(png(colors[Number(match[1])]));
    } else if (request.url === '/head' && request.method === 'HEAD') response.end();
    else if (request.headers.host === cdnHostname && request.url === '/widget-fixture.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(
        'globalThis.widgetFixtureCdnExecutions=(globalThis.widgetFixtureCdnExecutions||0)+1;',
      );
    } else if (request.headers.host === cdnHostname && request.url === '/widget-fixture.css') {
      response.setHeader('Content-Type', 'text/css; charset=utf-8');
      response.end(
        '@font-face{font-family:WidgetFixtureCDN;src:url("https://cdn.jsdelivr.net/widget-fixture.woff2") format("woff2")}#widget-cdn-style-probe{color:rgb(13,91,207);font-family:WidgetFixtureCDN;font-size:20px}',
      );
    } else if (request.headers.host === cdnHostname && request.url === '/widget-module.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(
        'import { mark } from "./widget-dependency.js"; globalThis.widgetFixtureModuleValue=mark(7);',
      );
    } else if (request.headers.host === cdnHostname && request.url === '/widget-dependency.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end('export function mark(value){return "native-module-"+value;}');
    } else if (request.headers.host === cdnHostname && request.url === '/widget-fixture.woff2') {
      response.setHeader('Content-Type', 'font/woff2');
      response.end(font);
    } else if (request.headers.host === cdnHostname && request.url === '/widget-redirect.js') {
      response.statusCode = 302;
      response.setHeader('Location', `${PINNED_ASSET_ORIGIN}/redirect-destination.js`);
      response.end();
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise(resolve => assets.listen(0, '127.0.0.1', resolve));
  const proxyAudit = [];
  const proxy = http.createServer((_request, response) => {
    response.statusCode = 403;
    response.end();
  });
  proxy.on('connect', (request, client, head) => {
    proxyAudit.push(request.url);
    if (![`${hostname}:443`, `${cdnHostname}:443`].includes(request.url)) {
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
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return {
    origin: PINNED_ASSET_ORIGIN,
    declaredOrigins: [PINNED_ASSET_ORIGIN],
    html: `<main>Synthetic pinned visualization: four HTTPS textures</main><script type="importmap">${JSON.stringify({ imports: { three: `https://${cdnHostname}/npm/three@${THREE_FIXTURE.version}/build/three.module.js` } })}</script><script type="module">import * as THREE from 'three';import { OrbitControls } from 'https://${cdnHostname}/npm/three@${THREE_FIXTURE.version}/examples/jsm/controls/OrbitControls.js';void (${probePinnedTextures.toString()})(${JSON.stringify(PINNED_ASSET_ORIGIN)}, THREE, OrbitControls);</script>`,
    browser: {
      assetOrigin: PINNED_ASSET_ORIGIN,
      certificateHosts: [hostname, cdnHostname],
      certificateFingerprint: new X509Certificate(cert).fingerprint256,
      proxyPort: proxy.address().port,
    },
    verifyAudit() {
      assert.equal(audit.filter(request => /^\/texture-[0-3]\.png$/.test(request.path)).length, 4);
      assert.ok(audit.some(request => request.method === 'HEAD' && request.path === '/head'));
      assert.ok(audit.every(request => ['GET', 'HEAD'].includes(request.method)));
      assert.ok(audit.every(request => !request.cookie && !request.authorization));
      assert.ok(
        audit
          .filter(request => request.host === hostname)
          .every(request => request.origin === 'null'),
      );
      for (const resource of [
        '/widget-fixture.js',
        '/widget-module.js',
        '/widget-dependency.js',
        '/widget-fixture.css',
        '/widget-fixture.woff2',
        '/widget-redirect.js',
      ])
        assert.equal(
          audit.filter(request => request.host === cdnHostname && request.path === resource).length,
          1,
        );
      assert.ok(
        !audit.some(request =>
          [
            '/upload',
            '/authorization',
            '/direct-image.png',
            '/native-blocked.js',
            '/native-blocked.css',
            '/native-blocked.woff2',
            '/widget-fixture-fetch',
            '/redirect-destination.js',
          ].includes(request.path),
        ),
      );
      assert.ok(
        proxyAudit.includes(`${hostname}:443`) && proxyAudit.includes(`${cdnHostname}:443`),
      );
      assert.ok(
        proxyAudit.every(target => [`${hostname}:443`, `${cdnHostname}:443`].includes(target)),
      );
      return {
        assetRequests: audit.length,
        proxyConnects: proxyAudit.length,
        noOriginCredentials: true,
        noUploads: true,
      };
    },
    async close() {
      for (const socket of connections) socket.destroy();
      assets.closeAllConnections();
      proxy.closeAllConnections();
      await Promise.all(
        [assets, proxy].map(server => new Promise(resolve => server.close(resolve))),
      );
    },
  };
}
