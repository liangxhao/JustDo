// Actual Renderer controller/client and native wire; all inputs and state are synthetic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { WebSocket as RelaySocket, WebSocketServer } from 'ws';

import { verifyCollaborationExtensionAssembly } from './extension-assembly-contract.mjs';
import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const { runtimeRoot: runtime, identity } = resolveNativeSmokeTarget(process.argv[2]);
const assembly = verifyCollaborationExtensionAssembly(runtime);
const require = createRequire(import.meta.url);
const prepareOnly = process.argv.includes('--prepare-only');
assert.ok(process.argv.slice(3).every(argument => argument === '--prepare-only'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const evidenceRoot = path.join(repository, '.agent-tasks/runtime/collaboration-main-send');
fs.mkdirSync(evidenceRoot, { recursive: true });
const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'probe-'));
const compiled = path.join(evidence, 'controller.cjs');
const compilation = await build({ stdin: { contents: `
export { ChatController } from './src/renderer/libs/openclaw-chat/gateway/chat-controller';
export { dispatchInitialTurn } from './src/renderer/libs/openclaw-chat/gateway/input/initial-turn-dispatch';
export { GatewayProcessShutdown } from './src/main/openclaw/runtime/launch/gatewayProcessShutdown';
export { ensureGatewayShutdownPreload } from './src/main/openclaw/runtime/launch/openclawLauncher';
export { GATEWAY_READY_MESSAGE } from './src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs';
`, resolveDir: repository, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
  target: 'node24', outfile: compiled, metafile: true,
  define: { 'import.meta.env': '{}' }, logOverride: { 'empty-import-meta': 'silent' },
  tsconfig: path.join(repository, 'tsconfig.json') });
const storage = new Map();
// Browser ambient ports only. There is no Electron, product Store or RPC stub.
globalThis.localStorage = { getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); }, removeItem: key => { storage.delete(key); } };
globalThis.window = { localStorage: globalThis.localStorage };
const production = require(compiled);
const controller = new production.ChatController();
assert.equal(controller.state.connected, false);
assert.equal(typeof controller.sendMessage, 'function');
const sourceInputs = Object.keys(compilation.metafile.inputs).filter(relative => !relative.startsWith('<')).sort().map(relative => ({
  path: relative.replaceAll('\\', '/'), sha256: hash(fs.readFileSync(path.resolve(repository, relative))),
}));
const manifestSha256 = hash(fs.readFileSync(path.join(runtime, 'runtime-patch-manifest.json')));
const report = { ...identity, assembly, manifestSha256, compiledControllerSha256: hash(fs.readFileSync(compiled)),
  sourceInputs, checks: [], verified: false, cleanClose: false,
  scope: 'Actual production Renderer ChatController, GatewayClient, initialization/history and initial-dispatch functions with real native wire. No DOM, React, Main IPC, user profile or business-model quality claim.' };
