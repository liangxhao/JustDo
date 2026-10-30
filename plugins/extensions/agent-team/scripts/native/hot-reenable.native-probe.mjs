// Explicit host/native integration probe. Uses only private fixture data and loopback sockets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import probePaths from '../probe-paths.cjs';

const { hostRoot, hostRequire } = probePaths;
assert.equal(process.argv.length, 3, 'Pass only the selected prepared runtime directory.');
const runtime = fs.realpathSync(path.resolve(process.argv[2]));
const { verifyFrozenOpenClawRuntime } = hostRequire(path.join(hostRoot,
  'scripts/openclaw/verify-openclaw-runtime-patches.cjs'));
const { manifest } = verifyFrozenOpenClawRuntime(runtime, {
  expectedVersion: hostRequire(path.join(hostRoot, 'package.json')).openclaw.version, requireBundle: true,
});
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(runtime, 'node-runtime',
  process.platform === 'win32' ? 'node.exe' : 'node')), 'Use this frozen runtime bundled Node.');
const runtimeIdentity = { runtimeRoot: runtime, openclawVersion: manifest.openclawVersion,
  target: manifest.target, gatewayBundleSha256: manifest.gatewayBundle.sha256,
  patchSetSha256: manifest.patchSetSha256, nodeVersion: process.version, proof: 'frozen-artifact-bytes' };
const { ensureGatewayShutdownPreload, OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE } = await import(pathToFileURL(
  path.join(hostRoot, 'src/main/openclaw/runtime/launch/openclawLauncher.ts')).href);
const { GATEWAY_READY_MESSAGE } = hostRequire(path.join(hostRoot,
  'src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs'));
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const root = path.join(hostRoot, '.agent-tasks/hot-plugin-enable');
fs.mkdirSync(root, { recursive: true });
const work = fs.mkdtempSync(path.join(root, 'probe-'));
assert.ok(path.relative(root, work) && !path.relative(root, work).startsWith('..'));
const state = path.join(work, 'state');
const workspace = path.join(work, 'workspace');
const extensions = path.join(work, 'extensions');
for (const directory of [state, workspace, extensions]) fs.mkdirSync(directory);
const catalog = readJson(path.join(hostRoot, 'build/app-plugins/catalog.json'));
const packages = {};
for (const id of ['agent-team', 'swarm-workflow']) {
  const entry = catalog.find(item => item.id === id);
  assert.match(entry?.hash ?? '', /^[a-f0-9]{64}$/u, `Build the current ${id} App package first.`);
  const source = path.join(hostRoot, 'build/app-plugins/packages', id, entry.hash);
  const artifact = readJson(path.join(source, 'app/app.artifact.json'));
  const binding = readJson(path.join(source, 'app/native.binding.json'));
  assert.equal(artifact.hash, entry.hash);
  assert.equal(binding.entry, 'index.js');
  assert.equal(binding.sha256, hash(fs.readFileSync(path.join(source, 'index.js'))));
  fs.cpSync(source, path.join(extensions, id), { recursive: true, dereference: true });
  packages[id] = { hash: entry.hash, nativeSha256: binding.sha256 };
}
const requiredSource = path.join(runtime, 'dist/extensions/runtime-services');
fs.cpSync(requiredSource, path.join(extensions, 'runtime-services'), { recursive: true, dereference: true });
packages['runtime-services'] = { nativeSha256: hash(fs.readFileSync(path.join(requiredSource, 'index.js'))),
  profileSha256: hash(fs.readFileSync(path.join(requiredSource, 'execution/runtime-profile.json'))) };

