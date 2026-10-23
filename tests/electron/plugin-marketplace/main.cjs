'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const entryIndex = process.argv.findIndex(argument => path.resolve(argument) === __filename);
if (entryIndex < 0) throw new Error('The fixture entry point is missing from Electron arguments');
const [output, fixtureRoot, runtimeRoot, nodeExecutable, nativeDependenciesRoot, mode] = process.argv.slice(entryIndex + 1);
fs.appendFileSync(path.join(fixtureRoot, 'startup.log'), 'Main module loaded\n');
const { createNativeRuntimeFixture } = require('./native-runtime.cjs');

app.setPath('appData', path.join(fixtureRoot, 'roaming'));
app.setPath('userData', path.join(fixtureRoot, 'profile'));
app.setPath('home', path.join(fixtureRoot, 'home'));
app.on('window-all-closed', () => {});
let native;
let services;
let server;
let stopping;
const cleanup = () => stopping ??= (async () => {
  const errors = [];
  for (const close of [() => services?.close(), () => native?.close(), () => {
    server?.closeAllConnections();
    return server && new Promise(resolve => server.close(resolve));
  }]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  fs.writeFileSync(path.join(fixtureRoot, 'shutdown.json'), JSON.stringify({
    ok: errors.length === 0, native: native?.evidence,
    errors: errors.map(error => String(error.message || error)),
  }));
  if (errors.length) throw new AggregateError(errors, 'Fixture teardown failed');
})();
app.on('before-quit', event => {
  if (stopping) return;
  event.preventDefault();
  void cleanup().then(() => app.quit(), error => {
    fs.writeFileSync(path.join(fixtureRoot, 'shutdown-error.txt'), String(error.stack || error));
    app.exit(1);
  });
});

app.whenReady().then(async () => {
  fs.appendFileSync(path.join(fixtureRoot, 'startup.log'), 'Electron ready\n');
  const window = new BrowserWindow({
    show: false, width: 1180, height: 900,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, offscreen: true,
      preload: path.join(output, 'preload.cjs'),
    },
  });
  window.webContents.on('console-message', details => {
    if (details.level === 'error') console.error('[Fixture renderer]', details.message);
  });
  fs.appendFileSync(path.join(fixtureRoot, 'startup.log'), 'Window created\n');
  native = await createNativeRuntimeFixture({ runtimeRoot, fixtureRoot, nodeExecutable, nativeDependenciesRoot });
  const { createProbeServices } = require(path.join(output, 'services.cjs'));
  services = await createProbeServices({
    fixtureRoot, native, nodeExecutable,
    mcpServer: path.resolve(__dirname, '../../openclaw/fixtures/npx-mcp-smoke/server.mjs'),
  });
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const allowed = new Map([
      ['/', ['index.html', 'text/html']],
      ['/bundle.js', ['bundle.js', 'application/javascript']],
      ['/layout.css', ['layout.css', 'text/css']],
    ]);
    const resource = allowed.get(pathname);
    if (!resource) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', resource[1]);
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
    response.end(fs.readFileSync(path.join(output, resource[0])));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await window.loadURL(`http://127.0.0.1:${server.address().port}/${mode === 'extension-import' ? '?mode=extension-import' : ''}`);
  fs.writeFileSync(path.join(fixtureRoot, 'ready.json'), JSON.stringify({
    profile: app.getPath('userData'), home: app.getPath('home'), runtimeRoot,
  }));
}).catch(async error => {
  fs.writeFileSync(path.join(fixtureRoot, 'main-error.txt'), error.stack || String(error));
  console.error(error);
  await cleanup().catch(() => {});
  app.exit(1);
});
