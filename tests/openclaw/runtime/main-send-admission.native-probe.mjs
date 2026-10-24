// Actual Main metadata, runtime/router and event admission; no Electron UI or user profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { verifyCollaborationExtensionAssembly } from './extension-assembly-contract.mjs';
import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const { runtimeRoot: runtime, identity } = resolveNativeSmokeTarget(process.argv[2]);
const assembly = verifyCollaborationExtensionAssembly(runtime);
const options = process.argv.slice(3);
const prepareOnly = options.includes('--prepare-only');
const baselineIndex = options.indexOf('--baseline-source');
const baselinePath = baselineIndex < 0 ? undefined : path.resolve(options[baselineIndex + 1] ?? '');
assert.ok(options.every((value, index) => value === '--prepare-only' || value === '--baseline-source' ||
  (baselineIndex >= 0 && index === baselineIndex + 1)), 'Unknown probe option');
if (baselinePath) assert.ok(fs.statSync(baselinePath).isFile());
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-send-admission-'));
const workspace = path.join(stateDir, 'workspace');
fs.mkdirSync(workspace);
const evidenceRoot = path.join(repository, '.agent-tasks/runtime/main-send-admission');
fs.mkdirSync(evidenceRoot, { recursive: true });
const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'probe-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
const electronFixture = { name: 'isolated-electron-window-ports', setup(builder) {
  builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'isolated-ports' }));
  builder.onLoad({ filter: /.*/, namespace: 'isolated-ports' }, () => ({ loader: 'js', contents: `
    export const app = { getPath: () => ${JSON.stringify(stateDir)}, getAppPath: () => ${JSON.stringify(repository)},
      getVersion: () => '0.0.0', isPackaged: false };
    export const BrowserWindow = { getAllWindows: () => [] };
    export const safeStorage = { isEncryptionAvailable: () => false };
  ` }));
} };
const compiled = path.join(evidence, 'main.cjs');
const compilation = await build({ stdin: { contents: `
export { CoworkStore } from './src/main/data/coworkStore';
export { OpenClawRuntimeAdapter } from './src/main/engine/openclaw/openclawRuntimeAdapter';
export { CoworkEngineRouter } from './src/main/engine/cowork/coworkEngineRouter';
export { AgentTeamLaunchCoordinator } from './plugins/extensions/agent-team/host/launch/agentTeamLaunchCoordinator';
export { appendAgentTeamInstruction } from './plugins/extensions/agent-team/prompt/agentTeamPrompt';
export { buildManagedSessionKey } from './src/main/openclaw/sessions/openclawSessionKeys';
export { GatewayProcessShutdown } from './src/main/openclaw/runtime/launch/gatewayProcessShutdown';
export { ensureGatewayShutdownPreload } from './src/main/openclaw/runtime/launch/openclawLauncher';
export { GATEWAY_READY_MESSAGE } from './src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs';
`, resolveDir: repository, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
outfile: compiled, metafile: true, external: ['better-sqlite3'], plugins: [electronFixture] });
const host = require(compiled);
let baselineStatus;
if (baselinePath) {
  const baselineSource = fs.readFileSync(baselinePath, 'utf8');
  assert.ok(!baselineSource.includes('event-reobserve'), 'The optional regression baseline must precede point reobservation');
  const baselineOutput = path.join(evidence, 'baseline.cjs');
  await build({ stdin: { contents: `export { getSessionRuntimeStatus } from './src/main/engine/openclaw/runtimeSessionStatus';`,
    resolveDir: repository, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  outfile: baselineOutput, plugins: [{ name: 'explicit-previous-status-source', setup(builder) {
    builder.onLoad({ filter: /[\\/]engine[\\/]openclaw[\\/]runtimeSessionStatus\.ts$/ }, args => ({
      contents: baselineSource, loader: 'ts', resolveDir: path.dirname(args.path),
    }));
  } }] });
  baselineStatus = require(baselineOutput).getSessionRuntimeStatus;
}
const report = { ...identity, assembly, stateDir, verified: false, cleanClose: false, checks: [],
  sources: Object.keys(compilation.metafile.inputs).filter(name => !name.startsWith('<') && !name.startsWith('isolated-ports:'))
    .sort().map(name => ({ path: name.replaceAll('\\', '/'), sha256: hash(fs.readFileSync(path.resolve(repository, name))) })),
  ...(baselinePath ? { baselineSourceSha256: hash(fs.readFileSync(baselinePath)) } : {}),
  scope: 'Actual CoworkStore SQL materialization, OpenClawRuntimeAdapter and CoworkEngineRouter live property contexts and production Gateway event handler. Electron window/resource ports are isolated, and unrelated background Goal recovery is retired after each event. The transport delays authentic Gateway frames without altering their payload. No UI, user profile, external model or autonomous-Team claim.' };
function progress(phase, metadata = {}) {
  console.log(JSON.stringify({ phase, at: Date.now(), ...metadata }));
}
if (prepareOnly) {
  fs.writeFileSync(path.join(evidence, 'prepared.json'), JSON.stringify({ ...report, gatewayStarted: false }, null, 2));
  console.log(JSON.stringify({ evidence, gatewayStarted: false }));
  process.exit(0);
}

const db = new DatabaseSync(':memory:');
db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,pinned INTEGER DEFAULT 0,
 cwd TEXT NOT NULL,execution_mode TEXT,permission_mode TEXT,active_skill_ids TEXT,agent_id TEXT,model_ref TEXT,source TEXT,
 native_session_key TEXT,native_parent_session_id TEXT,forked_from_session_id TEXT,forked_from_session_title TEXT,
 forked_from_entry_id TEXT,handoff_from_session_id TEXT,handoff_from_session_title TEXT,handoff_request_id TEXT,
 group_id TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE cowork_config(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
 CREATE TABLE cowork_session_runs(id TEXT PRIMARY KEY,session_id TEXT,client_turn_id TEXT UNIQUE,root_run_id TEXT,model_ref TEXT,
 state TEXT,started_at INTEGER,accepted_at INTEGER,ended_at INTEGER,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE history_session_bindings(session_id TEXT PRIMARY KEY,session_key TEXT,native_session_id TEXT,availability TEXT);
`);
const store = new host.CoworkStore(db);
const adapter = new host.OpenClawRuntimeAdapter(store, { getAppStartedAtMs: () => Date.now() });
const router = new host.CoworkEngineRouter({ openclawRuntime: adapter });
const launch = new host.AgentTeamLaunchCoordinator({ getStore: () => store, getDatabase: () => db,
  getRouter: () => router, requestGateway: (method, params) => adapter.requestGateway(method, params) });
adapter.on('error', () => {});
router.on('error', () => {});
const methods = [], originalFrames = [], deliveredFrames = [], responses = [], terminals = new Map();
const cleanupErrors = [];
let client, transport, child, primaryFailure, providerFailure, captureKey, pendingGate;
let modelRequests = 0, output = '';
const model = createServer(async (request, response) => {
  try {
    for await (const chunk of request) { void chunk; }
    modelRequests += 1;
    assert.ok(modelRequests <= 5, 'One ordinary warmup, three bounded Team passes and one custom source request');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture-admission', object: 'chat.completion.chunk', choices: [{ index: 0,
      delta: { role: 'assistant', content: 'SYNTHETIC_MAIN_ADMISSION_REPLY' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { providerFailure = error; if (!response.headersSent) response.writeHead(500); response.end('Fixture failed'); }
});
const shutdown = new host.GatewayProcessShutdown(() => {});
const changedEnvironment = [...new Set([...Object.keys(process.env).filter(key => /^OPENCLAW_/i.test(key)),
  'OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'])];
const previousEnvironment = Object.fromEntries(changedEnvironment.map(key => [key, process.env[key]]));
async function until(predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (providerFailure) throw providerFailure;
    if (child) { assert.equal(child.exitCode, null, label + ': Gateway exited'); assert.equal(child.signalCode, null); }
    assert.ok(Date.now() < deadline, label + ': timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function deliver(frame) {
  assert.ok(originalFrames.includes(frame), 'Only an actually received native frame may be delivered');
  const before = hash(JSON.stringify(frame));
  adapter.handleGatewayEvent(frame);
  // This probe isolates admission from the independent periodic Goal inventory owner.
  adapter.cancelGoalRecovery();
  assert.equal(hash(JSON.stringify(frame)), before, 'The production event handler must not mutate the native frame');
  deliveredFrames.push({ hash: before, event: frame.event, reason: frame.payload?.reason,
    key: frame.payload?.session?.key ?? frame.payload?.key });
}
async function request(method, params, options) {
  methods.push({ method, key: params?.key ?? params?.sessionKey });
  assert.notEqual(method, 'sessions.list', 'This Main send-admission fixture must not scan the global roster');
  const result = await client.request(method, params, options);
  if (method === 'sessions.describe') {
    responses.push({ key: params.key, agentId: params.agentId, sessionId: result.session?.sessionId,
      lifecycleRevision: result.session?.lifecycleRevision,
      lifecycleRevisionPresent: Object.hasOwn(result.session ?? {}, 'lifecycleRevision'),
      lifecycleRevisionType: result.session?.lifecycleRevision === null ? 'null' : typeof result.session?.lifecycleRevision,
      hasActiveRun: result.session?.hasActiveRun, hasActiveRunType: typeof result.session?.hasActiveRun,
      hasActiveSubagentRun: result.session?.hasActiveSubagentRun,
      hasActiveSubagentRunPresent: Object.hasOwn(result.session ?? {}, 'hasActiveSubagentRun') });
    if (pendingGate && pendingGate.key === params.key) {
      const gate = pendingGate;
      await until(() => gate.frame, 'authentic delayed create frame', 10_000);
      pendingGate = undefined;
      assert.ok(adapter.targetedSessionStatusChecks.get(params.key)?.size > 0,
        'The real Adapter must have an in-flight point reader before the authentic event arrives');
      deliver(gate.frame);
      assert.equal(adapter.targetedSessionStatusChecks.has(params.key), false,
        'The authentic create publication must retire the first point reader');
      gate.afterDelivery?.();
    }
  }
  return result;
}
async function capturePreparation(source) {
  const key = host.buildManagedSessionKey(source.id, source.agentId);
  captureKey = key;
  const gate = { key };
  pendingGate = gate;
  const prepared = await router.prepareSession(source.id);
  assert.equal(prepared.sessionKey, key);
  assert.equal(store.getSession(source.id).nativeSessionKey, undefined, 'Normal preparation must retain the actual product shape');
  assert.equal(store.getSession(source.id).historyBinding, undefined);
  return { key, prepared, gate };
}
function sourceWithCompletedMetadata(agentId) {
  const source = store.createSession('Synthetic historical source', workspace, 'local', [], agentId, 'ask');
  const previous = store.beginSessionRun({ sessionId: source.id, clientTurnId: randomUUID(), startedAt: Date.now() - 1000 });
  store.finishSessionRun(previous.id, 'completed', Date.now() - 500);
  assert.equal(store.getSession(source.id).status, 'idle');
  assert.equal(store.getSessionRuns(source.id)[0].state, 'completed');
  return source;
}
async function nativeIdle(sourceId, nativeSessionId, lifecycleRevision) {
  let last;
  await until(async () => {
    last = await router.getSessionRuntimeStatus(sourceId, { targeted: true, includeSubagents: true,
      expectedSessionId: nativeSessionId, expectedLifecycleRevision: lifecycleRevision });
    assert.equal(last.known, true, 'Unknown cleanup observation is not an idle receipt');
    if (last.running || last.mainRunning || last.subagentRunning) {
      await new Promise(resolve => setTimeout(resolve, 250));
      return false;
    }
    return true;
  }, 'native exact-identity dispatcher cleanup');
  return last;
}
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const token = randomBytes(24).toString('hex');
  const configPath = path.join(stateDir, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify({
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    update: { checkOnStart: false, auto: { enabled: false } },
    agents: { ownership: 'explicit', entries: { main: {}, researcher: {} }, defaults: { workspace, skipBootstrap: true,
      systemAgent: { agentId: 'main' }, embeddedAgent: { cyberFailover: { mode: 'off' } }, heartbeat: { every: '0m' },
      model: { primary: 'fixture/answer' }, modelPolicy: { allow: ['fixture/answer'] } } },
    models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: { fixture: {
      baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic-fixture-key', api: 'openai-completions',
      request: { allowPrivateNetwork: true }, models: [{ id: 'answer', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    } } }, plugins: { slots: { memory: 'none' }, allow: ['runtime-services', 'automation-permission', 'agent-team'],
      load: { paths: ['runtime-services', 'automation-permission', 'agent-team'].map(id => path.join(runtime, 'dist/extensions', id)) },
      entries: { 'runtime-services': { enabled: true }, 'automation-permission': { enabled: true }, 'agent-team': { enabled: true } } },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(OPENCLAW_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
  Object.assign(env, { OPENCLAW_HOME: stateDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_DISABLE_BONJOUR: '1',
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtime, 'dist/extensions') });
  for (const key of changedEnvironment) delete process.env[key];
  for (const key of ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH']) process.env[key] = env[key];
  child = spawn(process.execPath, ['--require', host.ensureGatewayShutdownPreload(stateDir),
    path.join(runtime, 'gateway-launcher.cjs'), 'gateway', 'run', '--allow-unconfigured', '--port', String(port)],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString().replaceAll(token, '<fixture-token>'); });
  shutdown.observe(child);
  report.gatewayPid = child.pid;
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/startupz`,
    { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 'native startup readiness', 120_000);
  const owners = fs.readdirSync(path.join(runtime, 'dist')).filter(name => /^client-.*\.mjs$/.test(name) &&
    fs.readFileSync(path.join(runtime, 'dist', name), 'utf8').includes('GatewayClient as t'));
  assert.equal(owners.length, 1);
  const { t: GatewayClient } = await import(pathToFileURL(path.join(runtime, 'dist', owners[0])).href);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native Main handshake timed out')), 90_000);
    client = new GatewayClient({ env, url: `ws://127.0.0.1:${port}`, token, clientName: 'gateway-client', mode: 'backend',
      scopes: ['operator.admin', 'operator.read', 'operator.write'], onHelloOk: () => { clearTimeout(timer); resolve(); },
      onEvent: frame => {
        originalFrames.push(frame);
        const key = frame.payload?.session?.key ?? frame.payload?.key ?? frame.payload?.sessionKey;
        if (frame.event === 'sessions.changed' && frame.payload?.reason === 'create' && key === captureKey && pendingGate && !pendingGate.frame)
          pendingGate.frame = frame;
        else deliver(frame);
        if (frame.event === 'agent' && frame.payload?.stream === 'lifecycle' && frame.payload?.data?.executionSettled === true &&
          ['end', 'error'].includes(frame.payload?.data?.phase)) terminals.set(frame.payload.runId, frame.payload);
        if (frame.event === 'agent') launch.observeExecution(frame.payload);
      } });
    transport = { request, stop: () => client.stop(), start: () => client.start() };
    adapter.gatewayClient = transport;
    adapter.gatewayClientGeneration = 1;
    client.start();
  });
  await request('sessions.subscribe', {});
  child.send(host.GATEWAY_READY_MESSAGE);
  progress('ready');
  if (baselineStatus) {
    const source = sourceWithCompletedMetadata('main');
    const { key, prepared } = await capturePreparation(source);
    const before = responses.length;
    const status = await baselineStatus.call(adapter.runtimeSessionStatusContext, source.id,
      { targeted: true, includeSubagents: true });
    assert.equal(status.known, false, 'The original production reader deterministically loses its event token');
    assert.equal(responses.length - before, 1);
    report.checks.push({ path: 'original-main-event-window', key, nativeSessionId: prepared.gatewaySessionId,
      known: false, describeRequests: 1 });
    progress('baseline-unknown', { describeRequests: 1 });
  }
  for (const agentId of ['main', 'researcher']) {
    const source = sourceWithCompletedMetadata(agentId);
    let historicalNativeId;
    if (agentId === 'main') {
      const ordinary = await router.prepareSession(source.id);
      const ordinaryRun = randomUUID(), ordinaryPrompt = 'SYNTHETIC_PRIOR_ORDINARY_HISTORY';
      const timing = store.beginSessionRun({ sessionId: source.id, clientTurnId: ordinaryRun, startedAt: Date.now() });
      await adapter.requestGateway('chat.send', { sessionKey: ordinary.sessionKey, sessionId: ordinary.gatewaySessionId,
        idempotencyKey: ordinaryRun, message: ordinaryPrompt });
      await until(() => terminals.has(ordinaryRun), 'prior ordinary exact whole terminal');
      const whole = terminals.get(ordinaryRun);
      assert.equal(whole.sessionKey, ordinary.sessionKey); assert.equal(whole.sessionId, ordinary.gatewaySessionId);
      assert.equal(whole.data.executionSettled, true); assert.equal(whole.data.phase, 'end');
      const history = await adapter.requestGateway('chat.history', { sessionKey: ordinary.sessionKey });
      assert.equal(history.sessionId, ordinary.gatewaySessionId);
      assert.ok(JSON.stringify(history.messages).includes(ordinaryPrompt));
      store.finishSessionRun(timing.id, 'completed', Date.now());
      await nativeIdle(source.id, ordinary.gatewaySessionId);
      historicalNativeId = ordinary.gatewaySessionId;
      report.checks.push({ path: 'actual-prior-ordinary-history', key: ordinary.sessionKey,
        nativeSessionId: ordinary.gatewaySessionId, runId: ordinaryRun, executionSettled: true, nativeHistoryVerified: true });
      progress('prior-ordinary-history-and-cleanup', { agentId });
    }
    const { key, prepared } = await capturePreparation(source);
    if (historicalNativeId) assert.equal(prepared.gatewaySessionId, historicalNativeId,
      'Preparing an existing native history must preserve its physical session');
    progress('prepared', { agentId });
    const before = responses.length;
    const status = await router.getSessionRuntimeStatus(source.id, { targeted: true, includeSubagents: true });
    assert.deepEqual(status, { known: true, mainRunning: false, subagentRunning: false, running: false });
    const current = responses.slice(before);
    assert.equal(current.length, 2, 'One event-only reobservation must remain bounded to two exact reads');
    assert.equal(current[0].key, key); assert.equal(current[1].key, key);
    assert.equal(current[0].agentId, agentId); assert.equal(current[1].agentId, agentId);
    assert.equal(current[0].sessionId, prepared.gatewaySessionId);
    assert.equal(current[1].sessionId, current[0].sessionId);
    assert.equal(current[1].lifecycleRevision, current[0].lifecycleRevision);
    progress('exact-reobserved', { agentId, describeRequests: 2,
      lifecycleRevisionPresent: current[0].lifecycleRevisionPresent, lifecycleRevisionType: current[0].lifecycleRevisionType });
    const runId = randomUUID();
    const prompt = agentId === 'main'
      ? host.appendAgentTeamInstruction('SYNTHETIC_MAIN_ADMISSION_main', 'task')
      : 'SYNTHETIC_MAIN_ADMISSION_researcher';
    const beforeModel = modelRequests;
    let launchReceipt;
    if (agentId === 'main') {
      launchReceipt = await launch.register({ sessionId: source.id, clientTurnId: runId, prompt });
      assert.equal(launchReceipt.registerAcknowledged, true);
      assert.equal(launchReceipt.nativeSessionId, prepared.gatewaySessionId);
      launch.markSubmissionStarted(source.id, runId);
      progress('team-registered', { agentId });
    }
    const sent = await adapter.requestGateway('chat.send', { sessionKey: key, sessionId: prepared.gatewaySessionId,
      idempotencyKey: runId, message: prompt });
    assert.equal(sent.runId, runId);
    progress('sent', { agentId });
    await until(() => terminals.has(runId), 'exact actual Main source whole terminal');
    const whole = terminals.get(runId);
    assert.equal(whole.sessionKey, key); assert.equal(whole.sessionId, prepared.gatewaySessionId);
    assert.equal(whole.data.executionSettled, true); assert.equal(whole.data.phase, 'end');
    progress('whole', { agentId });
    const history = await adapter.requestGateway('chat.history', { sessionKey: key });
    assert.equal(history.sessionId, prepared.gatewaySessionId);
    assert.ok(JSON.stringify(history.messages).includes(`SYNTHETIC_MAIN_ADMISSION_${agentId}`));
    assert.ok(JSON.stringify(history.messages).includes('SYNTHETIC_MAIN_ADMISSION_REPLY'));
    assert.equal(modelRequests - beforeModel, agentId === 'main' ? 3 : 1);
    progress('history', { agentId });
    await nativeIdle(source.id, prepared.gatewaySessionId, current[0].lifecycleRevision);
    progress('native-cleanup-idle', { agentId });
    if (launchReceipt) assert.equal(await launch.releaseIfSettled(source.id), true,
      'A real admitted Team launch releases only after its exact terminal and native input custody proof');
    if (launchReceipt) progress('team-released', { agentId });
    report.checks.push({ path: 'actual-main-admission', agentId, key, nativeSessionId: prepared.gatewaySessionId,
      lifecycleRevision: current[0].lifecycleRevision, lifecycleRevisionPresent: current[0].lifecycleRevisionPresent,
      lifecycleRevisionType: current[0].lifecycleRevisionType, describeRequests: 2, runId, executionSettled: true,
      historyVerified: true, actualTeamLaunchRegisteredAndReleased: !!launchReceipt });
  }
  for (const kind of ['generation', 'client']) {
    const source = sourceWithCompletedMetadata('main');
    const { key, gate } = await capturePreparation(source);
    const before = responses.length;
    gate.afterDelivery = () => { if (kind === 'generation') adapter.gatewayClientGeneration += 1;
      else adapter.gatewayClient = { ...transport }; };
    const status = await router.getSessionRuntimeStatus(source.id, { targeted: true, includeSubagents: true });
    assert.equal(status.known, false); assert.equal(responses.length - before, 1);
    adapter.gatewayClient = transport; adapter.gatewayClientGeneration = 1;
    report.checks.push({ path: 'retired-' + kind, key, known: false, describeRequests: 1 });
  }
  const source = sourceWithCompletedMetadata('main');
  const { key, prepared } = await capturePreparation(source);
  await until(() => pendingGate?.frame, 'authentic create frame before identity negative');
  deliver(pendingGate.frame); pendingGate = undefined;
  const before = methods.length;
  const wrong = await router.getSessionRuntimeStatus(source.id, { targeted: true, includeSubagents: true, expectedSessionId: randomUUID() });
  assert.equal(wrong.known, false);
  assert.deepEqual(methods.slice(before).map(row => row.method), ['sessions.describe']);
  report.checks.push({ path: 'expected-native-identity', key, nativeSessionId: prepared.gatewaySessionId, known: false, mutations: 0 });
  assert.equal(modelRequests, 5);
  assert.ok(!methods.some(row => row.method === 'sessions.list'));
  report.verified = true;
} catch (error) { primaryFailure = error; }
finally {
  progress('cleanup-start');
  adapter.cancelGoalRecovery(); adapter.stopTickWatchdog(); adapter.cancelGatewayReconnect();
  const joined = await Promise.allSettled([child ? shutdown.stop(child) : Promise.resolve(),
    client ? client.stopAndWait() : Promise.resolve()]);
  for (const result of joined) if (result.status === 'rejected') cleanupErrors.push(result.reason);
  try { db.close(); } catch (error) { cleanupErrors.push(error); }
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  for (const key of changedEnvironment) {
    if (previousEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[key];
  }
  report.cleanClose = !!child && !shutdown.failure && child.exitCode === 0 && child.signalCode === null && cleanupErrors.length === 0;
  report.gatewayExit = child ? { code: child.exitCode, signal: child.signalCode, joined: true } : null;
  report.modelRequests = modelRequests; report.methods = methods; report.deliveredFrames = deliveredFrames; report.responses = responses;
  if (primaryFailure) report.failure = String(primaryFailure.stack ?? primaryFailure);
  fs.writeFileSync(path.join(evidence, 'gateway.log'), output);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, verified: report.verified, cleanClose: report.cleanClose,
    ...(primaryFailure ? { failure: String(primaryFailure.message ?? primaryFailure) } : {}) }));
}
if (primaryFailure || cleanupErrors.length) throw new AggregateError(
  [...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors], 'Actual Main send admission failed or did not close cleanly');
