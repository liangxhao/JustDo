'use strict';

// Run with Node. The child uses an isolated, hidden Electron session and the
// locked native wrappers; this never starts Gateway or reads user sessions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '../../../..');
const outputRoot = path.join(repoRoot, 'build/widget-kit/browser-verification');
const runtimeIndex = process.argv.indexOf('--runtime');
const runtimeRoot = path.resolve(
  runtimeIndex < 0
    ? path.join(repoRoot, 'vendor/openclaw-runtime/current/dist')
    : process.argv[runtimeIndex + 1],
);

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

/** Actual authored widget code, serialized into the opaque native inner frame. */
async function probeLibraries(selected) {
  const results = {};
  const require = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const section = id => {
    const element = document.createElement('section');
    element.id = id;
    element.style.cssText = 'min-width:0;height:220px;border:1px solid #ddd;padding:8px';
    document.getElementById('panels').append(element);
    return element;
  };
  const post = data => window.parent.postMessage({ type: 'widget-library-probe', ...data }, '*');
  let renderer;
  let camera;
  let scene;
  let chart;
  try {
    require(location.origin === 'null', 'inner frame must have an opaque origin');
    let parentBlocked = false;
    try {
      void window.parent.document;
    } catch {
      parentBlocked = true;
    }
    require(parentBlocked, 'inner frame can access its parent');
    require(typeof process === 'undefined', 'Node globals leaked into widget');
    let networkDenied = false;
    try {
      await fetch('https://offline-probe.invalid/never-load');
    } catch {
      networkDenied = true;
    }
    require(networkDenied, 'native connect CSP did not deny fetch');
    results.sandbox = { opaqueOrigin: true, parentBlocked, networkDenied };

    if (selected.includes('three')) {
      const element = section('three');
      renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
      renderer.setSize(element.clientWidth - 16, 190);
      renderer.setClearColor(0x203050);
      element.append(renderer.domElement);
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(50, renderer.domElement.width / 190, 0.1, 100);
      camera.position.set(2, 2, 4);
      const cube = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial());
      cube.rotation.y = 0.6;
      scene.add(cube);
      const controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.target.set(0.1, 0, 0);
      controls.update();
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      const pixel = new Uint8Array(4);
      gl.readPixels(renderer.domElement.width >> 1, 95, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      require(renderer.info.render.triangles > 0, 'Three did not draw triangles');
      require(pixel.some(value => value > 0), 'WebGL produced an empty frame');
      results.three = {
        webgl: gl.getParameter(gl.VERSION),
        triangles: renderer.info.render.triangles,
        orbitControls: controls.target.x === 0.1,
        pixel: Array.from(pixel),
      };
    }
    if (selected.includes('echarts')) {
      const element = section('echarts');
      chart = echarts.init(element, undefined, { renderer: 'svg' });
      chart.setOption({
        animation: false,
        xAxis: { type: 'category', data: ['A', 'B', 'C'] },
        yAxis: { type: 'value' },
        series: [{ type: 'bar', data: [4, 8, 6] }],
      });
      require(element.querySelectorAll('svg path').length > 3, 'ECharts did not draw SVG');
      results.echarts = { svgPaths: element.querySelectorAll('svg path').length };
    }
    if (selected.includes('katex')) {
      const element = section('katex');
      await katexFontsReady;
      katex.render('f(x)=\\int_0^x t^2\\,dt=\\frac{x^3}{3}', element, { throwOnError: true });
      const fonts = Array.from(document.fonts);
      require(fonts.length === 20, 'KaTeX must install all 20 bundled font faces');
      require(fonts.every(font => font.status === 'loaded'), 'KaTeX fonts are not loaded');
      require(element.querySelector('.katex-html'), 'KaTeX did not render formula');
      results.katex = { loadedFonts: fonts.length, formula: !!element.querySelector('math') };
    }
    if (selected.includes('mermaid')) {
      const element = section('mermaid');
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      const result = await mermaid.render(
        'offline-diagram',
        'flowchart LR\n A[Offline] --> B[Ready]',
      );
      element.innerHTML = result.svg;
      require(element.querySelectorAll('svg .node').length === 2, 'Mermaid did not render nodes');
      results.mermaid = { nodes: element.querySelectorAll('svg .node').length };
    }
    if (selected.includes('d3')) {
      const element = section('d3');
      const tree = d3.tree().size([160, 180]);
      const root = tree(d3.hierarchy({ name: 'Root', children: [{ name: 'A' }, { name: 'B' }] }));
      const svg = d3.select(element).append('svg').attr('viewBox', '0 0 220 190');
      svg
        .selectAll('path')
        .data(root.links())
        .join('path')
        .attr(
          'd',
          d3
            .linkHorizontal()
            .x(node => node.y + 10)
            .y(node => node.x + 10),
        )
        .attr('stroke', '#2864b4')
        .attr('fill', 'none');
      svg
        .selectAll('circle')
        .data(root.descendants())
        .join('circle')
        .attr('cx', node => node.y + 10)
        .attr('cy', node => node.x + 10)
        .attr('r', 6)
        .attr('fill', '#2864b4');
      require(element.querySelectorAll('circle').length === 3, 'D3 did not draw tree');
      require(root.children[0].x !== root.children[1].x, 'D3 layout did not separate nodes');
      const csvRows = d3.csvParseRows('name,value\nOffline,2');
      require(csvRows[1][1] === '2', 'D3 CSP-compatible CSV parser did not parse rows');
      results.d3 = {
        nodes: root.descendants().length,
        links: root.links().length,
        csvRows: csvRows.length,
      };
    }
    if (selected.includes('matter')) {
      const element = section('matter');
      const engine = Matter.Engine.create();
      const display = Matter.Render.create({
        element,
        engine,
        options: { width: 220, height: 190, wireframes: false, background: '#f6f7fa' },
      });
      const box = Matter.Bodies.rectangle(100, 20, 25, 25);
      Matter.Composite.add(engine.world, [
        box,
        Matter.Bodies.rectangle(100, 180, 200, 20, { isStatic: true }),
      ]);
      const before = box.position.y;
      for (let step = 0; step < 45; step++) Matter.Engine.update(engine, 1000 / 60);
      Matter.Render.world(display);
      require(box.position.y > before + 50, 'Matter physics did not advance');
      require(element.querySelector('canvas'), 'Matter did not render canvas');
      results.matter = {
        initialY: before,
        settledY: box.position.y,
        timestamp: engine.timing.timestamp,
      };
    }
    const dimensions = () => ({
      width: innerWidth,
      threeWidth: renderer?.domElement.width,
      echartsWidth: chart?.getWidth(),
    });
    const resize = () => {
      if (renderer) {
        const width = document.getElementById('three').clientWidth - 16;
        renderer.setSize(width, 190);
        camera.aspect = width / 190;
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
      }
      chart?.resize();
    };
    new ResizeObserver(resize).observe(document.getElementById('panels'));
    window.addEventListener('message', event => {
      if (event.data?.type === 'widget-probe-resize') {
        resize();
        post({ phase: 'resized', dimensions: dimensions() });
      }
    });
    post({ phase: 'ready', selected, results, dimensions: dimensions() });
  } catch (error) {
    post({ phase: 'failed', error: error.stack ?? error.message, results });
  }
}

