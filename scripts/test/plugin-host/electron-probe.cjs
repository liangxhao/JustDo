// Hidden, disposable Electron process used by verify-plugin-host-assumptions.mjs.
const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain } = require('electron');

const [temporary, assets, hostModule, preload, resultPath] = process.argv.slice(2);
app.setPath('userData', path.join(temporary, 'electron-user-data'));
app.disableHardwareAcceleration();
let host;
let window;
const diagnostics = [];
const timeout = setTimeout(() => {
  console.error('Probe timed out', diagnostics);
  app.exit(1);
}, 30000);

void (async () => {
  try {
    await app.whenReady();
    const mutable = path.join(temporary, 'electron-esm');
    const emit = async (directory, generation) => {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'child.mjs'), `export const child = ${generation};`);
      await writeFile(
        path.join(directory, 'main.mjs'),
        `import { child } from './child.mjs'; export const root = ${generation}; export { child };`,
      );
    };
    await emit(mutable, 1);
    const moduleUrl = pathToFileURL(path.join(mutable, 'main.mjs')).href;
    const first = await import(moduleUrl);
    await emit(mutable, 2);
    assert.equal(await import(moduleUrl), first);
    const query = await import(`${moduleUrl}?generation=2`);
    assert.equal(query.root, 2);
    assert.equal(query.child, 1);
    const secondDirectory = path.join(temporary, 'electron-generation-2');
    await emit(secondDirectory, 2);
    const second = await import(pathToFileURL(path.join(secondDirectory, 'main.mjs')).href);
    assert.equal(second.root, 2);
    assert.equal(second.child, 2);
    const { startApplicationRendererHost } = require(hostModule);
    host = await startApplicationRendererHost(assets);
    const index = await fetch(host.url);
    const csp = index.headers.get('content-security-policy');
    const scriptPolicy = csp.split(';').find(value => value.trim().startsWith('script-src '));
    assert.ok(scriptPolicy.includes("'self'"));
    assert.ok(scriptPolicy.includes('sha256-'));
    assert.ok(!scriptPolicy.includes("'unsafe-inline'"));
    assert.ok(!scriptPolicy.includes("'unsafe-eval'"));
    assert.equal((await fetch(`${host.origin}/assets/plugin-shared.mjs`)).status, 200);
    assert.equal((await fetch(`${host.origin}/plugins/ui.mjs`)).status, 404);
    assert.equal((await fetch(`${host.origin}/assets/plugin-shared.mjs?generation=2`)).status, 404);
    assert.equal((await fetch(`${host.origin}/assets/change.mjs`)).status, 200);
    await writeFile(path.join(assets, 'assets/change.mjs'), 'export const value = 2;');
    assert.equal((await fetch(`${host.origin}/assets/change.mjs`)).status, 404);

    window = new BrowserWindow({
      show: false,
      webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    window.webContents.on('console-message', event => {
      if (event.level === 'warning' || event.level === 'error') diagnostics.push(event.message);
    });
    window.webContents.on('preload-error', (_event, _file, error) =>
      diagnostics.push(String(error)),
    );
    ipcMain.once('probe:result', async (event, result) => {
      try {
        assert.equal(event.sender, window.webContents);
        assert.equal(result.sharedReactIdentity, true);
        assert.equal(result.sharedHooksRendered, true);
        assert.equal(result.duplicateReactIdentity, true);
        assert.equal(result.duplicateHooksRejected, true);
        assert.equal(result.rendererNodeUnavailable, true);
        assert.deepEqual(result.cspViolations, []);
        await writeFile(
          resultPath,
          JSON.stringify({
            versions: {
              electron: process.versions.electron,
              node: process.versions.node,
              chrome: process.versions.chrome,
            },
            renderer: result,
            esm: {
              sameUrlRetainsOldModule: true,
              rootQueryMixesOldChild: true,
              versionedDirectoryConsistent: true,
            },
            immutableHost: {
              scriptCspUnweakened: true,
              hashedImportMapWorks: true,
              unregisteredRouteDenied: true,
              queryCacheBustingDenied: true,
              postSnapshotMutationDenied: true,
            },
          }),
        );
        await host.close();
        window.destroy();
        clearTimeout(timeout);
        app.exit(0);
      } catch (error) {
        console.error(error);
        app.exit(1);
      }
    });
    await window.loadURL(host.url);
  } catch (error) {
    console.error(error);
    if (host) await host.close();
    clearTimeout(timeout);
    app.exit(1);
  }
})();