const token = randomBytes(32).toString('hex');
let modelRequests = 0;
const model = createHttpServer(async (request, response) => {
  for await (const chunk of request) { void chunk; /* Never record fixture request bodies. */ }
  modelRequests++;
  response.writeHead(503); response.end('This probe must never execute a model.');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const reservation = createTcpServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const configPath = path.join(state, 'openclaw.json');
fs.writeFileSync(configPath, JSON.stringify({
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
  logging: { file: path.join(work, 'native.jsonl'), level: 'info', consoleLevel: 'info' },
  update: { checkOnStart: false, auto: { enabled: false } },
  discovery: { mdns: { mode: 'off' } },
  agents: { ownership: 'explicit', entries: { fixture: {} }, defaults: { workspace,
    skipBootstrap: true, heartbeat: { every: '0m' }, systemAgent: { agentId: 'fixture' },
    embeddedAgent: { cyberFailover: { mode: 'off' } }, model: { primary: 'fixture/never' },
    modelPolicy: { allow: ['fixture/never'] } } },
  models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: { fixture: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic-fixture-key',
    api: 'openai-completions', request: { allowPrivateNetwork: true }, models: [{ id: 'never', name: 'No execution',
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 16 }],
  } } },
  plugins: { slots: { memory: 'none' }, allow: ['runtime-services', 'agent-team', 'swarm-workflow'],
    entries: { 'runtime-services': { enabled: true }, 'agent-team': { enabled: true }, 'swarm-workflow': { enabled: false } } },
}));
const offlineLog = path.join(work, 'offline-attempts.jsonl');
fs.writeFileSync(offlineLog, '');
const guard = path.join(hostRoot, 'scripts/test/plugin-host/block-public-network.cjs');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(OPENCLAW_|NODE_OPTIONS$|NODE_PATH$|NODE_COMPILE_CACHE$|ELECTRON_RUN_AS_NODE$)/iu.test(key)));
Object.assign(env, {
  OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_BUNDLED_PLUGINS_DIR: extensions, OPENCLAW_DISABLE_BUNDLED_PLUGINS: '0',
  // Native explicitly restricts arbitrary bundled-root overrides to test fixtures.
  // This preserves bundled admission for these byte-verified package copies.
  VITEST: 'true', OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1', OPENCLAW_TEST_MINIMAL_GATEWAY: '0',
  OPENCLAW_TEST_CONSOLE: '1', OPENCLAW_TEST_FILE_LOG: '1',
  OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1', OPENCLAW_DISABLE_BONJOUR: '1',
  HOME: state, USERPROFILE: state, APPDATA: path.join(state, 'appdata'), LOCALAPPDATA: path.join(state, 'localappdata'),
  APP_PLUGIN_OFFLINE_ATTEMPT_LOG: offlineLog, NODE_DISABLE_COMPILE_CACHE: '1',
});
const saved = new Map();
for (const [key, value] of Object.entries(env)) {
  if (process.env[key] !== value) { saved.set(key, process.env[key]); process.env[key] = value; }
}
hostRequire(guard);
const child = spawn(process.execPath, ['--require', guard, '--require', ensureGatewayShutdownPreload(state),
  path.join(runtime, 'gateway-launcher.cjs'), 'gateway', 'run', '--allow-unconfigured', '--port', String(port), '--bind', 'loopback'],
{ cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { output = (output + value).slice(-256 * 1024); });
let client;
let primaryFailure;
let agentEvents = 0;
let configChangedAt = Date.now();
const methods = [];
const report = { runtimeIdentity, packages, gatewayPid: child.pid, checks: [], verified: false, cleanClose: false,
  scope: 'Real prepared Gateway process and public plugin lifecycle/RPCs with private fixture state. The Native test-only trusted-bundled-directory override admits verified package copies; minimal Gateway mode is disabled. No Main/UI claim, no model execution, no user Gateway or transcripts.' };
const stage = name => { report.stage = name; console.log(JSON.stringify({ stage: name, evidence: work })); };
const assertAlive = () => assert.ok(child.exitCode === null && child.signalCode === null, 'The same fixture Gateway remains alive.');
async function until(predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    assertAlive();
    if (await predicate()) return;
    assert.ok(Date.now() < deadline, `${label}: timed out`);
    await delay(100);
  }
}
try {
  stage('gateway-startup');
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, 'Gateway startup readiness');
  stage('gateway-handshake');
  const { GatewayClient } = await import(pathToFileURL(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js')).href);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture Gateway handshake timed out.')), 30_000);
    client = new GatewayClient({ env, url: `ws://127.0.0.1:${port}`, token, deviceIdentity: null,
      sharedStateMode: 'read-only', clientName: 'gateway-client', clientVersion: 'hot-plugin-enable-probe',
      mode: 'backend', role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write'], requestTimeoutMs: 60_000,
      onHelloOk() { clearTimeout(timer); resolve(); },
      onConnectError(error) { clearTimeout(timer); reject(error); },
      onEvent(event) {
        if (event.event === 'agent') agentEvents++;
        if (event.event === 'config.changed') configChangedAt = Date.now();
      },
    });
    client.start();
  });
  child.send(GATEWAY_READY_MESSAGE);
  const request = (method, params = {}) => { assertAlive(); methods.push(method); return client.request(method, params); };
  // Native readiness precedes its initial plugin-registry maintenance lease.
  // Observe that fixture phase settling before sending the first lifecycle write.
  stage('startup-maintenance');
  await until(() => /startup phase: post-ready\.startup-maintenance [\d.]+ms/u.test(output),
    'Initial plugin lifecycle maintenance settles');
  // A watcher echo can still hold a lease with identical hashes. Observe a
  // quiet public configuration window after fixture maintenance has settled.
  // A lifecycle write itself is never retried.
  const settledConfig = async () => {
    let stableSince = Date.now();
    let previous;
    await until(async () => {
      const config = await request('config.get');
      const revision = config.configRevisionHash;
      if (typeof revision !== 'string' || revision !== config.appliedConfigHash || previous !== revision) {
        previous = revision;
        stableSince = Date.now();
        return false;
      }
      return Date.now() - Math.max(stableSince, configChangedAt) >= 1500;
    }, 'The public configuration revision is applied and stable');
  };
  stage('configuration-settled');
  await settledConfig();
  const handshake = async id => {
    const receipt = await request(`${id}.app.handshake`);
    assert.equal(receipt.pluginId, id); assert.equal(receipt.processId, child.pid);
    assert.equal(receipt.sourceSha256, packages[id].nativeSha256);
    return receipt;
  };
  const call = (receipt, method, params) => {
    const bound = receipt.gatewayMethods.find(value => value.method === method);
    assert.ok(bound, `Current Native receipt contains ${method}.`);
    return request(bound.alias, params);
  };
  const enabled = async (id, value) => {
    await settledConfig();
    const result = await request('plugins.setEnabled', { pluginId: id, enabled: value, allowlistPolicy: 'preserve' });
    assert.equal(result.ok, true); assert.notEqual(result.restartRequired, true, 'Configuration-only toggle stays in one Gateway process.');
    const inventory = await request('plugins.list');
    const plugin = inventory.plugins.find(item => item.id === id);
    assert.equal(plugin?.enabled, value);
    // Native hot removal withdraws the record; it is unloaded in the new registry.
    assert.equal(plugin?.runtime?.state, value ? 'active' : 'unloaded');
    await settledConfig();
    assertAlive(); return result.runtime;
  };
  const proof = receipt => {
    const entry = receipt.gatewayMethods.find(value => value.method.startsWith('runtimeServices.ownerProof.'));
    assert.ok(entry, 'The actual Team registration publishes a fresh owner proof method.');
    return entry.method;
  };
  let previous = await handshake('agent-team');
  const sourceKey = `agent:fixture:justdo:${randomUUID()}`;
  for (let cycle = 1; cycle <= 2; cycle++) {
    stage(`agent-team-cycle-${cycle}`);
    const stopped = await enabled('agent-team', false);
    await assert.rejects(call(previous, 'agentTeam.launch.inspect', { sessionKey: sourceKey }));
    const started = await enabled('agent-team', true);
    const receipt = await handshake('agent-team');
    assert.notEqual(receipt.registrationId, previous.registrationId);
    assert.notEqual(proof(receipt), proof(previous), 'A replacement cannot reuse the retired owner proof registration.');
    await assert.rejects(call(previous, 'agentTeam.launch.inspect', { sessionKey: sourceKey }));
    assert.deepEqual(await call(receipt, 'agentTeam.launch.inspect', { sessionKey: sourceKey }), { state: 'absent', generation: 0 });
    const roomId = `probe_${randomUUID().replaceAll('-', '')}`;
    const identity = await call(receipt, 'teamDiscussion.holdingPrepare', { roomId, generation: 1, agentId: 'fixture', cwd: workspace });
    assert.equal(identity.roomId, roomId); assert.equal(identity.epoch, 1); assert.equal(identity.generation, 1);
    const send = { roomId, requestId: randomUUID(), expectedRevision: 1, message: 'Synthetic pending input; never dispatch.', selectedAgentIds: [], rounds: 1 };
    const fingerprint = hash(JSON.stringify([roomId, 1, send.message, [], 1, [], []]));
    const savedInput = await call(receipt, 'teamDiscussion.holdingSave', { identity, send, fingerprint });
    assert.equal(savedInput.state, 'saved'); assert.ok(savedInput.entryId);
    const readInput = await call(receipt, 'teamDiscussion.holdingRead', { identity, requestId: send.requestId, fingerprint, entryId: savedInput.entryId });
    assert.equal(readInput.send.message, send.message); assert.equal(readInput.send.requestId, send.requestId);
    assert.equal(readInput.identity.sessionId, identity.sessionId); assert.equal(readInput.identity.lifecycleRevision, identity.lifecycleRevision);
    report.checks.push({ cycle, stopped, started, registrationId: receipt.registrationId,
      ownerProofSha256: hash(proof(receipt)), launchInspect: true, holdingPreparedSavedRead: true, oldRegistrationRejected: true });
    previous = receipt;
  }
  stage('swarm-workflow-cycle');
  const workflowStart = await enabled('swarm-workflow', true);
  const workflow = await handshake('swarm-workflow');
  const workflowStop = await enabled('swarm-workflow', false);
  await assert.rejects(request('swarm-workflow.app.handshake'));
  report.checks.push({ plugin: 'swarm-workflow', started: workflowStart, stopped: workflowStop, registrationId: workflow.registrationId });
  assert.equal(modelRequests, 0, 'Hot plugin lifecycle and inert custody never execute a model.');
  assert.equal(agentEvents, 0, 'No native agent run is started.');
  assert.equal(fs.readFileSync(offlineLog, 'utf8'), '', 'The isolated probe never attempts a public network connection.');
  report.verified = true;
} catch (error) { primaryFailure = error; }
finally {
  stage('gateway-shutdown');
  if (client) await client.stopAndWait().catch(() => undefined);
  if (child.exitCode === null && child.signalCode === null) child.send(OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
  let shutdownTimer;
  const result = await Promise.race([closed, new Promise(resolve => {
    shutdownTimer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: child.exitCode, signal: 'forced-timeout' }); }, 45_000);
  })]);
  clearTimeout(shutdownTimer);
  if (result.signal === 'forced-timeout') await closed;
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  report.gatewayExit = result; report.cleanClose = result.code === 0 && result.signal === null;
  report.modelRequests = modelRequests; report.agentEvents = agentEvents; report.methods = methods;
  report.publicNetworkAttempts = fs.readFileSync(offlineLog, 'utf8').trim().split('\n').filter(Boolean).length;
  if (primaryFailure) report.failure = String(primaryFailure.stack ?? primaryFailure);
  fs.writeFileSync(path.join(work, 'gateway.log'), output.replaceAll(token, '<fixture-token>'));
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence: work, verified: report.verified, cleanClose: report.cleanClose,
    ...(primaryFailure ? { failure: String(primaryFailure.message ?? primaryFailure) } : {}) }));
}
if (primaryFailure) throw primaryFailure;
assert.equal(report.cleanClose, true, 'The owned fixture Gateway shuts down cleanly.');
assert.equal(report.modelRequests, 0, 'The entire fixture lifetime never executes a model.');
assert.equal(report.agentEvents, 0, 'The entire fixture lifetime starts no native agent run.');
assert.equal(report.publicNetworkAttempts, 0, 'The entire fixture lifetime attempts no public network connection.');
