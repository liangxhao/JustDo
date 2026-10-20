// Native file-page regression: no Gateway, model, user profile or public network.
// An optional first argument also checks an existing local HTML with its own dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (!process.versions.electron) {
  const root = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-local-html-'));
  const entry = path.join(fixture, 'entry.js');
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(path.join(root, 'src/main/browser/preview/localHtmlPreviewServer.ts'))};`,
      `export * from ${JSON.stringify(path.join(root, 'src/main/core/window/browserPanelSecurity.ts'))};`,
    ].join('\n'),
  );
  require('esbuild').buildSync({
    entryPoints: [entry],
    outfile: path.join(fixture, 'browser.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(
    require('electron'),
    [__filename, fixture, ...process.argv.slice(2)],
    { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 55000 },
  );
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow, session } = require('electron');
  const fixture = process.argv[2];
  const optionalSource = process.argv[3];
  app.setPath('userData', path.join(fixture, 'profile'));
  const deadline = setTimeout(() => app.exit(1), 45000);
  app
    .whenReady()
    .then(async () => {
      const {
        createLocalHtmlPreview,
        isAllowedBrowserPanelNavigationUrl,
        isBlockedBrowserMetadataHost,
      } = require(path.join(fixture, 'browser.cjs'));
      let submittedBody;
      const server = http.createServer((request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        if (request.url === '/module.js') {
          response.setHeader('Content-Type', 'text/javascript');
          response.end('export const ready = "yes";');
        } else if (request.url === '/data') {
          response.end('yes');
        } else if (request.url === '/redirect') {
          response.writeHead(302, { Location: '/landing' }).end();
        } else if (request.url === '/form') {
          const chunks = [];
          request.on('data', chunk => chunks.push(chunk));
          request.on('end', () => {
            submittedBody = Buffer.concat(chunks).toString();
            response.setHeader('Content-Type', 'text/html');
            response.end('<title>Submitted</title>');
          });
        } else {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            '<title>Network page</title><script>parent.postMessage("frame-ready", "*")</script>',
          );
        }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const nested = path.join(fixture, 'nested');
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(fixture, '.parent.js'), 'document.body.dataset.parent = "yes";');
      fs.writeFileSync(path.join(fixture, 'style.css'), 'body { color: rgb(12, 34, 56); }');
      fs.writeFileSync(path.join(fixture, 'summary.html'), '<title>Parent directory</title>');
      fs.writeFileSync(
        path.join(nested, 'index.html'),
        `<!doctype html><title>Local page</title>
      <link rel="stylesheet" href="../style.css"><body>
      <script src="../.parent.js"></script>
      <script>
        document.body.dataset.eval = eval('"yes"');
        addEventListener('message', event => { if (event.data === 'frame-ready') document.body.dataset.frame = 'yes'; });
        const worker = new Worker(URL.createObjectURL(new Blob(['postMessage("yes")'], { type: 'text/javascript' })));
        worker.onmessage = event => { document.body.dataset.worker = event.data; worker.terminate(); };
        fetch('${origin}/data').then(response => response.text()).then(value => document.body.dataset.fetch = value);
      </script>
      <script type="module">import { ready } from '${origin}/module.js'; document.body.dataset.module = ready;</script>
      <iframe src="${origin}/frame"></iframe>
      <a id="parent" href="../summary.html">Parent</a>
      <a id="popup" target="_blank" href="${origin}/popup">Popup</a>
      <form action="${origin}/form" method="post"><input name="message" value="hello"></form>`,
      );
      const browserSession = session.fromPartition('browser-local-html-smoke');
      browserSession.webRequest.onBeforeRequest((details, callback) => {
        if (
          details.resourceType === 'mainFrame' &&
          !isAllowedBrowserPanelNavigationUrl(details.url)
        ) {
          callback({ cancel: true });
          return;
        }
        const url = new URL(details.url);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
          callback({});
          return;
        }
        if (isBlockedBrowserMetadataHost(url.hostname)) {
          callback({ cancel: true });
          return;
        }
        browserSession
          .resolveHost(url.hostname)
          .then(result => {
            callback({
              cancel:
                !result.endpoints.length ||
                result.endpoints.some(endpoint => isBlockedBrowserMetadataHost(endpoint.address)),
            });
          })
          .catch(() => callback({ cancel: true }));
      });
      const host = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      host.webContents.on('will-attach-webview', (_event, preferences) => {
        Object.assign(preferences, {
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          plugins: true,
        });
      });
      const attached = new Promise(resolve =>
        host.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)),
      );
      await host.loadURL('data:text/html,<body></body>');
      await host.webContents.executeJavaScript(
        `(() => { const guest = document.createElement('webview'); guest.setAttribute('partition', 'browser-local-html-smoke'); guest.setAttribute('allowpopups', 'true'); guest.src = 'about:blank'; guest.style.cssText = 'width:800px;height:600px'; document.body.append(guest); })()`,
      );
      const guest = await attached;
      guest.setBackgroundThrottling(false);
      for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
        guest.on(eventName, event => {
          if (!isAllowedBrowserPanelNavigationUrl(event.url)) event.preventDefault();
        });
      }
      let popupUrl;
      guest.setWindowOpenHandler(({ url }) => {
        if (isAllowedBrowserPanelNavigationUrl(url)) popupUrl = url;
        return { action: 'deny' };
      });
      const until = async predicate => {
        const expiresAt = Date.now() + 15000;
        while (Date.now() < expiresAt) {
          if (await predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Timed out waiting for native page behavior');
      };
      const preview = await createLocalHtmlPreview(path.join(nested, 'index.html'));
      assert.equal(preview.success, true);
      assert.equal(new URL(preview.url).protocol, 'file:');
      await guest.loadURL(preview.url);
      await until(() =>
        guest.executeJavaScript(
          `['parent','eval','worker','fetch','module','frame'].every(key => document.body.dataset[key] === 'yes')`,
        ),
      );
      assert.equal(
        await guest.executeJavaScript('getComputedStyle(document.body).color'),
        'rgb(12, 34, 56)',
      );
      assert.deepEqual(
        await guest.executeJavaScript('({ bridge: typeof window.electron, node: typeof require })'),
        { bridge: 'undefined', node: 'undefined' },
      );
      await guest.executeJavaScript('document.getElementById("popup").click()', true);
      await until(() => popupUrl === `${origin}/popup`);
      await guest.executeJavaScript('document.getElementById("parent").click()');
      await until(() => guest.getURL() === pathToFileURL(path.join(fixture, 'summary.html')).href);
      await guest.loadURL(preview.url);
      await guest.executeJavaScript('document.querySelector("form").submit()');
      await until(() => guest.getURL() === `${origin}/form` && submittedBody === 'message=hello');
      await guest.loadURL(preview.url);
      await guest.executeJavaScript(`location.href = ${JSON.stringify(`${origin}/redirect`)}`);
      await until(() => guest.getURL() === `${origin}/landing`);
      const checks = [
        'parent-directory script/style/link',
        'HTTP module/fetch/iframe',
        'eval/blob worker',
        'popup admission',
        'POST form',
        'external navigation/redirect',
        'no application bridge/Node',
      ];
      if (optionalSource) {
        const original = await createLocalHtmlPreview(optionalSource);
        assert.equal(original.success, true);
        await guest.loadURL(original.url);
        await until(() =>
          guest.executeJavaScript(
            'document.querySelectorAll("canvas").length === 1 && getComputedStyle(document.getElementById("loading")).display === "none"',
          ),
        );
        await guest.executeJavaScript(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        );
        fs.writeFileSync(path.join(fixture, 'source.png'), (await guest.capturePage()).toPNG());
        checks.push('original globe renders');
      }
      console.log(JSON.stringify({ ok: true, checks, fixture }, null, 2));
      server.close();
      clearTimeout(deadline);
      app.exit(0);
    })
    .catch(error => {
      console.error(error);
      clearTimeout(deadline);
      app.exit(1);
    });
}
