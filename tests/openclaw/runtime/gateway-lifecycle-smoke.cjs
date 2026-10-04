// Run after compile:electron and the complete runtime build. Isolated state; no model calls.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { ensureGatewayShutdownPreload, OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE } = require('../../../dist-electron/src/main/openclaw/runtime/openclawLauncher.js');
const { buildOpenClawCompileCacheEnvironment, GATEWAY_READY_MESSAGE } = require('../../../src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs');

(async () => {
  const root = path.resolve(process.argv[2] || 'vendor/openclaw-runtime/current');
  const existingState = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
  if (existingState) {
    assert.equal(path.dirname(existingState), path.resolve(os.tmpdir()));
    assert.ok(path.basename(existingState).startsWith('justdo-gateway-smoke-'), 'only a smoke-created state directory may be upgraded');
  }
  const state = existingState ?? fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-lifecycle-smoke-'));
  const workspace = path.join(state, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const token = randomBytes(24).toString('hex');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const configPath = path.join(state, 'openclaw.json');
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    update: { checkOnStart: false, auto: { enabled: false } },
    agents: { entries: { main: {} }, defaults: { workspace, systemAgent: { agentId: 'main' } } },
    plugins: { allow: ['memory-core'], entries: { 'memory-core': { enabled: true } } },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const env = buildOpenClawCompileCacheEnvironment({
    ...process.env, OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_DISABLE_BONJOUR: '1',
    JUSTDO_APP_STARTED_AT_MS: String(Date.now()), NO_COLOR: '1', FORCE_COLOR: '0',
  }, path.join(state, '.compile-cache'));
  // Native client identity storage must use the same isolated state as the child.
  for (const name of ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH']) {
    process.env[name] = env[name];
  }
  const file = fs.readdirSync(path.join(root, 'dist')).find(f =>
    /^client-.*\.mjs$/.test(f) && fs.readFileSync(path.join(root, 'dist', f), 'utf8').includes('GatewayClient as t'));
  assert.ok(file, 'native GatewayClient export');
  const { t: GatewayClient } = await import(pathToFileURL(path.join(root, 'dist', file)).href);
  let child;
  let client;
  let output = '';
  let helloCount = 0;
  async function waitFor(predicate, label, timeout = 60000) {
    const start = Date.now();
    while (!predicate()) {
      if (child?.exitCode !== null) throw new Error(`${label}: Gateway exited`);
      if (Date.now() - start > timeout) throw new Error(`${label}: timed out`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async function start() {
    const started = Date.now();
    child = spawn(process.execPath, [
      '--require', ensureGatewayShutdownPreload(state), path.join(root, 'gateway-launcher.cjs'),
      'gateway', 'run', '--allow-unconfigured', '--port', String(port),
    ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    // Like the application, let Gateway finish native migrations before the
    // client opens its identity store or attempts a WebSocket handshake.
    let healthy = false;
    while (Date.now() - started < 60000) {
      if (child.exitCode !== null) throw new Error('Gateway exited before health readiness');
      try {
        healthy = (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) })).ok;
      } catch {}
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.equal(healthy, true, 'Gateway health readiness');
    const count = helloCount;
    client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`, token, clientName: 'gateway-client', mode: 'backend',
      scopes: ['operator.admin'], onHelloOk: () => { helloCount++; },
    });
    client.start();
    await waitFor(() => helloCount > count, 'startup handshake');
    child.send(GATEWAY_READY_MESSAGE);
    await client.request('health', {});
    return Date.now() - started;
  }
  async function stop() {
    if (client) { await client.stopAndWait().catch(() => client.stop()); client = undefined; }
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.send(OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
    const timer = setTimeout(() => child.kill(), 15000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  const deadline = setTimeout(() => { child?.kill(); }, 180000);
  try {
    const coldStartMs = await start();
    const firstPid = child.pid;
    const key = existingState ? 'agent:main:justdo:smoke' : 'agent:main:justdo:lifecycle-smoke';
    if (!existingState) await client.request('sessions.create', { key, cwd: workspace, permissionMode: 'read-only' });
    const before = await client.request('sessions.describe', { key });
    const sessionId = before.session?.sessionId ?? before.sessionId;
    assert.equal(typeof sessionId, 'string', 'native durable session identity');
    const reloadAt = output.length;
    config.agents.defaults.thinkingDefault = 'low';
    fs.writeFileSync(configPath, JSON.stringify(config));
    await waitFor(() => output.slice(reloadAt).includes('config hot reload applied'), 'hot config reload');
    assert.equal(child.pid, firstPid);
    await client.request('health', {});
    const reconnectBefore = helloCount;
    const restartAt = output.length;
    const started = Date.now();
    const restart = await client.request('gateway.restart.request', { reason: 'isolated lifecycle verification', skipDeferral: false });
    assert.equal(restart.ok, true);
    assert.ok(['scheduled', 'deferred', 'coalesced'].includes(restart.status));
    await waitFor(() => helloCount > reconnectBefore && output.slice(restartAt).includes('[gateway] ready'), 'native in-process restart');
    const hotRestartMs = Date.now() - started;
    assert.equal(child.pid, firstPid);
    await client.request('health', {});
    await stop();
    const warmStartMs = await start();
    assert.notEqual(child.pid, firstPid);
    const after = await client.request('sessions.describe', { key });
    assert.equal(after.session?.sessionId ?? after.sessionId, sessionId);
    console.log(JSON.stringify({ ok: true, coldStartMs, warmStartMs, hotRestartMs,
      hotReloadSameProcess: true, hotRestartSameProcess: true, coldRestartNewProcess: true,
      stateRetained: true, upgradedExistingState: Boolean(existingState), state }));
  } finally {
    clearTimeout(deadline);
    await stop();
    fs.writeFileSync(path.join(state, 'smoke.log'), output.replaceAll(token, '<test-token>'));
    console.log('Smoke log: ' + path.join(state, 'smoke.log'));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