if (prepareOnly) {
  controller.disconnect();
  fs.writeFileSync(path.join(evidence, 'prepared.json'), JSON.stringify({ ...report,
    gatewayStarted: false, actualControllerConstructed: true }, null, 2));
  console.log(JSON.stringify({ evidence, gatewayStarted: false, actualControllerConstructed: true, inputCount: sourceInputs.length }));
  process.exit(0);
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-main-send-'));
const workspace = path.join(stateDir, 'workspace');
fs.mkdirSync(workspace);
const token = randomBytes(24).toString('hex');
let modelRequests = 0;
let providerFailure;
const model = createServer(async (request, response) => {
  try {
    for await (const chunk of request) assert.ok(chunk.byteLength > 0);
    modelRequests += 1;
    assert.ok(modelRequests <= 10, 'The deterministic fixture must not start an unbounded model loop.');
    await new Promise(resolve => setTimeout(resolve, 50));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'synthetic-reply', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'SYNTHETIC_MAIN_REPLY' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    providerFailure = error;
    response.destroy();
  }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(proxy, 'listening');
const viewerOrigin = `http://127.0.0.1:${proxy.address().port}`;
const configPath = path.join(stateDir, 'openclaw.json');
fs.writeFileSync(configPath, JSON.stringify({
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token },
    controlUi: { allowedOrigins: [viewerOrigin] } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: { ownership: 'explicit', entries: { alice: {} }, defaults: { workspace, skipBootstrap: true,
    embeddedAgent: { cyberFailover: { mode: 'off' } }, heartbeat: { every: '0m' },
    systemAgent: { agentId: 'alice' }, model: { primary: 'fixture/answer' }, modelPolicy: { allow: ['fixture/answer'] } } },
  models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: { fixture: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic-fixture-key', api: 'openai-completions',
    request: { allowPrivateNetwork: true }, models: [{ id: 'answer', name: 'Fixture', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  } } }, plugins: { slots: { memory: 'none' }, allow: ['runtime-services'],
    load: { paths: [path.join(runtime, 'dist/extensions/runtime-services')] }, entries: { 'runtime-services': { enabled: true } } },
}));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(OPENCLAW_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
Object.assign(env, { OPENCLAW_HOME: stateDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_DISABLE_BONJOUR: '1',
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtime, 'dist/extensions') });
const changedEnvironment = ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'];
const previousEnvironment = Object.fromEntries(changedEnvironment.map(key => [key, process.env[key]]));
for (const key of changedEnvironment) process.env[key] = env[key];
const child = spawn(process.execPath, ['--require', production.ensureGatewayShutdownPreload(stateDir),
  path.join(runtime, 'gateway-launcher.cjs'), 'gateway', 'run', '--allow-unconfigured', '--port', String(port)],
{ env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
const shutdown = new production.GatewayProcessShutdown(() => {});
shutdown.observe(child);
const gatewayUrl = `ws://127.0.0.1:${port}`;
const relays = new Set();
const wireSends = [];
const wireMethods = [];
const handshakeFailures = [];
let acceptedHandshakes = 0;
let phase = 'idle';
let dropNextAcknowledgement = false;
const droppedAcknowledgements = [];
proxy.on('connection', front => {
  // Browser WebSockets carry their viewer Origin. Node's synthetic front has no
  // document, so its HTTP transport port supplies this actual loopback viewer.
  const back = new RelaySocket(gatewayUrl, { origin: viewerOrigin });
  relays.add(front); relays.add(back);
  const pending = [];
  const connectIds = new Set();
  let dropId;
  front.on('message', (data, binary) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'req') wireMethods.push({ method: frame.method, phase });
    if (frame.type === 'req' && frame.method === 'connect') connectIds.add(frame.id);
    if (frame.type === 'req' && frame.method === 'chat.send') {
      wireSends.push({ id: frame.id, params: frame.params });
      if (dropNextAcknowledgement) { dropId = frame.id; dropNextAcknowledgement = false; }
    }
    if (back.readyState === RelaySocket.OPEN) back.send(data, { binary });
    else pending.push([data, binary]);
  });
  back.on('open', () => { for (const [data, binary] of pending.splice(0)) back.send(data, { binary }); });
  back.on('message', (data, binary) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'res' && connectIds.has(frame.id) && frame.ok === false)
      handshakeFailures.push(frame.error);
    if (frame.type === 'res' && connectIds.has(frame.id) && frame.ok === true) acceptedHandshakes += 1;
    if (frame.type === 'res' && frame.id === dropId) {
      droppedAcknowledgements.push({ id: frame.id, ok: frame.ok });
      front.close(1012, 'synthetic acknowledgement loss');
      return;
    }
    if (front.readyState === RelaySocket.OPEN) front.send(data, { binary });
  });
  front.on('close', () => { relays.delete(front); back.close(); });
  back.on('close', () => { relays.delete(back); front.close(); });
  // Connection failure remains visible through the real client's socket close.
  front.on('error', () => {}); back.on('error', () => { front.close(1011); });
});
const terminals = new Map();
let observer;
let primaryFailure;
const cleanupErrors = [];
async function waitFor(predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (providerFailure) throw providerFailure;
    const rejected = handshakeFailures.find(error => error?.retryable !== true);
    if (rejected) throw new Error(`Native browser handshake rejected: ${rejected.code}`);
    assert.equal(child.exitCode, null, `${label}: native fixture exited`);
    assert.equal(child.signalCode, null, `${label}: native fixture signalled`);
    assert.ok(Date.now() < deadline, `${label}: timed out`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function connect(key) {
  phase = 'initialization';
  await controller.connect(`ws://127.0.0.1:${proxy.address().port}`, token, key);
  await waitFor(() => controller.state.connected && controller.state.initialHistoryReady &&
    !controller.state.historyReadFailed && !!controller.state.currentSessionId, 'production controller history initialization');
  phase = 'idle';
}
async function history(key, sid, prompt, requireAssistant = true) {
  const before = await observer.request('sessions.describe', { key });
  assert.equal(before.session?.sessionId, sid);
  const result = await observer.request('chat.history', { sessionKey: key });
  assert.equal(result.sessionId, sid);
  assert.ok(JSON.stringify(result.messages).includes(prompt));
  if (requireAssistant) assert.ok(JSON.stringify(result.messages).includes('SYNTHETIC_MAIN_REPLY'));
  assert.equal((await observer.request('sessions.describe', { key })).session?.sessionId, sid);
}
async function complete(runId, key, sid, prompt, allowError = false) {
  await waitFor(() => terminals.has(runId), 'exact native whole-run terminal');
  const terminal = terminals.get(runId);
  assert.equal(terminal.sessionKey, key); assert.equal(terminal.sessionId, sid);
  assert.equal(terminal.data.executionSettled, true);
  assert.ok(allowError ? ['end', 'error'].includes(terminal.data.phase) : terminal.data.phase === 'end');
  await history(key, sid, prompt, terminal.data.phase === 'end');
  return { runId, sessionKey: key, nativeSessionId: sid, phase: terminal.data.phase, executionSettled: true };
}
try {
  const deadline = Date.now() + 120_000;
  while (true) {
    let ready = false;
    try { ready = (await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Read-only startup polling. */ }
    if (ready) break;
    assert.ok(Date.now() < deadline && child.exitCode === null, 'Native startup admission did not finish');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const clients = fs.readdirSync(path.join(runtime, 'dist')).filter(name => /^client-.*\.mjs$/.test(name) &&
    fs.readFileSync(path.join(runtime, 'dist', name), 'utf8').includes('GatewayClient as t'));
  assert.equal(clients.length, 1);
  const { t: GatewayClient } = await import(pathToFileURL(path.join(runtime, 'dist', clients[0])).href);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native observer handshake timed out')), 90_000);
    observer = new GatewayClient({ env, url: gatewayUrl, token, clientName: 'gateway-client', mode: 'backend', scopes: ['operator.admin'],
      onHelloOk: () => { clearTimeout(timer); resolve(); }, onEvent: frame => {
        const event = frame.payload;
        if (frame.event === 'agent' && event?.stream === 'lifecycle' && event.data?.executionSettled === true &&
          ['end', 'error'].includes(event.data.phase)) terminals.set(event.runId, event);
      } });
    observer.start();
  });
  child.send(production.GATEWAY_READY_MESSAGE);
  const key = `agent:alice:justdo:${randomUUID()}`;
  const created = await observer.request('sessions.create', { key, cwd: workspace, permissionMode: 'guarded' });
  const sid = created.entry?.sessionId;
  assert.ok(sid);
  await connect(key);
  assert.equal(controller.state.currentSessionId, sid);
  for (const label of ['new-empty-session', 'same-key-next-turn']) {
    phase = label;
    const prompt = `SYNTHETIC_${label}`, runId = randomUUID(), count = wireSends.length;
    await controller.sendMessage(prompt, [], prompt, { propagateRequestFailure: true, expectedSessionKey: key, clientTurnId: runId });
    assert.equal(wireSends.length, count + 1);
    assert.equal(wireSends.at(-1).params.sessionId, sid);
    const terminal = await complete(runId, key, sid, prompt);
    await waitFor(() => !controller.state.chatSending, 'controller settles the visible turn');
    report.checks.push({ label, ...terminal, nativeHistoryVerified: true });
  }
  controller.disconnect();
  await connect(key);
  assert.ok(JSON.stringify(controller.state.chatMessages).includes('SYNTHETIC_same-key-next-turn'));
  const restoredRun = randomUUID(), restoredPrompt = 'SYNTHETIC_existing-history-controller';
  phase = 'existing-session-after-reconnect';
  await controller.sendMessage(restoredPrompt, [], restoredPrompt, { propagateRequestFailure: true, expectedSessionKey: key, clientTurnId: restoredRun });
  report.checks.push({ label: 'existing-session-after-reconnect', ...await complete(restoredRun, key, sid, restoredPrompt), nativeHistoryVerified: true });
  await waitFor(() => !controller.state.chatSending, 'reconnected controller settles');
  const dispatchRun = randomUUID(), dispatchPrompt = 'SYNTHETIC_initial-renderer-dispatch';
  phase = 'actual-initial-dispatch';
  let issued = 0;
  await production.dispatchInitialTurn(controller.state, { sessionKey: key, sessionId: sid,
    message: dispatchPrompt, deliver: false, justdoUserInitiated: true, idempotencyKey: dispatchRun }, () => { issued += 1; });
  assert.equal(issued, 1);
  report.checks.push({ label: 'actual-initial-dispatch', ...await complete(dispatchRun, key, sid, dispatchPrompt), nativeHistoryVerified: true });
  await waitFor(() => !controller.state.chatSending, 'initial dispatch settles');
  const beforeNegatives = wireSends.length;
  phase = 'local-negative-admission';
  await assert.rejects(production.dispatchInitialTurn(controller.state, { sessionKey: key, sessionId: randomUUID(),
    message: 'SYNTHETIC_rejected_sid', idempotencyKey: randomUUID() }), error => error.requestSent === false);
  await assert.rejects(controller.sendMessage('SYNTHETIC_rejected_key', [], undefined, { expectedSessionKey: 'different-key' }));
  controller.disconnect();
  await assert.rejects(controller.sendMessage('SYNTHETIC_disconnected'));
  assert.equal(wireSends.length, beforeNegatives);
  report.checks.push({ label: 'wrong-sid-key-and-disconnected-before-send', nativeSends: 0 });
  await connect(key);
  const unknownRun = randomUUID(), unknownPrompt = 'SYNTHETIC_unknown_ack';
  phase = 'unknown-acknowledgement-recovery';
  const beforeUnknown = wireSends.length;
  const unknownCalls = [];
  dropNextAcknowledgement = true;
  await assert.rejects(controller.sendMessage(unknownPrompt, [], unknownPrompt, {
    propagateRequestFailure: true, expectedSessionKey: key, clientTurnId: unknownRun,
    onRequestUnknown: runId => { unknownCalls.push(runId); },
  }));
  assert.deepEqual(unknownCalls, [unknownRun]);
  assert.equal(droppedAcknowledgements.length, 1);
  assert.equal(droppedAcknowledgements[0].ok, true);
  await complete(unknownRun, key, sid, unknownPrompt, true);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(wireSends.length, beforeUnknown + 1, 'Reconnect/history recovery must not replay unknown input');
  report.checks.push({ label: 'accepted-native-ack-lost', localOutcome: 'unknown', sends: 1, automaticReplays: 0 });
  assert.deepEqual(wireMethods.filter(row => row.method === 'sessions.list'), [],
    'Controller initialization, send, cleanup and recovery must not scan the global session roster');
  report.checks.push({ label: 'no-session-roster-during-send', initializationListRequests:
    wireMethods.filter(row => row.method === 'sessions.list' && row.phase === 'initialization').length,
    sendListRequests: 0 });
  if (providerFailure) throw providerFailure;
  report.verified = true;
} catch (error) { primaryFailure = error; }
finally {
  controller.disconnect();
  for (const socket of relays) socket.close();
  const closeProxy = new Promise(resolve => {
    const timer = setTimeout(() => {
      cleanupErrors.push(new Error('Synthetic relay did not close within its cleanup budget.'));
      for (const socket of relays) socket.terminate();
    }, 5000);
    proxy.close(error => { clearTimeout(timer); if (error) cleanupErrors.push(error); resolve(); });
  });
  const retirement = await Promise.allSettled([shutdown.stop(child), observer ? observer.stopAndWait() : Promise.resolve(), closeProxy]);
  for (const settled of retirement) if (settled.status === 'rejected') cleanupErrors.push(settled.reason);
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  for (const key of changedEnvironment) {
    if (previousEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[key];
  }
  report.cleanClose = !shutdown.failure && child.exitCode === 0 && child.signalCode === null && cleanupErrors.length === 0;
  report.modelRequests = modelRequests; report.wireSendCount = wireSends.length;
  report.wireMethods = wireMethods;
  report.handshakeFailures = handshakeFailures;
  report.browserHandshake = { viewerOrigin, originHeader: viewerOrigin, accepted: acceptedHandshakes };
  report.stateDir = stateDir;
  if (primaryFailure) report.failure = String(primaryFailure.message ?? primaryFailure);
  fs.writeFileSync(path.join(evidence, 'gateway.log'), output.replaceAll(token, '<fixture-token>'));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, verified: report.verified, cleanClose: report.cleanClose, checks: report.checks,
    ...(primaryFailure ? { failure: report.failure } : {}) }));
}
if (primaryFailure || cleanupErrors.length) throw new AggregateError(
  [...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors], 'Production controller/native send probe failed or did not close cleanly');
