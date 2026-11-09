// Run with: node scripts/test/browser/browser-devtools-smoke.cjs
// Uses the real browser session policy, an isolated profile and no Gateway.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

if (!process.versions.electron) {
  const root = path.resolve(__dirname, '../../..');
  const output = path.join(root, 'build', 'browser-devtools-smoke');
  fs.mkdirSync(output, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(output, 'run-'));
  require('esbuild').buildSync({
    entryPoints: [path.join(root, 'src/main/browser/browserSessionPolicy.ts')],
    outfile: path.join(fixture, 'policy.cjs'),
    bundle: true,
    platform: 'node',
    external: ['electron'],
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, fixture], {
    env, windowsHide: true, stdio: 'inherit', timeout: 25000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow, session } = require('electron');
  const fixture = process.argv[2];
  app.setPath('userData', path.join(fixture, 'profile'));
  const deadline = setTimeout(() => app.exit(1), 20000);
  app.whenReady().then(async () => {
    const { ensureBrowserSessionPolicy } = require(path.join(fixture, 'policy.cjs'));
    const partition = 'browser-devtools-smoke';
    ensureBrowserSessionPolicy(session.fromPartition(partition));
    const host = new BrowserWindow({
      show: false,
      webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, devTools: false },
    });
    host.webContents.on('will-attach-webview', (_event, preferences) => {
      Object.assign(preferences, {
        nodeIntegration: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true,
        allowRunningInsecureContent: false, webviewTag: false,
      });
    });
    const attached = new Promise(resolve => host.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)));
    await host.loadURL('data:text/html,<body></body>');
    await host.webContents.executeJavaScript(`(() => {
      const view = document.createElement('webview');
      view.setAttribute('partition', ${JSON.stringify(partition)});
      view.src = 'data:text/html,<title>Browser diagnostic</title>';
      document.body.append(view);
    })()`);
    const guest = await attached;
    if (guest.isLoading()) await new Promise(resolve => guest.once('did-stop-loading', resolve));
    guest.debugger.attach('1.3');
    await guest.debugger.sendCommand('Network.enable');
    const opened = new Promise(resolve => guest.once('devtools-opened', resolve));
    await host.webContents.executeJavaScript("document.querySelector('webview').openDevTools()");
    await opened;
    assert.equal(guest.isDevToolsOpened(), true);
    assert.match(guest.devToolsWebContents.getURL(), /^devtools:\/\/devtools\/bundled\//);
    host.webContents.openDevTools();
    assert.equal(host.webContents.isDevToolsOpened(), false);
    const tools = guest.devToolsWebContents;
    assert.equal(await tools.executeJavaScript('document.readyState'), 'complete');
    guest.closeDevTools();
    await assert.rejects(guest.loadURL('devtools://devtools/bundled/devtools_app.html'));
    host.destroy();
    clearTimeout(deadline);
    console.log('Browser DevTools opened with the shared policy; main UI and page navigation remain restricted.');
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
