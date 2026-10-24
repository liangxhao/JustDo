// Real Team host coordinators and native plugin RPCs; synthetic metadata and loopback model only.
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
import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';
import { verifyCollaborationExtensionAssembly } from './extension-assembly-contract.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const { runtimeRoot: runtime, identity } = resolveNativeSmokeTarget(process.argv[2]);
const assembly = verifyCollaborationExtensionAssembly(runtime);
const prepareOnly = process.argv.includes('--prepare-only');
assert.ok(process.argv.slice(3).every(argument => argument === '--prepare-only'));
const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const evidenceRoot = path.join(repository, '.agent-tasks/runtime/agent-team-message-paths');
fs.mkdirSync(evidenceRoot, { recursive: true });
const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'probe-'));
const compiled = path.join(evidence, 'host.cjs');
const compilation = await build({ stdin: { contents: `
export { CollaborationCoordinator } from './plugins/extensions/agent-team/host/collaboration/collaborationCoordinator';
export { TeamDiscussionCoordinator } from './plugins/extensions/agent-team/host/discussion/teamDiscussionCoordinator';
export { initializeCollaborationTables } from './plugins/extensions/agent-team/host/data/collaborationStore';
export { initializeTeamDiscussionTables } from './plugins/extensions/agent-team/host/data/teamDiscussionStore';
export { discussionMemberSessionKey } from './plugins/extensions/agent-team/contracts/teamDiscussion';
export { buildCoworkSessionKey } from './plugins/extensions/runtime-services/contracts/session-key';
export { getSessionRuntimeStatus, invalidateTargetedSessionStatusChecks } from './src/main/engine/openclaw/runtimeSessionStatus';
export { GatewayProcessShutdown } from './src/main/openclaw/runtime/launch/gatewayProcessShutdown';
export { ensureGatewayShutdownPreload } from './src/main/openclaw/runtime/launch/openclawLauncher';
export { GATEWAY_READY_MESSAGE } from './src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs';
`, resolveDir: repository, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
target: 'node24', outfile: compiled, metafile: true });
const host = require(compiled);
const report = { ...identity, assembly, checks: [], verified: false, cleanClose: false,
  sources: Object.keys(compilation.metafile.inputs).filter(name => !name.startsWith('<')).sort().map(name => ({
    path: name.replaceAll('\\', '/'), sha256: hash(fs.readFileSync(path.resolve(repository, name))),
  })), scope: 'Actual production Team collaboration/discussion host coordinators, real native session preparation, public discussion RPCs, exact execution terminals and native history. Product metadata/policy adapter ports are controlled; no Electron IPC, React UI, model-organized team or external service claim.' };
if (prepareOnly) {
  assert.equal(typeof host.CollaborationCoordinator, 'function');
  assert.equal(typeof host.TeamDiscussionCoordinator, 'function');
  fs.writeFileSync(path.join(evidence, 'prepared.json'), JSON.stringify({ ...report, gatewayStarted: false }, null, 2));
  console.log(JSON.stringify({ evidence, gatewayStarted: false, assemblySha256: assembly.assemblySha256 }));
  process.exit(0);
}
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-message-paths-'));
const workspace = path.join(stateDir, 'workspace');
fs.mkdirSync(workspace);
const token = randomBytes(24).toString('hex');
let modelRequests = 0;
let providerFailure;
const model = createServer(async (request, response) => {
  try {
    for await (const chunk of request) { void chunk; }
    modelRequests += 1;
    assert.ok(modelRequests <= 10, 'Synthetic Team model budget exceeded');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: `fixture-${modelRequests}`, object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'SYNTHETIC_TEAM_REPLY' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    providerFailure = error;
    if (!response.headersSent) response.writeHead(500);
    response.end('Synthetic provider assertion failed');
  }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const configPath = path.join(stateDir, 'openclaw.json');
fs.writeFileSync(configPath, JSON.stringify({
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: { ownership: 'explicit', entries: { alice: {}, bob: {}, carol: {} }, defaults: { workspace, skipBootstrap: true,
    embeddedAgent: { cyberFailover: { mode: 'off' } }, heartbeat: { every: '0m' }, systemAgent: { agentId: 'alice' },
    model: { primary: 'fixture/answer' }, modelPolicy: { allow: ['fixture/answer'] } } },
  models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: { fixture: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic-fixture-key', api: 'openai-completions',
    request: { allowPrivateNetwork: true }, models: [{ id: 'answer', name: 'Fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  } } }, plugins: { slots: { memory: 'none' }, allow: ['runtime-services', 'agent-team'],
    load: { paths: ['runtime-services', 'agent-team'].map(id => path.join(runtime, 'dist/extensions', id)) },
    entries: { 'runtime-services': { enabled: true }, 'agent-team': { enabled: true } } },
}));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(OPENCLAW_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
Object.assign(env, { OPENCLAW_HOME: stateDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_DISABLE_BONJOUR: '1',
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtime, 'dist/extensions') });
const changedEnvironment = ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'];
const previousEnvironment = Object.fromEntries(changedEnvironment.map(key => [key, process.env[key]]));
for (const key of changedEnvironment) process.env[key] = env[key];
let output = '';
const shutdown = new host.GatewayProcessShutdown(() => {});
const rawDb = new DatabaseSync(':memory:');
rawDb.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE agents(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL);
  CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,status TEXT NOT NULL);
  INSERT INTO agents VALUES('alice',1),('bob',1),('carol',1);`);
const database = { exec: sql => rawDb.exec(sql), prepare: sql => rawDb.prepare(sql),
  pragma: sql => rawDb.prepare(`PRAGMA ${sql}`).all(), transaction: fn => (...args) => {
    rawDb.exec('SAVEPOINT fixture_transaction');
    try { const result = fn(...args); rawDb.exec('RELEASE fixture_transaction'); return result; }
    catch (error) { rawDb.exec('ROLLBACK TO fixture_transaction'); rawDb.exec('RELEASE fixture_transaction'); throw error; }
  } };
host.initializeCollaborationTables(database);
host.initializeTeamDiscussionTables(database);
const sessions = new Map(), runs = new Map(), terminals = new Map(), checks = new Map();
const agents = new Map(['alice', 'bob', 'carol'].map(id => [id, { id, name: id, enabled: true, model: 'fixture/answer' }]));
const store = { getSession: id => sessions.get(id) ?? null, getAgent: id => agents.get(id) ?? null,
  listAgents: () => [...agents.values()], getSessionRuns: id => runs.get(id) ?? [], listPlanHandoffs: () => [],
  createSession(title, cwd, executionMode = 'sandbox', _skills = [], agentId = 'alice', permissionMode = 'ask') {
    assert.deepEqual(_skills, []);
    const row = { id: randomUUID(), title, cwd, executionMode, agentId, permissionMode, status: 'idle' };
    rawDb.prepare('INSERT INTO cowork_sessions VALUES(?,?,?)').run(row.id, agentId, 'idle');
    sessions.set(row.id, row); return row;
  }, deleteSession(id) { rawDb.prepare('DELETE FROM cowork_sessions WHERE id=?').run(id); sessions.delete(id); } };
const methods = [];
let client, generation = 1, failDescribe = false, primaryFailure, hostRequestFailure;
const hostRequests = [];
const cleanupErrors = [];
async function request(method, params, options) {
  methods.push(method);
  assert.notEqual(method, 'sessions.list', 'Team send and cleanup must not scan the session roster');
  if (method === 'sessions.describe' && failDescribe) throw new Error('Synthetic unavailable current-row read');
  return client.request(method, params, options);
}
const statusContext = { store, ensureGatewayClientReady: async () => {}, gatewayClientGeneration: generation,
  gatewayClient: { request }, targetedSessionStatusChecks: checks, unknownSessionRuns: new Map(),
  disconnectedSessionIds: new Set(), disconnectedRecoveryPromises: new Map(),
  goalContinuationCoordinator: { getSnapshot: () => null }, isSessionActive: () => false,
  compactionInFlightSessionIds: new Set(), getSessionRuntimeStatuses: () => { throw new Error('Global activity scan prohibited'); } };
const router = { getSessionRuntimeStatus: (id, options) => host.getSessionRuntimeStatus.call(statusContext, id, options),
  async prepareSession(id) {
    const row = store.getSession(id), key = host.buildCoworkSessionKey(id, row.agentId);
    const before = await request('sessions.describe', { key, agentId: row.agentId });
    assert.equal(before.session, null, 'New room participant must not borrow an existing native row');
    const created = await request('sessions.create', { key, cwd: row.cwd, permissionMode: 'guarded' });
    assert.ok(created.entry?.sessionId);
    row.nativeSessionKey = key;
    row.historyBinding = { sessionKey: key, nativeSessionId: created.entry.sessionId };
    return { sessionKey: key, gatewaySessionId: created.entry.sessionId };
  }, stopSession: async id => {
    const row = store.getSession(id);
    const status = await router.getSessionRuntimeStatus(id, { targeted: true, includeSubagents: true,
      expectedSessionId: row.historyBinding?.nativeSessionId });
    assert.ok(status.known && !status.running, 'Cleanup fixture only releases actually idle members');
  }, onSessionDeleted: () => {} };
const runtimePort = { captureGatewayResponseContext() {
  const captured = client, capturedGeneration = generation;
  return captured ? { isCurrent: () => client === captured && generation === capturedGeneration } : null;
}, getPlanMode: async () => ({ enabled: false }), getGoalExecution: () => null };
const collaboration = new host.CollaborationCoordinator({ getDatabase: () => database, getStore: () => store,
  getRouter: () => router, getRuntime: () => runtimePort, requestGateway: request });
const discussion = new host.TeamDiscussionCoordinator({ getDatabase: () => database, getStore: () => store,
  ensureReady: async () => { assert.ok(client); }, requestGateway: request,
  requestConnectedGateway: request, onChanged: () => {} });
async function until(predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (providerFailure) throw providerFailure;
    if (hostRequestFailure) throw hostRequestFailure;
    assert.equal(child.exitCode, null, `${label}: Gateway exited`);
    assert.equal(child.signalCode, null, `${label}: Gateway signalled`);
    assert.ok(Date.now() < deadline, `${label}: timed out`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
// Complete all synchronous host/metadata setup before creating the owned child.
const child = spawn(process.execPath, ['--require', host.ensureGatewayShutdownPreload(stateDir),
  path.join(runtime, 'gateway-launcher.cjs'), 'gateway', 'run', '--allow-unconfigured', '--port', String(port)],
{ env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
shutdown.observe(child);
report.gatewayPid = child.pid;
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/startupz`,
    { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 'native startup readiness', 120_000);
  const owners = fs.readdirSync(path.join(runtime, 'dist')).filter(name => /^client-.*\.mjs$/.test(name) &&
    fs.readFileSync(path.join(runtime, 'dist', name), 'utf8').includes('GatewayClient as t'));
  assert.equal(owners.length, 1);
  const { t: GatewayClient } = await import(pathToFileURL(path.join(runtime, 'dist', owners[0])).href);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native backend handshake timed out')), 90_000);
    client = new GatewayClient({ env, url: `ws://127.0.0.1:${port}`, token, clientName: 'gateway-client', mode: 'backend',
      scopes: ['operator.admin', 'operator.read', 'operator.write'], onHelloOk: () => { clearTimeout(timer); resolve(); }, onEvent: frame => {
        if (frame.event === 'plugin.agent-team.requested') {
          hostRequests.push({ operation: frame.payload.operation, requestId: frame.payload.requestId,
            sessionKey: frame.payload.sessionKey, sourceRunId: frame.payload.sourceRunId });
          void collaboration.handle(frame.payload).catch(error => { hostRequestFailure = error; });
        }
        if (frame.event === 'sessions.changed') host.invalidateTargetedSessionStatusChecks(checks, frame.payload);
        const event = frame.payload;
        if (frame.event === 'agent' && event?.stream === 'lifecycle' && event.data?.executionSettled === true &&
          ['end', 'error'].includes(event.data.phase)) terminals.set(event.runId, event);
      } });
    client.start();
  });
  child.send(host.GATEWAY_READY_MESSAGE);
  const source = store.createSession('Synthetic collaboration', workspace);
  const created = await collaboration.create(source.id, ['alice', 'bob']);
  assert.equal(created.room.members.length, 2);
  // Exercise the actual trusted native bind/dispatch -> Requested -> host.handle
  // -> Resolve bridge. The fixture selects the operation; this is not a claim
  // that a business model independently organized the collaboration.
  const sourceKey = host.buildCoworkSessionKey(source.id, 'alice');
  const sourceSid = source.historyBinding.nativeSessionId;
  const sourceRun = randomUUID(), sourcePrompt = 'SYNTHETIC_ENSURE_SOURCE_RECEIPT';
  runs.set(source.id, [{ sessionId: source.id, clientTurnId: sourceRun, rootRunId: sourceRun, state: 'running' }]);
  await request('chat.send', { sessionKey: sourceKey, sessionId: sourceSid, message: sourcePrompt, idempotencyKey: sourceRun });
  await until(() => terminals.has(sourceRun), 'source whole terminal for the trusted ensure request');
  const sourceTerminal = terminals.get(sourceRun);
  assert.equal(sourceTerminal.sessionKey, sourceKey); assert.equal(sourceTerminal.sessionId, sourceSid);
  assert.equal(sourceTerminal.data.phase, 'end'); assert.equal(sourceTerminal.data.executionSettled, true);
  runs.get(source.id)[0].state = 'completed';
  const ensure = async () => {
    const toolCallId = randomUUID();
    await request('collaboration.bind', { sessionKey: sourceKey, runId: sourceRun, toolCallId });
    return request('collaboration.dispatch', { operation: 'ensure', sessionKey: sourceKey,
      toolCallId, input: { agentId: 'carol' } }, { timeoutMs: 75_000 });
  };
  const ensured = await ensure();
  assert.equal(ensured.member?.agentId, 'carol');
  const createdBeforeRecheck = methods.filter(method => method === 'sessions.create').length;
  const rechecked = await ensure();
  assert.deepEqual(rechecked.member, ensured.member);
  assert.equal(methods.filter(method => method === 'sessions.create').length, createdBeforeRecheck,
    'Existing ensure intent must only reconcile, never allocate or prepare again');
  const mutationsBeforeUnavailable = methods.filter(method =>
    ['sessions.create', 'sessions.delete', 'chat.send'].includes(method)).length;
  failDescribe = true;
  const unavailable = await ensure();
  failDescribe = false;
  assert.equal(unavailable.error, 'Synthetic unavailable current-row read');
  assert.equal(methods.filter(method => method === 'sessions.create').length, createdBeforeRecheck);
  assert.equal(methods.filter(method =>
    ['sessions.create', 'sessions.delete', 'chat.send'].includes(method)).length, mutationsBeforeUnavailable,
  'An unknown recipient inspection must not create, delete or send');
  assert.equal(hostRequests.filter(row => row.operation === 'ensure').length, 3);
  report.checks.push({ path: 'native-host-ensure-bridge', sourceKey, sourceSid, sourceRun,
    member: ensured.member, actualRequestedEvents: 3, existingIntentAdditionalCreates: 0,
    unknownAdditionalCreates: 0, scope: 'Trusted fixture invokes real bind/dispatch; no model-organized-team claim' });
  const selected = created.room.members.find(member => member.agentId === 'bob');
  const nativeId = store.getSession(selected.sessionId).historyBinding.nativeSessionId;
  const input = { sourceSessionId: source.id, roomId: created.room.id,
    targetSessionKey: selected.sessionKey, nativeSessionId: nativeId };
  const prepared = await collaboration.prepareContinuation(input);
  assert.equal(prepared.targetSessionId, selected.sessionId);
  await collaboration.prepareContinuation({ ...input, expectedControlGeneration: prepared.controlGeneration });
  const beforeMemberModel = modelRequests;
  const runId = randomUUID(), prompt = 'SYNTHETIC_MEMBER_DIRECT_SEND';
  const sent = await request('chat.send', { sessionKey: selected.sessionKey, sessionId: nativeId,
    message: prompt, idempotencyKey: runId });
  assert.equal(sent.runId, runId);
  await until(() => terminals.has(runId), 'member whole terminal');
  const terminal = terminals.get(runId);
  assert.equal(terminal.sessionKey, selected.sessionKey); assert.equal(terminal.sessionId, nativeId);
  assert.equal(terminal.data.phase, 'end'); assert.equal(terminal.data.executionSettled, true);
  const history = await request('chat.history', { sessionKey: selected.sessionKey });
  assert.equal(history.sessionId, nativeId); assert.ok(JSON.stringify(history.messages).includes(prompt));
  assert.ok(JSON.stringify(history.messages).includes('SYNTHETIC_TEAM_REPLY'));
  assert.equal(modelRequests - beforeMemberModel, 1, 'One explicit member input must dispatch once');
  report.checks.push({ path: 'member-direct', roomId: created.room.id, nativeSessionId: nativeId,
    sessionKey: selected.sessionKey, runId, executionSettled: true, nativeHistoryVerified: true });
  const beforeNegative = methods.filter(method => ['sessions.create', 'chat.send'].includes(method)).length;
  failDescribe = true;
  await assert.rejects(collaboration.prepareContinuation(input), /teamFeatureStatusUnknown/);
  failDescribe = false;
  await assert.rejects(collaboration.prepareContinuation({ ...input, nativeSessionId: randomUUID() }), /collaborationInvalidRecipient/);
  assert.equal(methods.filter(method => ['sessions.create', 'chat.send'].includes(method)).length, beforeNegative);
  report.checks.push({ path: 'member-negative', unknownAndWrongIdentityMutations: 0 });
  const group = await discussion.create({ id: randomUUID(), title: 'Synthetic native discussion', cwd: workspace,
    agentIds: ['alice', 'bob'], rounds: 1, permissionMode: 'ask', readOnly: true });
  assert.equal(group.state, 'ready');
  // Native channel-dispatched runs do not belong to this backend connection.
  // Explicit per-session observers receive their authentic lifecycle stream.
  for (const member of group.members) {
    const key = host.discussionMemberSessionKey(group, member.agentId);
    const subscribed = await request('sessions.messages.subscribe', { key, agentId: member.agentId });
    assert.equal(subscribed.subscribed, true); assert.equal(subscribed.key, key);
    assert.equal(subscribed.agentId, member.agentId);
  }
  const groupRequest = { roomId: group.id, requestId: randomUUID(), expectedRevision: group.revision,
    message: 'SYNTHETIC_GROUP_PUBLIC_SEND', rounds: 1, selectedAgentIds: [] };
  const beforeGroupModel = modelRequests;
  await discussion.send(groupRequest);
  let projected;
  await until(async () => { projected = await discussion.read(group.id); return projected.latestRun?.state === 'completed'; },
    'real group discussion completion');
  assert.equal(projected.executions.length, 2);
  for (const execution of projected.executions) {
    const member = group.members.find(member => member.agentId === execution.agentId);
    assert.ok(member); assert.equal(execution.sessionId, member.sessionId);
    assert.equal(execution.lifecycleRevision, member.lifecycleRevision);
    assert.equal(execution.outcome, 'completed');
    await until(() => terminals.has(execution.runId), 'exact subscribed participant whole terminal');
    const whole = terminals.get(execution.runId);
    assert.equal(whole.sessionId, member.sessionId); assert.equal(whole.sessionKey, execution.sessionKey);
    assert.equal(whole.data.executionSettled, true); assert.equal(whole.data.phase, 'end');
  }
  assert.ok(projected.messages.some(message => message.role === 'user' && message.text.includes(groupRequest.message)));
  for (const agentId of ['alice', 'bob']) assert.ok(projected.messages.some(message =>
    message.agentId === agentId && message.role === 'assistant' && message.text.includes('SYNTHETIC_TEAM_REPLY')));
  assert.equal(modelRequests - beforeGroupModel, 2, 'Each one-round group participant must dispatch once');
  const beforeReplay = modelRequests;
  await discussion.send(groupRequest);
  assert.equal(modelRequests, beforeReplay, 'An already admitted group request must not dispatch twice');
  report.checks.push({ path: 'group-public', roomId: group.id, discussionId: projected.latestRun.discussionId,
    executions: projected.executions, participantTerminals: 2, publicNativeHistoryVerified: true, replayModelRequests: 0 });
  await until(async () => {
    for (const member of collaboration.read(source.id).room.members) {
      const row = store.getSession(member.sessionId);
      const current = await router.getSessionRuntimeStatus(member.sessionId, { targeted: true, includeSubagents: true,
        expectedSessionId: row.historyBinding.nativeSessionId });
      if (!current.known || current.running) return false;
    }
    return true;
  }, 'member point-scoped cleanup readiness');
  await collaboration.deleteTask(source.id);
  assert.ok(!methods.includes('sessions.list'));
  report.checks.push({ path: 'no-global-roster', applicationListRequests: 0 });
  report.verified = true;
} catch (error) { primaryFailure = error; }
finally {
  try { discussion.dispose(); } catch (error) { cleanupErrors.push(error); }
  const results = await Promise.allSettled([shutdown.stop(child), client ? client.stopAndWait() : Promise.resolve()]);
  for (const result of results) if (result.status === 'rejected') cleanupErrors.push(result.reason);
  try { rawDb.close(); } catch (error) { cleanupErrors.push(error); }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  for (const key of changedEnvironment) {
    if (previousEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[key];
  }
  report.cleanClose = !shutdown.failure && child.exitCode === 0 && child.signalCode === null && cleanupErrors.length === 0;
  report.gatewayExit = { code: child.exitCode, signal: child.signalCode, joined: true };
  report.modelRequests = modelRequests; report.methods = methods; report.hostRequests = hostRequests; report.stateDir = stateDir;
  if (primaryFailure) report.failure = String(primaryFailure.stack ?? primaryFailure);
  fs.writeFileSync(path.join(evidence, 'gateway.log'), output.replaceAll(token, '<fixture-token>'));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, verified: report.verified, cleanClose: report.cleanClose,
    ...(primaryFailure ? { failure: String(primaryFailure.message ?? primaryFailure) } : {}) }));
}
if (primaryFailure || cleanupErrors.length) throw new AggregateError(
  [...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors], 'Team message paths failed or did not close cleanly');