function fragment(selected) {
  return (
    '<style>body{padding:12px;background:#fafafa;color:#222}#panels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}h1{font:18px sans-serif;margin-bottom:10px;color:#222}</style>' +
    '<h1>Offline widget library verification</h1><main id="panels"></main>' +
    `<script>(${probeLibraries.toString()})(${JSON.stringify(selected)});</script>`
  );
}

function listen(server) {
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)),
  );
}

async function waitFor(window, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const messages = await window.webContents.executeJavaScript('window.__probeMessages ?? []');
    const failed = messages.find(
      message => message.type === 'widget-library-probe' && message.phase === 'failed',
    );
    if (failed) throw new Error(failed.error);
    const result = predicate(messages);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(
    `Widget verification timed out: ${JSON.stringify(await window.webContents.executeJavaScript('window.__probeMessages ?? []'))}`,
  );
}

async function main() {
  const { app, BrowserWindow, session } = require('electron');
  fs.mkdirSync(outputRoot, { recursive: true });
  app.setPath('userData', path.join(outputRoot, `profile-${process.pid}`));
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('no-proxy-server');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const kindPath = path.join(outputRoot, 'content-kind.cjs');
  require('esbuild').buildSync({
    entryPoints: [path.join(repoRoot, 'plugins/extensions/widget-kit/libraries/content-kind.ts')],
    outfile: kindPath,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    logLevel: 'silent',
  });
  const { createOfflineHtmlContentKind } = require(kindPath);
  const kind = createOfflineHtmlContentKind(
    pathToFileURL(path.join(repoRoot, 'plugins/extensions/widget-kit/assets/')),
  );
  const [{ n: buildSandboxHostDocument }, { t: buildWidgetDocument }, { t: cdnOrigins }] =
    await Promise.all([
      import(pathToFileURL(path.join(runtimeRoot, 'sandbox-host-BRz3YO81.mjs')).href),
      import(pathToFileURL(path.join(runtimeRoot, 'wrap-IO-k8BF1.mjs')).href),
      import(pathToFileURL(path.join(runtimeRoot, 'widget-html-DuR2hZeB.mjs')).href),
    ]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins/extensions/widget-kit/libraries/upstreams.json')),
  );
  const ids = manifest.libraries.map(library => library.id);
  const requests = [];
  const blockedRequests = [];
  const serverFailures = [];
  const unexpectedResourceRequests = [];
  let scenario;
  let sandboxDocument;
  let sandboxOrigin;
  const sandboxServer = http.createServer(async (request, response) => {
    try {
      if (request.url === '/sandbox') {
        response.writeHead(200, sandboxDocument.headers).end(sandboxDocument.html);
        return;
      }
      const url = new URL(request.url, sandboxOrigin);
      const library = manifest.libraries.find(item => item.resourcePath === url.pathname);
      if (!library) {
        unexpectedResourceRequests.push(url.pathname);
        response.writeHead(404).end();
        return;
      }
      requests.push({ scenario: scenario.name, id: library.id, path: url.pathname });
      assert.equal(request.headers.cookie, undefined, 'public resource request included cookies');
      assert.equal(
        request.headers.authorization,
        undefined,
        'public resource request included authorization',
      );
      if (scenario.failure === '404') {
        response.writeHead(404, { 'Content-Type': 'text/javascript' }).end();
        return;
      }
      const resource = await kind.resources.readPublicResource(url.pathname);
      assert(resource);
      response.writeHead(200, {
        'Content-Type': resource.contentType,
        'Cache-Control': 'no-store',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      response.end(scenario.failure === 'empty' ? '' : Buffer.from(resource.body));
    } catch (error) {
      serverFailures.push(error.message);
      response.writeHead(500).end(error.message);
    }
  });
  sandboxOrigin = await listen(sandboxServer);
  sandboxDocument = buildSandboxHostDocument({
    blockDescendantFrames: true,
    resourceDomains: [...cdnOrigins],
  });
  const resourceUrls = Object.fromEntries(
    kind.resources.paths.map(resourcePath => [resourcePath, resourcePath]),
  );
  const hostServer = http.createServer((request, response) => {
    if (request.url === '/view') {
      // Fixture admission replaces the authenticated view store; the native
      // composition, resource reader and both sandbox policies stay unchanged.
      const source = JSON.stringify({
        version: 1,
        libraries: scenario.selected,
        html: scenario.failure ? '<p>Library failure fixture</p>' : fragment(scenario.selected),
      });
      kind.validateSource(source);
      const body = kind.composeDocument({
        source,
        title: scenario.name,
        resourceUrls,
        promptGranted: false,
      });
      const html = buildWidgetDocument(scenario.name, body, { scriptOrigins: ["'self'"] });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ html, renderId: scenario.name }));
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(`<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#fafafa}iframe{height:100%;width:100%;border:0}</style></head><body><script>
      window.__probeMessages=[];
      const frame=document.createElement('iframe');
      frame.src=${JSON.stringify(sandboxOrigin + '/sandbox')};
      addEventListener('message',async event=>{
        if(event.source!==frame.contentWindow||event.origin!==${JSON.stringify(sandboxOrigin)})return;
        window.__probeMessages.push(event.data);
        if(event.data?.method==='ui/notifications/sandbox-proxy-ready'){
          const view=await (await fetch('/view')).json();
          frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-resource-ready',params:{...view,allowScripts:true}},${JSON.stringify(sandboxOrigin)});
        }
      });
      document.body.append(frame);
      </script></body></html>`);
  });
  const hostOrigin = await listen(hostServer);
  const results = [];
  try {
    for (const test of [
      ...ids.map(id => ({ name: id, selected: [id] })),
      { name: 'combined', selected: ids },
      { name: 'missing-resource', selected: ['three'], failure: '404' },
      { name: 'empty-resource', selected: ['three'], failure: 'empty' },
    ]) {
      scenario = test;
      const isolatedSession = session.fromPartition(`widget-probe-${process.pid}-${test.name}`);
      await isolatedSession.clearCache();
      await isolatedSession.clearStorageData();
      isolatedSession.webRequest.onBeforeRequest((details, callback) => {
        const allowed =
          [hostOrigin, sandboxOrigin].some(origin => details.url.startsWith(origin + '/')) ||
          /^(?:about|data):/.test(details.url);
        if (!allowed) blockedRequests.push({ scenario: test.name, url: details.url });
        callback({ cancel: !allowed });
      });
      const window = new BrowserWindow({
        show: false,
        width: 1000,
        height: 850,
        webPreferences: {
          session: isolatedSession,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      try {
        await window.loadURL(hostOrigin + '/');
        if (test.failure) {
          const error = await waitFor(window, messages =>
            messages.find(message => message.type === 'openclaw:widget-runtime-error'),
          );
          assert.equal(error.message, 'Offline widget library initialization failed');
          results.push({ name: test.name, nativeRuntimeError: error.message });
        } else {
          const ready = await waitFor(window, messages =>
            messages.find(
              message => message.type === 'widget-library-probe' && message.phase === 'ready',
            ),
          );
          const messages = await window.webContents.executeJavaScript('window.__probeMessages');
          assert.equal(
            messages.filter(message => message.type === 'openclaw:widget-runtime-error').length,
            0,
            JSON.stringify(messages),
          );
          assert.deepEqual(ready.selected, test.selected);
          if (test.name === 'combined') {
            window.setContentSize(700, 850);
            await window.webContents.executeJavaScript(
              'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
            );
            await window.webContents.executeJavaScript(
              `document.querySelector('iframe').contentWindow.postMessage({type:'widget-probe-resize'},${JSON.stringify(sandboxOrigin)})`,
            );
            const resized = await waitFor(window, messages =>
              messages.find(
                message => message.type === 'widget-library-probe' && message.phase === 'resized',
              ),
            );
            assert(
              resized.dimensions.width < ready.dimensions.width,
              'native inner container did not resize',
            );
            assert(
              resized.dimensions.threeWidth < ready.dimensions.threeWidth,
              'Three canvas did not resize',
            );
            assert(
              resized.dimensions.echartsWidth < ready.dimensions.echartsWidth,
              'ECharts did not resize',
            );
            ready.resizedDimensions = resized.dimensions;
            await new Promise(resolve => setTimeout(resolve, 100));
            fs.writeFileSync(
              path.join(outputRoot, 'combined.png'),
              (await window.webContents.capturePage()).toPNG(),
            );
          }
          results.push({
            name: test.name,
            ...ready.results,
            dimensions: ready.dimensions,
            resizedDimensions: ready.resizedDimensions,
          });
        }
        const loadedIds = requests
          .filter(request => request.scenario === test.name)
          .map(request => request.id);
        assert.deepEqual(
          loadedIds,
          test.selected,
          'widget loaded an unselected library or missed a selected resource',
        );
        results[results.length - 1].requestedLibraries = loadedIds;
      } finally {
        window.destroy();
      }
    }
    assert.equal(blockedRequests.length, 0, 'widget attempted a non-loopback resource request');
    assert.deepEqual(serverFailures, [], 'public resource reader or request failed');
    assert.deepEqual(unexpectedResourceRequests, [], 'widget requested an unbundled resource');
    const report = {
      success: true,
      nativeRuntime: require(path.join(repoRoot, 'package.json')).openclaw.version,
      electron: process.versions.electron,
      emptyIsolatedSessions: true,
      network: {
        allowed: 'loopback only',
        nonLoopbackRequests: blockedRequests.length,
        connectCspDenied: true,
      },
      policies: {
        nativeOuterHttpCsp: true,
        nativeInnerMetaCsp: true,
        opaqueInnerIframe: true,
        relativeResourcePaths: true,
        nativeInlineSelfAdmission: true,
      },
      results,
    };
    fs.writeFileSync(path.join(outputRoot, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ success: true, scenarios: results.length, output: outputRoot }));
  } finally {
    hostServer.close();
    sandboxServer.close();
  }
  app.quit();
}
