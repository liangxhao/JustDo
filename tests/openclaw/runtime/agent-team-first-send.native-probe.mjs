// Host/native boundary regression. Only synthetic prompts and a loopback fixture model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parse } from 'acorn';

const require = createRequire(import.meta.url);
const expectedVersion = `v${require('../../../package.json').openclaw.version.replace(/^v/u, '')}`;
const shutdownPolicy = require('../../../src/shared/app/shutdownPolicy.json');
const { GATEWAY_READY_MESSAGE } = require('../../../src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs');
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const runtime = fs.realpathSync(process.argv[2] ?? path.join(repository, 'vendor/openclaw-runtime/current'));
const { verifyOpenClawPatchManifest, verifyFrozenOpenClawRuntime } = require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');
const archivedDiagnostic = process.argv.includes('--archived-diagnostic');
const manifest = archivedDiagnostic
  ? verifyFrozenOpenClawRuntime(runtime, { expectedVersion, requireBundle: true }).manifest
  : verifyOpenClawPatchManifest(runtime, { repoRoot: repository, expectedVersion, requireBundle: true });
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(runtime, 'node-runtime/node.exe')));
const nativeLaunchGuard = parse(fs.readFileSync(path.join(runtime, 'dist/extensions/runtime-services/index.js'), 'utf8'),
  { ecmaVersion: 'latest', sourceType: 'module' });
const correctionDeclarations = nativeLaunchGuard.body.flatMap(statement =>
  statement.type === 'VariableDeclaration' ? statement.declarations.filter(declaration =>
    declaration.id.type === 'Identifier' && declaration.id.name === 'MAX_CORRECTIONS') : []);
