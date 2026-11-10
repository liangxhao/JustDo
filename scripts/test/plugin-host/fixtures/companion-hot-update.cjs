// Hidden Electron companion host. Native owns every install, update, toggle and removal.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const fixture = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const host = require(fixture.host);
app.setPath('userData', path.join(fixture.work, 'electron-user-data'));
app.disableHardwareAcceleration();
let manager, store, server, window, requestId = 0, installed = false;
let gateway = { pid: null, generation: 0, connected: false };
const pending = new Map(), events = new Set();
const native = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native bridge timed out')); }, 100000);
  pending.set(id, { resolve, reject, timer }); process.send({ kind: 'native', id, method, params });
});
const timeout = setTimeout(() => app.exit(1), 400000);
const snapshot = () => manager.snapshot().find(item => item.id === fixture.id);
const invoke = epoch => manager.invoke({ id: fixture.id, command: 'read', epoch, args: [] });
process.on('message', async message => {
  if (message.kind === 'native-result') {
    const task = pending.get(message.id); if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error)); else task.resolve(message.value);
    return;
  }
  if (message.kind === 'event') { for (const listener of events) listener(message.value); return; }
  try {
    if (message.kind === 'connected') {
      gateway = message.gateway; await manager.refresh(); process.send({ kind: 'connected' }); return;
    }
    if (message.kind === 'action') {
      const previous = snapshot(); const action = message.action;
      let writes = 0;
      if (action === 'enable' || action === 'disable') {
        await manager.mutate(fixture.id, action === 'enable', async () => {
          writes++; const result = await native('plugins.setEnabled', { pluginId: fixture.id,
            enabled: action === 'enable', allowlistPolicy: 'preserve' });
          assert.equal(result.ok, true); assert.notEqual(result.restartRequired, true);
        });
      } else {
        await manager.withExtensionPackageMutation(apply => apply({ nativePluginIds: [fixture.id],
          installPath: fixture.installed, ...(message.item ? { sourceDirectory: message.item.packageRoot } : {}) }, async mode => {
          assert.equal(mode, action === 'install' ? host.ExtensionPackageLifecycleMode.STOPPED : host.ExtensionPackageLifecycleMode.HOT);
          writes++;
          const result = action === 'install' ? await native('probe.install', message.item) :
            await native(action === 'update' ? 'plugins.install' : 'plugins.uninstall', action === 'update' ?
              { source: 'local', path: message.item.archive, mode: 'update', enable: false } : { pluginId: fixture.id });
          assert.equal(result.ok, true); assert.notEqual(result.restartRequired, true);
          installed = action !== 'uninstall';
          if (installed) await manager.approveInstalledPackage({ nativePluginId: fixture.id, installPath: fixture.installed });
        }));
      }
      assert.equal(writes, 1);
      const next = snapshot(); const active = ['enable', 'update'].includes(action);
      if (active) {
        assert.equal(next.state, 'active');
        assert.deepEqual(await invoke(next.epoch), { success: true, value: message.label });
      } else {
        assert.notEqual(next?.state, 'active');
      }
      if (message.item) {
        assert.equal(next.hash, message.item.hash);
        assert.equal((await store.read())[fixture.id], message.item.hash);
      }
      if (previous?.state === 'active') {
        assert.equal((await invoke(previous.epoch)).success, false);
        assert.equal(await host.readAppAsset(previous.browserEntry.slice(1)), null);
      }
      const browser = await window.webContents.executeJavaScript('window.renderCompanion()');
      assert.equal(browser.text, active ? message.label : ''); assert.equal(browser.nodeUnavailable, true);
      process.send({ kind: 'action-done', action, snapshot: next, browser, writes, electron: process.versions.electron });
    } else if (message.kind === 'finish') {
      await manager.dispose(); window.destroy(); await new Promise(resolve => server.close(resolve));
      clearTimeout(timeout); app.exit(0);
    }
  } catch (error) { process.send({ kind: 'failed', error: error.stack }); }
});
void (async () => {
  await app.whenReady();
  store = new host.AppApprovalStore(path.join(fixture.work, 'approvals.json'));
  const client = host.bindPluginGatewayClient({ start() {}, stop() {}, request: native });
  const runtime = { captureGatewayResponseContext: () => ({ isCurrent: () => gateway.connected }) };
  manager = new host.AppPluginManager({ retentionRoot: path.join(fixture.work, 'retained'),
    resources: { getNativeStateDirectory: () => fixture.state, getRuntime: () => gateway.connected ? runtime : null,
      getSessions: () => ({ listAgents: () => [] }), requestConnectedGateway: (...args) => client.request(...args),
      requestGateway: (...args) => client.request(...args),
      ensureReady: async () => { throw new Error('An offline install must not start Gateway; hot actions must not restart it'); },
      onNativeEvent: listener => { events.add(listener); return () => events.delete(listener); } },
    candidates: async () => host.discoverAppCandidates(fixture.empty, null,
      installed ? [{ id: fixture.id, installPath: fixture.installed }] : [], await store.read()),
    approveArtifact: (id, hash) => store.approve(id, hash),
    readDesiredEnabled: () => JSON.parse(require('node:fs').readFileSync(fixture.configPath)).plugins?.entries?.[fixture.id]?.enabled === true,
    isGatewayConnected: () => gateway.connected, getGatewayProcessId: () => gateway.pid,
    getGatewayProcessGeneration: () => gateway.generation, broadcast() {},
    withStoppedGateway: async operation => { assert.equal(gateway.pid, null, 'Only the initial offline install may be cold'); return operation(); },
  });
  await manager.prepare(); await manager.activate(); await manager.refresh();
  assert.equal(manager.snapshot().length, 0);
  server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="root"></div><script type="module" src="/harness.mjs"></script>'); return; }
      if (request.url === '/snapshot') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(manager.snapshot())); return; }
      const bytes = request.url === '/harness.mjs' ? await fs.readFile(fixture.harness) : await host.readAppAsset(request.url.slice(1));
      if (!bytes) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(bytes);
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
  assert.equal((await window.webContents.executeJavaScript('window.renderCompanion()')).text, '');
  process.send({ kind: 'ready' });
})().catch(error => { process.send({ kind: 'failed', error: error.stack }); app.exit(1); });
