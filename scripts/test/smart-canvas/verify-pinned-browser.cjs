'use strict';

// Electron child of verify-pinned-network.mjs --browser. Real application guest,
// preload and renderer, native board HTML/sandbox, isolated CONNECT/TLS fixture.
const assert = require('node:assert/strict');
const { X509Certificate } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { build } = require('esbuild');

const inputPath = path.resolve(process.argv[2]);
const fixture = path.dirname(inputPath);
const root = path.resolve(__dirname, '../../..');
app.setPath('userData', path.join(fixture, 'electron-profile'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
let window;
let viewerServer;
let viteServer;
let guest;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Pinned browser fixture timeout: ${label}`);
}

app.whenReady().then(async () => {
  try {
    const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    const mainBundle = path.join(fixture, 'network-main.cjs');
    await build({
      stdin: {
        contents: [
          "export { createWidgetViewerGuests } from './src/main/core/window/widgetViewerGuest';",
          "export { applyBrowserProxyPreference } from './src/main/core/network/systemProxyPreference';",
          "export { buildApplicationContentSecurityPolicy } from './src/main/core/window/renderer/applicationContentSecurityPolicy';",
        ].join('\n'),
        resolveDir: root,
        loader: 'ts',
      },
      outfile: mainBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    });
    const main = require(mainBundle);
    const preload = path.join(fixture, 'widget-preload.cjs');
    await build({
      entryPoints: [path.join(root, 'src/main/widgetViewerPreload.ts')],
      outfile: preload,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    });
    let origin;
    let development;
    const developmentRequests = [];
    if (input.developmentViewer) {
      const { createServer } = await import('vite');
      const react = (await import('@vitejs/plugin-react')).default;
      viteServer = await createServer({
        configFile: false,
        root: path.join(root, 'src/renderer'),
        cacheDir: path.join(fixture, 'vite-cache'),
        resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
        plugins: [
          react(),
          {
            name: 'isolated-widget-network-host',
            configureServer(server) {
              server.middlewares.use((request, response, next) => {
                developmentRequests.push(request.url);
                if (request.url !== '/host.html') {
                  next();
                  return;
                }
                response.setHeader('Content-Type', 'text/html; charset=utf-8');
                response.end('<!doctype html><html><body style="margin:0"></body></html>');
              });
            },
          },
        ],
        server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [root] } },
        optimizeDeps: { noDiscovery: true },
      });
      await viteServer.listen();
      const port = viteServer.httpServer.address().port;
      origin = `http://127.0.0.1:${port}`;
      development = { isDev: true, devServerPort: port };
    } else {
      const renderer = await build({
        entryPoints: [
          path.join(root, 'src/renderer/libs/openclaw-chat/components/native-widget/viewer.ts'),
        ],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'iife',
        target: 'chrome148',
        tsconfig: path.join(root, 'tsconfig.json'),
      });
      const viewerHtml = (
        await fs.readFile(path.join(root, 'src/renderer/widget-viewer.html'), 'utf8')
      ).replace(
        /<script[^>]*src="[^"]+"[^>]*><\/script>/,
        '<script src="/assets/widget-viewer.js"></script>',
      );
      assert.ok(viewerHtml.includes('/assets/widget-viewer.js'));
      const applicationCsp = main.buildApplicationContentSecurityPolicy({
        isDev: false,
        devServerPort: 0,
      });
      viewerServer = http.createServer((request, response) => {
        response.setHeader('Content-Security-Policy', applicationCsp);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (request.url === '/assets/widget-viewer.js') {
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.end(renderer.outputFiles[0].contents);
        } else if (request.url?.startsWith('/widget-viewer.html?mount=')) {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(viewerHtml);
        } else if (request.url === '/host.html') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end('<!doctype html><html><body style="margin:0"></body></html>');
        } else {
          response.statusCode = 404;
          response.end();
        }
      });
      await new Promise(resolve => viewerServer.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${viewerServer.address().port}`;
    }
    const ownerPreload = path.join(fixture, 'owner-preload.cjs');
    await fs.writeFile(
      ownerPreload,
      `const {contextBridge,ipcRenderer}=require('electron');
      contextBridge.exposeInMainWorld('networkFixture',{
        beginCheck:value=>ipcRenderer.invoke('widget-network:begin-check',value),
        create:value=>ipcRenderer.invoke('widget-network:create',value),
        close:value=>ipcRenderer.invoke('widget-network:close',value)
      });`,
    );
    await main.applyBrowserProxyPreference({
      browserProxy: {
        mode: 'custom',
        custom: { protocol: 'http', host: '127.0.0.1', port: String(input.proxyPort) },
      },
    });
    window = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: true,
        backgroundThrottling: false,
        preload: ownerPreload,
      },
    });
    const manager = main.createWidgetViewerGuests(
      preload,
      () => null,
      development,
      window.webContents,
    );
    window.webContents.on('will-attach-webview', (event, preferences, params) => {
      if (!manager.prepare(event, preferences, params, window.webContents)) event.preventDefault();
    });
    window.webContents.on('did-attach-webview', (_event, attached) => {
      assert.ok(manager.attach(attached, window.webContents));
      guest = attached;
    });
    await window.loadURL(`${origin}/host.html`);
    const read = code => window.webContents.executeJavaScript(code);
    const nonce = await read(
      `networkFixture.beginCheck({mountId:${JSON.stringify(input.mountId)}})`,
    );
    const created = await read(
      `networkFixture.create(${JSON.stringify({
        mountId: input.mountId,
        nonce: nonce.nonce,
        binding: input.binding,
        gatewayOrigin: input.gatewayOrigin,
        sandboxUrl: input.sandboxUrl,
        resourceUrls: input.resourceUrls,
      })})`,
    );
    assert.ok(!created.partition.startsWith('persist:'));
    assert.notEqual(created.partition, 'native-widget-viewer');
    const networkSession = session.fromPartition(created.partition);
    let acceptedCertificate = 0;
    networkSession.setCertificateVerifyProc((request, callback) => {
      let fingerprint;
      try {
        fingerprint = new X509Certificate(request.certificate.data).fingerprint256;
      } catch {
        /* Reject unknown certificates. */
      }
      if (
        input.certificateHosts.includes(request.hostname) &&
        fingerprint === input.certificateFingerprint
      ) {
        acceptedCertificate++;
        callback(0);
      } else callback(-3);
    });
    await networkSession.cookies.set({
      url: input.assetOrigin,
      name: 'seeded-origin-cookie',
      value: 'synthetic-never-leave',
      secure: true,
      sameSite: 'no_restriction',
    });
    const initialize = {
      mountId: input.mountId,
      html: input.html,
      url: input.sandboxUrl,
      draftAllowed: false,
      theme: { mode: 'light', tokens: {} },
    };
    await read(`globalThis.viewerEvents=[];
      const view=document.createElement('webview');
      view.setAttribute('partition',${JSON.stringify(created.partition)});
      view.setAttribute('webpreferences','backgroundThrottling=no');
      view.style.cssText='display:block;width:850px;height:600px';
      view.addEventListener('ipc-message',event=>viewerEvents.push({channel:event.channel,args:event.args}));
      view.addEventListener('dom-ready',()=>view.send('widget-viewer:initialize',${JSON.stringify(initialize)}),{once:true});
      view.src=${JSON.stringify(`${origin}/widget-viewer.html?mount=${input.mountId}`)};
      document.body.append(view);`);
    await until(() => guest, 'production guest attach');
    const inner = await until(() => {
      const outer = guest.mainFrame.frames.find(frame => frame.url === input.sandboxUrl);
      return outer?.frames.find(frame => frame.url === 'about:srcdoc');
    }, 'native outer sandbox and opaque srcdoc');
    const result = await until(async () => {
      const value = await inner.executeJavaScript('globalThis.pinnedNetworkProbe');
      return value?.done ? value : undefined;
    }, 'actual texture download/render');
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.decodedTextures, 4);
    assert.ok(acceptedCertificate >= 1, 'Trust only the exact isolated asset certificate');
    const cookies = await networkSession.cookies.get({ url: input.assetOrigin });
    assert.ok(
      !cookies.some(cookie => cookie.name === 'asset-cookie'),
      'Origin Set-Cookie must be dropped',
    );
    assert.ok(cookies.some(cookie => cookie.name === 'seeded-origin-cookie'));
    assert.ok(
      !(await networkSession.cookies.get({ url: 'https://cdn.jsdelivr.net' })).some(
        cookie => cookie.name === 'asset-cookie',
      ),
      'CDN Set-Cookie must be dropped',
    );
    const viewerEvents = await read('viewerEvents');
    assert.ok(
      viewerEvents.some(event => event.args[0]?.type === 'ready'),
      'Actual renderer emits ready',
    );
    assert.ok(
      !viewerEvents.some(event => event.args[0]?.type === 'draft'),
      'No automatic follow-up',
    );
    assert.equal(
      await inner.executeJavaScript('openclaw.host.controlUiBaseUrl'),
      null,
      'No native host-init authority',
    );
    await read(
      `networkFixture.close(${JSON.stringify({ mountId: input.mountId, instanceId: created.instanceId })})`,
    );
    await until(() => guest.isDestroyed(), 'Main closes the exact network guest');
    const summary = {
      ...result,
      fixedViewer: true,
      realMainNetworkPolicy: true,
      independentPartition: true,
      exactCertificateTrust: true,
      noSetCookie: true,
      closeDestroysGuest: true,
    };
    if (input.developmentViewer) {
      const modules = [...new Set(developmentRequests.map(url => new URL(url, origin).pathname))];
      for (const name of [
        'viewer',
        'host',
        'draft',
        'links',
        'messaging',
        'sizing',
        'viewport-fit',
      ])
        assert.ok(
          modules.includes(`/libs/openclaw-chat/components/native-widget/${name}.ts`),
          `Actual Vite viewer module was not loaded: ${name}`,
        );
      for (const entry of ['/@vite/client', '/@react-refresh']) assert.ok(modules.includes(entry));
      assert.ok(
        modules.some(module =>
          /^\/@fs\/.+\/node_modules\/vite\/dist\/client\/env\.mjs$/.test(module),
        ),
      );
      summary.developmentViewer = true;
      summary.viteViewerModules = 7;
    }
    await fs.writeFile(path.join(fixture, 'browser-result.json'), JSON.stringify(summary));
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(String(error.stack ?? error));
    process.exitCode = 1;
  } finally {
    window?.destroy();
    if (viteServer) await viteServer.close();
    viewerServer?.closeAllConnections();
    if (viewerServer) await new Promise(resolve => viewerServer.close(resolve));
    app.exit(process.exitCode ?? 0);
  }
});