assert.equal(correctionDeclarations.length, 1, 'The actual native launch correction budget must have one owner.');
assert.equal(correctionDeclarations[0].init?.type, 'Literal');
assert.equal(correctionDeclarations[0].init.value, 2, 'The locked native launch guard allows two correction passes.');
const modelRequestsPerMode = 1 + correctionDeclarations[0].init.value;
const evidenceRoot = path.join(repository, '.agent-tasks/runtime/agent-team-first-send');
fs.mkdirSync(evidenceRoot, { recursive: true });
const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'probe-'));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-first-send-'));
const workspace = path.join(stateDir, 'workspace');
fs.mkdirSync(workspace);
const compiled = path.join(evidence, 'host.cjs');
await build({ stdin: { contents: `
export { AgentTeamLaunchCoordinator } from './plugins/extensions/agent-team/host/launch/agentTeamLaunchCoordinator';
export { appendAgentTeamInstruction } from './plugins/extensions/agent-team/prompt/agentTeamPrompt';
export { buildCoworkSessionKey } from './plugins/extensions/runtime-services/contracts/session-key';
export { getSessionRuntimeStatus, invalidateTargetedSessionStatusChecks } from './src/main/engine/openclaw/runtimeSessionStatus';
export { ensureGatewayShutdownPreload, OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE } from './src/main/openclaw/runtime/launch/openclawLauncher';
`, resolveDir: repository, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: compiled });
const host = require(compiled);
const token = randomBytes(24).toString('hex');
let modelRequests = 0;
const model = createServer(async (request, response) => {
  for await (const chunk of request) { void chunk; /* Consume only synthetic input; never log it. */ }
  modelRequests += 1;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id: 'fixture-reply', object: 'chat.completion.chunk', choices: [{ index: 0,
    delta: { role: 'assistant', content: 'FIXTURE_FIRST_SEND_COMPLETE' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const portReservation = net.createServer();
await new Promise(resolve => portReservation.listen(0, '127.0.0.1', resolve));
const port = portReservation.address().port;
await new Promise(resolve => portReservation.close(resolve));
const configPath = path.join(stateDir, 'openclaw.json');
fs.writeFileSync(configPath, JSON.stringify({
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: { ownership: 'explicit', entries: { alice: {} }, defaults: { workspace, skipBootstrap: true,
    embeddedAgent: { cyberFailover: { mode: 'off' } },
    heartbeat: { every: '0m' }, systemAgent: { agentId: 'alice' }, model: { primary: 'fixture/answer' },
    modelPolicy: { allow: ['fixture/answer'] } } },
  models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: { fixture: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic-fixture-key', api: 'openai-completions',
    request: { allowPrivateNetwork: true }, models: [{ id: 'answer', name: 'Fixture', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  } } },
  plugins: { slots: { memory: 'none' }, allow: ['runtime-services', 'agent-team'],
    load: { paths: ['runtime-services', 'agent-team'].map(id => path.join(runtime, 'dist/extensions', id)) }, entries: {
    'runtime-services': { enabled: true }, 'agent-team': { enabled: true },
  } },
}));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCLAW_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
Object.assign(env, { OPENCLAW_HOME: stateDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_DISABLE_BONJOUR: '1',
  OPENCLAW_DEBUG: '1',
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtime, 'dist/extensions') });
for (const key of ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH']) process.env[key] = env[key];
const child = spawn(process.execPath, ['--require', host.ensureGatewayShutdownPreload(stateDir),
  path.join(runtime, 'gateway-launcher.cjs'), 'gateway', 'run', '--allow-unconfigured', '--port', String(port)],
{ env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
const checks = new Map();
let client;
let coordinator;
let completed = false;
let expectedTerminal;
let terminalPhase;
let source;
let failDescribe = false;
let primaryFailure;
const cleanupErrors = [];
const methods = [];
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)');
const report = { manifestSha256: createHash('sha256').update(fs.readFileSync(path.join(runtime, 'runtime-patch-manifest.json'))).digest('hex'),
  openclawVersion: manifest.openclawVersion, stateDir, verified: false, checks: [],
  scope: archivedDiagnostic
    ? 'current host and archived native artifact; excludes current recipe, final artifact, model-organized peers and desktop UI'
    : 'production host first-send admission and native chat with loopback model; excludes model-organized peers and desktop UI' };
async function waitFor(predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(label + ': Gateway exited');
    assert.ok(Date.now() < deadline, label + ': timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
try {
  // Main connects only after native startup admission. Creating the SDK's
  // device-auth store during first bootstrap would add a competing DB writer.
  const startupDeadline = Date.now() + 120_000;
  while (true) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Native fixture exited before startup readiness: ' + child.exitCode);
    let ready = false;
    try { ready = (await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { /* Read-only readiness can be retried before creating the client. */ }
    if (ready) break;
    assert.ok(Date.now() < startupDeadline, 'Native fixture startup readiness timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const clientFile = fs.readdirSync(path.join(runtime, 'dist')).find(file => /^client-.*\.mjs$/.test(file) &&
    fs.readFileSync(path.join(runtime, 'dist', file), 'utf8').includes('GatewayClient as t'));
  assert.ok(clientFile);
  const { t: GatewayClient } = await import(pathToFileURL(path.join(runtime, 'dist', clientFile)).href);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native fixture handshake timed out')), 90_000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Native fixture exited before handshake: ' + code)); });
    client = new GatewayClient({ env, url: `ws://127.0.0.1:${port}`, token, clientName: 'gateway-client', mode: 'backend',
      scopes: ['operator.admin'], onHelloOk: () => { clearTimeout(timer); resolve(); },
      onEvent: frame => {
        if (frame.event === 'sessions.changed') host.invalidateTargetedSessionStatusChecks(checks, frame.payload);
        if (frame.event === 'agent') {
          coordinator?.observeExecution(frame.payload);
          if (expectedTerminal && frame.payload?.sessionKey === expectedTerminal.sessionKey &&
              frame.payload?.sessionId === expectedTerminal.nativeSessionId && frame.payload?.runId === expectedTerminal.clientTurnId &&
              frame.payload?.stream === 'lifecycle' && frame.payload?.data?.executionSettled === true &&
              ['end', 'error'].includes(frame.payload?.data?.phase)) {
            completed = true;
            terminalPhase = frame.payload.data.phase;
          }
        }
      } });
    client.start();
  });
  child.send(GATEWAY_READY_MESSAGE);
  const request = async (method, params) => {
    methods.push(method);
    if (method === 'sessions.describe' && failDescribe) throw new Error('Synthetic native status unavailable');
    return client.request(method, params);
  };
  const context = { store: { getSession: id => id === source?.id ? source : null, getSessionRuns: () => [] },
    ensureGatewayClientReady: async () => {}, gatewayClient: { request }, gatewayClientGeneration: 1,
    targetedSessionStatusChecks: checks, unknownSessionRuns: new Map(), disconnectedSessionIds: new Set(),
    disconnectedRecoveryPromises: new Map(), goalContinuationCoordinator: { getSnapshot: () => null },
    isSessionActive: () => false, compactionInFlightSessionIds: new Set(),
    getSessionRuntimeStatuses: () => { throw new Error('First send must not scan the historical roster'); } };
  const router = { getSessionRuntimeStatus: (id, options) => host.getSessionRuntimeStatus.call(context, id, options),
    prepareSession: async id => {
      const key = host.buildCoworkSessionKey(id, 'alice');
      const created = await request('sessions.create', { key, cwd: workspace, permissionMode: 'guarded' });
      source.nativeSessionKey = key;
      return { sessionKey: key, gatewaySessionId: created.entry.sessionId };
    } };
  const store = { ...context.store, getSessionByNativeKey: () => null, getGoalExecutionSnapshot: () => null,
    getSessionRunByClientTurnId: () => null };
  coordinator = new host.AgentTeamLaunchCoordinator({ getStore: () => store, getDatabase: () => db,
    getRouter: () => router, requestGateway: request });
  for (const mode of ['task', 'group']) {
    const modelRequestsBefore = modelRequests;
    source = { id: randomUUID(), agentId: 'alice', cwd: workspace, permissionMode: 'ask', executionMode: 'sandbox', status: 'idle' };
    const clientTurnId = randomUUID();
    const prompt = host.appendAgentTeamInstruction('Synthetic first-send boundary check.', mode);
    const receipt = await coordinator.register({ sessionId: source.id, clientTurnId, prompt });
    assert.equal(receipt.registerAcknowledged, true);
    assert.ok(!methods.includes('sessions.list'));
    coordinator.markSubmissionStarted(source.id, clientTurnId);
    completed = false;
    expectedTerminal = receipt;
    await request('chat.send', { sessionKey: receipt.sessionKey, message: prompt, idempotencyKey: clientTurnId });
    await waitFor(() => completed, 'exact native execution terminal');
    assert.equal(terminalPhase, 'end');
    const history = await request('chat.history', { sessionKey: receipt.sessionKey });
    assert.ok(JSON.stringify(history).includes('FIXTURE_FIRST_SEND_COMPLETE'));
    assert.equal(modelRequests - modelRequestsBefore, modelRequestsPerMode,
      'A synthetic reply without Team operations must use the actual bounded launch corrections.');
    report.checks.push({ mode, firstSendAccepted: true, exactTerminalObserved: true, nativeHistoryVerified: true,
      sessionKey: receipt.sessionKey, nativeSessionId: receipt.nativeSessionId, runId: receipt.clientTurnId,
      phase: terminalPhase, executionSettled: true, modelRequests: modelRequests - modelRequestsBefore });
  }
  source = { id: randomUUID(), agentId: 'alice', cwd: workspace, permissionMode: 'ask', executionMode: 'sandbox', status: 'idle' };
  failDescribe = true;
  const mutationCount = methods.filter(method => ['sessions.create', 'agentTeam.launch.register', 'chat.send'].includes(method)).length;
  await assert.rejects(coordinator.register({ sessionId: source.id, clientTurnId: randomUUID(),
    prompt: host.appendAgentTeamInstruction('Synthetic unknown-status negative check.', 'task') }), /teamFeatureStatusUnknown/);
  assert.equal(methods.filter(method => ['sessions.create', 'agentTeam.launch.register', 'chat.send'].includes(method)).length, mutationCount);
  report.checks.push({ unknownStatusRefusedBeforeMutation: true });
  assert.equal(modelRequests, modelRequestsPerMode * 2);
  report.verified = true;
} catch (error) {
  primaryFailure = error;
} finally {
  // Native device-auth drain may wait for Gateway retirement. Join both owners concurrently.
  const closingClient = client ? client.stopAndWait() : Promise.resolve();
  closingClient.catch(() => {});
  let forced = false;
  try {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      const timer = setTimeout(() => { forced = true; child.kill(); }, shutdownPolicy.nativeShutdownMs +
        shutdownPolicy.nativeExitMarginMs + shutdownPolicy.forceExitObservationMs);
      try {
        child.send(host.OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE, error => { if (error) cleanupErrors.push(error); });
      } catch (error) { cleanupErrors.push(error); }
      try { const [code, signal] = await closed; assert.equal(code, 0); assert.equal(signal, null); }
      finally { clearTimeout(timer); }
    } else { assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null); }
  } catch (error) { cleanupErrors.push(error); }
  try { await closingClient; } catch (error) { cleanupErrors.push(error); }
  try { db.close(); } catch (error) { cleanupErrors.push(error); }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  fs.writeFileSync(path.join(evidence, 'gateway.log'), output.replaceAll(token, '<fixture-token>'));
  report.modelRequests = modelRequests;
  report.cleanClose = !forced && child.exitCode === 0 && child.signalCode === null;
  if (primaryFailure) report.failure = String(primaryFailure.message ?? primaryFailure);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, ...report }));
  if (forced) cleanupErrors.push(new Error('Forced retirement cannot certify a clean fixture shutdown.'));
}
if (primaryFailure || cleanupErrors.length)
  throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors],
    'Native first-send probe failed or did not close cleanly.');
