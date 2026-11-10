'use strict';

// Real Electron document events with an isolated native-session fixture.
// No user profile, Gateway, model or transcript access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.agent-tasks/mcp-apps/workspace-lifecycle');
fs.mkdirSync(output, { recursive: true });

if (!process.versions.electron) {
  void (async () => {
    await require('esbuild').build({
      entryPoints: [path.join(root, 'src/main/plugins/mcp/workspaceAppSession.ts')],
      outfile: path.join(output, 'workspace.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
      cwd: root, stdio: 'inherit', timeout: 60000, windowsHide: true,
    });
    process.exitCode = result.status ?? 1;
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const { WorkspaceAppSessions } = require(path.join(output, 'workspace.cjs'));
  app.setPath('userData', path.join(output, 'profile'));
  const sessions = new Map();
  const deletions = [];
  let created = 0;
  let window;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url.startsWith('/frame') ? '<p>App fixture</p>' :
      '<!doctype html><title>Workspace fixture</title><iframe src="/frame"></iframe>');
  });
  const config = { workingDirectory: output, permissionMode: 'auto', allowMainAgentSwitch: false };
  const service = new WorkspaceAppSessions({
    waitForStartup: async assertCurrent => { assertCurrent(); },
    getStore: () => ({ getConfig: () => config, getAgent: () => ({ enabled: true }) }),
    captureResponseContext: async () => ({ isCurrent: () => true, isResponseError: () => false }),
    request: async (method, params, options) => {
      options?.assertBeforeSend?.();
      if (method === 'sessions.describe') return { session: sessions.get(params.key) ?? null };
      if (method === 'sessions.create') {
        const entry = {
          sessionId: `native-${++created}`, lifecycleRevision: randomUUID(),
          sessionRoot: params.cwd, permissionMode: params.permissionMode,
        };
        sessions.set(params.key, entry);
        return { key: params.key, sessionId: entry.sessionId, entry, runStarted: false };
      }
      assert.equal(method, 'sessions.delete');
      const entry = sessions.get(params.key);
      assert.equal(params.expectedSessionId, entry.sessionId);
      assert.equal(params.expectedLifecycleRevision, entry.lifecycleRevision);
      deletions.push(params.key);
      sessions.delete(params.key);
      return { ok: true, deleted: true };
    },
  });
  const prepare = () => service.prepare(window.webContents, {
    requestId: randomUUID(), cwd: output, agentId: 'main',
  });
  const deadline = setTimeout(() => { console.error('Workspace lifecycle probe timed out'); app.exit(1); }, 45000);
  void (async () => {
    await app.whenReady();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const initial = await prepare();
    const hash = once(window.webContents, 'did-navigate-in-page');
    await window.webContents.executeJavaScript('location.hash = "fixture"');
    await hash;
    const frame = new Promise(resolve => window.webContents.on('did-frame-finish-load', (_event, main) => {
      if (!main) resolve();
    }));
    await window.webContents.executeJavaScript('document.querySelector("iframe").src = "/frame-next"');
    await frame;
    assert.equal(deletions.length, 0, 'Hash and App iframe navigation must retain ownership');
    assert(sessions.has(initial.sessionKey));

    for (let i = 0; i < 12; i++) {
      const loaded = once(window.webContents, 'did-finish-load');
      window.webContents.reload();
      await loaded;
      const current = await prepare();
      assert.equal(deletions.length, i + 1);
      assert.equal(sessions.size, 1);
      assert(sessions.has(current.sessionKey));
    }
    // Adoption removes preview ownership synchronously; later refresh preserves it.
    const input = { requestId: randomUUID(), cwd: output, agentId: 'main' };
    const adopted = await service.prepare(window.webContents, input);
    await service.adopt(window.webContents, input, id => ({ id }), () => true);
    const loaded = once(window.webContents, 'did-finish-load');
    window.webContents.reload();
    await loaded;
    await prepare();
    assert(sessions.has(adopted.sessionKey));
    assert(!deletions.includes(adopted.sessionKey));
    console.info('Workspace lifecycle smoke passed: 12 reloads, hash/iframe retention, adopted chat protection.');
  })().then(() => {
    clearTimeout(deadline);
    window?.destroy();
    server.close();
    app.quit();
  }).catch(error => {
    console.error(error);
    clearTimeout(deadline);
    window?.destroy();
    server.close();
    app.exit(1);
  });
}
