// Production Swarm host -> native plugin/managed-run boundary. Synthetic state only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';
import { verifyCollaborationExtensionAssembly } from './extension-assembly-contract.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const { runtimeRoot: runtime, identity } = resolveNativeSmokeTarget(process.argv[2]);
const extensionAssembly = verifyCollaborationExtensionAssembly(runtime);
assert.ok(process.argv.slice(3).every(argument => argument === '--prepare-only'));
const prepareOnly = process.argv.includes('--prepare-only');
const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const evidenceRoot = path.join(repository, '.agent-tasks/runtime/swarm-workflow-send');
fs.mkdirSync(evidenceRoot, { recursive: true });
const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'probe-'));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-send-'));
const workspace = path.join(stateDir, 'project');
fs.mkdirSync(workspace);
const compiled = path.join(evidence, 'host.cjs');
const hostBuild = await build({ stdin: { contents: `
export { createSwarmWorkflowCoordinator } from './plugins/extensions/swarm-workflow/host/coordinator';
export { startInstructions } from './plugins/extensions/swarm-workflow/prompt/start';
export { GatewayProcessShutdown } from './src/main/openclaw/runtime/launch/gatewayProcessShutdown';
export { ensureGatewayShutdownPreload } from './src/main/openclaw/runtime/launch/openclawLauncher';
export { GATEWAY_READY_MESSAGE } from './src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs';
`, resolveDir: repository, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
outfile: compiled, metafile: true });
const production = require(compiled);
const nativePluginFile = path.join(runtime, 'dist/extensions/swarm-workflow/index.js');
const nativePluginSource = fs.readFileSync(nativePluginFile, 'utf8');
assert.ok(!nativePluginSource.includes('sessions.list'), 'The actual Swarm bundle must not request a global session roster');
const sourceInputs = Object.keys(hostBuild.metafile.inputs).filter(relative => !relative.startsWith('<'))
  .sort().map(relative => ({ path: relative.replaceAll('\\', '/'),
    sha256: hash(fs.readFileSync(path.resolve(repository, relative))) }));
const report = { ...identity, manifestSha256: hash(fs.readFileSync(path.join(runtime, 'runtime-patch-manifest.json'))),
  extensionAssembly,
  sourceInputs, compiledHostSha256: hash(fs.readFileSync(compiled)),
  nativePluginSha256: hash(fs.readFileSync(nativePluginFile)), stateDir,
  checks: [], verified: false, cleanClose: false,
  scope: 'Actual host coordinator, byte-verified bundled production Swarm entry and native managed execution. Cleanup uses the public native workflow projection; whole outcome uses authenticated exact-session WS events. Loopback synthetic model only; no Renderer DOM, product Store, user data or model-quality claim. Running-node note is saved input, not live steering.' };
const sourceId = randomUUID();
const parentKey = `agent:main:justdo:${sourceId}`;
function startToolAvailable(input) {
  return (input.tools ?? []).some(tool => ['swarm_workflow_start', 'tool_call'].includes(tool.function?.name));
}
// Exercise the same selection predicate before starting any native process.
assert.equal(startToolAvailable({ tools: [{ function: { name: 'swarm_workflow_start' } }] }), true);
assert.equal(startToolAvailable({ tools: [{ function: { name: 'tool_call' } }] }), true);
assert.equal(startToolAvailable({ tools: [] }), false);
assert.ok(production.startInstructions('auto', sourceId + ':user').includes(sourceId + ':user'));
const methods = [];
let client;
const request = async (method, params) => {
  methods.push(method);
  assert.notEqual(method, 'sessions.list', 'Host sends must not scan the global session roster');
  return client.request(method, params);
};
const gatewayClient = { request };
const hostRuntime = { getGatewayClient: () => gatewayClient, getSessionKeysForSession: id => id === sourceId ? [parentKey] : [],
  getPlanMode: async id => {
    assert.equal(id, sourceId);
    const result = await request('sessions.describe', { key: parentKey, agentId: 'main' });
    const state = result.session?.pluginExtensions?.find(extension =>
      extension.pluginId === 'plan-mode' && extension.namespace === 'state')?.value;
    return { enabled: state?.enabled === true };
  } };
const coordinator = production.createSwarmWorkflowCoordinator({ getRuntime: () => hostRuntime, hasSession: id => id === sourceId });
assert.equal(typeof coordinator.prepareSwarmWorkflow, 'function');
if (prepareOnly) {
  fs.writeFileSync(path.join(evidence, 'prepared.json'), JSON.stringify({ ...report, gatewayStarted: false }, null, 2));
  console.log(JSON.stringify({ evidence, gatewayStarted: false, sourceInputs: sourceInputs.length }));
  process.exit(0);
}

const token = randomBytes(24).toString('hex');
const startRun = randomUUID();
const firstPrompt = 'SYNTHETIC_SWARM_SOURCE_TASK';
const continuation = 'SYNTHETIC_CONTINUE_LITERAL: continue the same read-only inspection.';
const savedNote = 'SYNTHETIC_SAVED_NOTE: inspect only the synthetic project.';
const modelRequests = [];
let providerRequestCount = 0;
const nativeTerminals = new Map();
const nativeStarts = new Map();
const subscriptions = new Map();
const heldAttempts = new Set();
let workAttempt = 1;
let heldWorker;
let providerFailure;
let continuationSeen = false;
const model = createServer(async (incoming, response) => {
  const requestNumber = ++providerRequestCount;
  try {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    const input = JSON.parse(body);
    fs.writeFileSync(path.join(evidence, `provider-request-${requestNumber}.json`), body);
    assert.ok(modelRequests.length < 60, 'The synthetic workflow exceeded its bounded model budget');
    const messages = input.messages ?? [];
    const textOf = value => typeof value === 'string' ? value : JSON.stringify(value);
    const all = JSON.stringify(messages);
    const tools = (input.tools ?? []).map(tool => tool.function?.name);
    const toolMessages = messages.filter(message => message.role === 'tool');
    const intake = all.includes(startRun + ':user') && startToolAvailable(input) &&
      !toolMessages.some(message => textOf(message.content).includes('Flow accepted.'));
    const managementIndex = messages.findLastIndex(message => message.role === 'user' && textOf(message.content).includes('SYNTHETIC_MAIN_STATUS'));
    const management = managementIndex >= 0;
    const worker = all.includes('Call swarm_workflow_complete(summary, evidence)') && !intake && !management;
    const verifier = all.includes('Independently inspect every work result') && !intake && !management;
    const planner = all.includes('Return only JSON') && !worker && !verifier && !intake && !management;
    const lastInput = messages.findLastIndex(message => message.role === 'user' &&
      /assignedTask|SYNTHETIC_CONTINUE_LITERAL|Submission correction only/.test(textOf(message.content)));
    const submitted = messages.slice(lastInput + 1).some(message => message.role === 'tool' &&
      textOf(message.content).includes('Submission persisted.'));
    const statusDone = management && messages.slice(managementIndex + 1).some(message =>
      message.role === 'tool' && /(?:"|\\")revision(?:"|\\")/.test(textOf(message.content)));
    let toolName;
    let args;
    if (management && !statusDone) { toolName = 'swarm_workflow_status'; args = {}; }
    else if (intake) { toolName = 'swarm_workflow_start'; args = { goal: firstPrompt, mode: 'auto', sourceRequestId: startRun + ':user' }; }
    else if ((worker || verifier) && !submitted && tools.length) {
      toolName = verifier ? 'swarm_workflow_verify' : workAttempt < 3 ? 'swarm_workflow_block' : 'swarm_workflow_complete';
      args = { ...(verifier ? { passed: true } : {}), summary: 'Synthetic inspection evidence', evidence: ['Only synthetic fixture inputs were inspected.'] };
      if (worker && workAttempt === 2) {
        assert.ok(all.includes(savedNote), 'Saved note must reach only the continued execution');
        const last = messages[lastInput];
        const modelInput = textOf(last?.content);
        assert.ok(modelInput.endsWith(continuation), 'The native model input must retain the complete human message');
        assert.ok(!modelInput.includes('assignedTask') && !modelInput.includes('humanInput'), 'The application must not repackage continuation as a task envelope');
        continuationSeen = true;
      }
    }
    const stage = management ? 'main-status' : intake ? 'source-start' : planner ? 'plan' : verifier ? 'verify' : worker ? `work-${workAttempt}` : 'delivery-or-source-final';
    modelRequests.push({ requestNumber, stage, tool: toolName ?? null, tools,
      sourceRequestIdPresent: all.includes(startRun + ':user'),
      selectedMarkerPresent: all.includes('<swarm-workflow '),
      nativeRequestIdentityRefused: all.includes('Swarm Workflow request identity could not be confirmed') });
    console.log(JSON.stringify({ stage, modelRequest: modelRequests.length, selectedTool: toolName ?? null, toolCount: tools.length }));
    if (worker && !verifier && toolName && !heldAttempts.has(workAttempt)) {
      heldAttempts.add(workAttempt);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      heldWorker = { attempt: workAttempt, release, response, requestIndex: modelRequests.length };
      await gate;
      if (response.destroyed) return;
    }
    const answer = planner ? JSON.stringify({ tasks: [{ id: 'inspect', title: 'Inspect synthetic input',
      task: 'SYNTHETIC_READ_ONLY_INSPECTION', deps: [], access: 'read', batch: null }] })
      : management ? 'SYNTHETIC_MAIN_STATUS_COMPLETE' : 'SYNTHETIC_SWARM_REPLY';
    const tool = toolName ? { id: 'workflowcall' + requestNumber, type: 'function', function: {
      name: tools.includes('tool_call') ? 'tool_call' : toolName,
      arguments: JSON.stringify(tools.includes('tool_call') ? { id: toolName, args } : args),
    } } : undefined;
    const message = tool ? { role: 'assistant', content: null, tool_calls: [tool] } : { role: 'assistant', content: answer };
    if (input.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'fixture-' + modelRequests.length, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, ...tool }] } : message, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ id: 'fixture-' + modelRequests.length, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'fixture-' + modelRequests.length, object: 'chat.completion',
        choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    }
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
  tools: { toolSearch: false },
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: { ownership: 'explicit', entries: { main: {} }, defaults: { workspace, skipBootstrap: true,
    embeddedAgent: { cyberFailover: { mode: 'off' } }, heartbeat: { every: '0m' }, systemAgent: { agentId: 'main' },
    model: { primary: 'fixture/answer' }, modelPolicy: { allow: ['fixture/answer'] } } },
  models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: { fixture: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic-fixture-key', api: 'openai-completions',
    request: { allowPrivateNetwork: true }, models: [{ id: 'answer', name: 'Fixture', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4000 }],
  } } },
  plugins: { slots: { memory: 'none' }, allow: ['runtime-services', 'swarm-workflow'], load: {
    paths: ['runtime-services', 'swarm-workflow'].map(id => path.join(runtime, 'dist/extensions', id)),
  }, entries: { 'runtime-services': { enabled: true }, 'swarm-workflow': { enabled: true,
    config: { availableAgentIds: ['main'], globalConcurrency: 1, maxAttempts: 3 } } } },
}));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(OPENCLAW_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
Object.assign(env, { OPENCLAW_HOME: stateDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_DISABLE_BONJOUR: '1',
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtime, 'dist/extensions') });
const oldEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^OPENCLAW_/i.test(key)));
for (const key of Object.keys(process.env)) if (/^OPENCLAW_/i.test(key)) delete process.env[key];
for (const key of ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH']) process.env[key] = env[key];
const child = spawn(process.execPath, ['--require', production.ensureGatewayShutdownPreload(stateDir),
  path.join(runtime, 'gateway-launcher.cjs'), 'gateway', 'run', '--allow-unconfigured', '--port', String(port)],
{ env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  output += chunk;
  fs.writeFileSync(path.join(evidence, 'gateway.log'), output.replaceAll(token, '<fixture-token>'));
});
const shutdown = new production.GatewayProcessShutdown(() => {});
shutdown.observe(child);
let primaryFailure;
const cleanupErrors = [];
async function until(read, accept, label, budget = 120_000) {
  const deadline = Date.now() + budget;
  while (true) {
    if (providerFailure) throw providerFailure;
    assert.equal(child.exitCode, null, `${label}: Gateway exited`);
    assert.equal(child.signalCode, null, `${label}: Gateway signalled`);
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: timed out`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function flows() {
  const result = await coordinator.getSwarmWorkflows(sourceId);
  assert.equal(result.success, true);
  if (!result.flows.length && nativeTerminals.has(startRun)) {
    fs.writeFileSync(path.join(evidence, 'native-source-observation.json'), JSON.stringify(
      await request('chat.history', {sessionKey:parentKey}), null, 2));
    throw new Error('Source whole-run settled without an accepted workflow; inspect synthetic provider-request and tool surface evidence');
  }
  return result.flows;
}
async function detail(flow, node) {
  const result = await coordinator.getSwarmWorkflowDetail(sourceId, flow.id, node.id);
  assert.equal(result.success, true);
  return result.detail;
}
async function settled(node, expectedPhase) {
  // The public Swarm projection retains the real managed runtime cleanup fact.
  // The separately subscribed native whole event establishes execution outcome.
  const current = await until(flows, value => value[0]?.nodes.some(candidate => candidate.runId === node.runId && candidate.cleanupSettled === true),
    'native managed cleanup reflected by the actual workflow');
  assert.equal(current[0].nodes.find(candidate => candidate.runId === node.runId).sessionKey, node.sessionKey);
  const terminal = await until(async () => nativeTerminals.get(node.runId), value => !!value,
    'exact subscribed native whole-run terminal');
  assert.equal(terminal.sessionKey, node.sessionKey);
  assert.equal(terminal.sessionId, subscriptions.get(node.sessionKey));
  if (expectedPhase) assert.equal(terminal.data.phase, expectedPhase);
  const waited = await request('agent.wait', { runId: node.runId, timeoutMs: 1 });
  assert.equal(waited.status, expectedPhase === 'error' ? 'error' : 'ok');
  const row = await request('sessions.describe', { key: node.sessionKey, agentId: 'main' });
  assert.equal(row.session?.sessionId, terminal.sessionId);
  return { runId: node.runId, sessionKey: node.sessionKey, nativeSessionId: terminal.sessionId,
    phase: terminal.data.phase, executionSettled: true, cleanupSettled: true,
    cleanupEvidence: 'actual Swarm managed runtime projection' };
}
async function subscribeHeldWork(attempt) {
  const current = (await until(flows, value => value[0]?.nodes.some(node => node.kind === 'work' &&
    (node.attempt ?? 1) === attempt && node.status === 'running') && heldWorker?.attempt === attempt,
  'held native work before exact subscription'))[0];
  const node = current.nodes.find(candidate => candidate.kind === 'work');
  const described = await request('sessions.describe', { key: node.sessionKey, agentId: 'main' });
  assert.equal(described.session?.key, node.sessionKey);
  assert.ok(described.session?.sessionId);
  const prior = subscriptions.get(node.sessionKey);
  if (prior) assert.equal(described.session.sessionId, prior);
  const subscribed = await request('sessions.messages.subscribe', { key: node.sessionKey, agentId: 'main' });
  assert.equal(subscribed.subscribed, true);
  assert.equal(subscribed.key, node.sessionKey);
  assert.equal(subscribed.agentId, 'main');
  subscriptions.set(node.sessionKey, described.session.sessionId);
  return current;
}
try {
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, value => value === true, 'native startup readiness');
  const clientFiles = fs.readdirSync(path.join(runtime, 'dist')).filter(file => /^client-.*\.mjs$/.test(file) &&
    fs.readFileSync(path.join(runtime, 'dist', file), 'utf8').includes('GatewayClient as t'));
  assert.equal(clientFiles.length, 1);
  const { t: GatewayClient } = await import(pathToFileURL(path.join(runtime, 'dist', clientFiles[0])).href);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native Gateway handshake timed out')), 90_000);
    client = new GatewayClient({ env, url: `ws://127.0.0.1:${port}`, token, clientName: 'gateway-client', mode: 'backend',
      scopes: ['operator.admin'], onHelloOk: () => { clearTimeout(timer); resolve(); }, onEvent: frame => {
        const event = frame.payload;
        if (frame.event !== 'agent' || event?.stream !== 'lifecycle') return;
        if (event.data?.phase === 'start') nativeStarts.set(event.runId, { sessionKey: event.sessionKey, sessionId: event.sessionId });
        if (event.data?.executionSettled === true && ['end', 'error'].includes(event.data.phase)) nativeTerminals.set(event.runId, event);
      } });
    client.start();
  });
  child.send(production.GATEWAY_READY_MESSAGE);
  const prepared = await coordinator.prepareSwarmWorkflow({ mode: 'auto', verify: true }, sourceId);
  assert.equal(prepared.success, true);
  const created = await request('sessions.create', { key: parentKey, cwd: workspace, permissionMode: 'workspace' });
  const parentSid = created.entry?.sessionId;
  assert.ok(parentSid);
  await request('chat.send', { sessionKey: parentKey, sessionId: parentSid, message: firstPrompt + '\n\n' + prepared.instruction,
    idempotencyKey: startRun });
  let flow = await until(flows, value => value.length === 1 && value[0].nodes.some(node => node.kind === 'work' && node.status === 'running') && heldWorker,
    'source real start tool and held work node');
  flow = flow[0];
  let work = flow.nodes.find(node => node.kind === 'work');
  assert.ok(work.runId);
  await subscribeHeldWork(1);
  const sourceTerminal = await until(async () => nativeTerminals.get(startRun), value => value?.sessionId === parentSid, 'source whole-run terminal');
  assert.equal(sourceTerminal.sessionKey, parentKey);
  assert.equal(sourceTerminal.data.phase, 'end');
  report.checks.push({ label: 'main-first-send-real-start-tool', parentKey, nativeSessionId: parentSid, runId: startRun,
    flowId: flow.id, firstWorkRunId: work.runId });
  const runningDetail = await detail(flow, work);
  assert.equal(runningDetail.canNote, true);
  assert.equal(runningDetail.canContinue, false);
  const beforeNoteRequests = modelRequests.length;
  const beforeNoteStarts = nativeStarts.size;
  const note = { id: randomUUID(), action: 'note', text: savedNote };
  assert.deepEqual(await coordinator.interveneSwarmWorkflow(sourceId, flow.id, work.id, runningDetail.revision, note), { success: true });
  const saved = await detail(flow, work);
  assert.ok(saved.interventions.some(value => value.id === note.id));
  assert.equal(saved.sessionKey, work.sessionKey);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(modelRequests.length, beforeNoteRequests, 'Running-note acceptance must not dispatch a native message');
  assert.equal(nativeStarts.size, beforeNoteStarts);
  const invalidCount = methods.filter(method => method === 'swarmWorkflow.intervene').length;
  assert.deepEqual(await coordinator.interveneSwarmWorkflow(sourceId, flow.id, work.id, saved.revision,
    { id: randomUUID(), action: 'continue', text: continuation }), { success: false });
  assert.equal(methods.filter(method => method === 'swarmWorkflow.intervene').length, invalidCount + 1);
  assert.equal(modelRequests.length, beforeNoteRequests);
  report.checks.push({ label: 'running-node-note-only-and-continue-denied', runId: work.runId, sessionKey: work.sessionKey,
    saved: true, additionalModelRequests: 0, additionalNativeStarts: 0 });
  heldWorker.release();
  flow = (await until(flows, value => value[0]?.status === 'blocked' && value[0].nodes.find(node => node.kind === 'work')?.status === 'failed',
    'first submitted blocker and native cleanup'))[0];
  work = flow.nodes.find(node => node.kind === 'work');
  const firstIdentity = await settled(work, 'end');
  let failedDetail = await until(() => detail(flow, work), value => value.canContinue === true, 'continue availability after exact cleanup');
  workAttempt = 2;
  const continueOperation = { id: randomUUID(), action: 'continue', text: continuation };
  const continueRevision = failedDetail.revision;
  // Simulate a lost host ACK only after the real native response accepted it.
  // The second call is an explicit same-operation reconciliation, never a new ID.
  let loseAcceptedReply = true;
  const originalRequest = request;
  const lostAckClient = { request: async (method, params) => {
    const result = await originalRequest(method, params);
    if (method === 'swarmWorkflow.intervene' && loseAcceptedReply) { loseAcceptedReply = false; throw new Error('Synthetic accepted ACK lost'); }
    return result;
  } };
  const lossRuntime = { ...hostRuntime, getGatewayClient: () => lostAckClient };
  const lossCoordinator = production.createSwarmWorkflowCoordinator({ getRuntime: () => lossRuntime,
    hasSession: id => id === sourceId });
  assert.deepEqual(await lossCoordinator.interveneSwarmWorkflow(sourceId, flow.id, work.id, continueRevision, continueOperation), { success: false });
  assert.deepEqual(await coordinator.interveneSwarmWorkflow(sourceId, flow.id, work.id, continueRevision, continueOperation), { success: true });
  await subscribeHeldWork(2);
  heldWorker.release();
  flow = (await until(flows, value => value[0]?.status === 'blocked' && value[0].nodes.find(node => node.kind === 'work')?.attempt === 2 &&
    value[0].nodes.find(node => node.kind === 'work')?.status === 'failed', 'same-key continued execution'))[0];
  work = flow.nodes.find(node => node.kind === 'work');
  const continuedIdentity = await settled(work, 'end');
  assert.equal(continuedIdentity.sessionKey, firstIdentity.sessionKey);
  assert.equal(continuedIdentity.nativeSessionId, firstIdentity.nativeSessionId);
  assert.notEqual(continuedIdentity.runId, firstIdentity.runId);
  assert.equal(continuationSeen, true);
  failedDetail = await detail(flow, work);
  assert.equal(failedDetail.dispatch.message, continuation,
    'The production plugin must send the literal human input to the native runtime');
  assert.equal(failedDetail.interventions.filter(value => value.id === continueOperation.id).length, 1);
  const continuedHistory = await request('chat.history', { sessionKey: work.sessionKey });
  assert.equal(continuedHistory.sessionId, continuedIdentity.nativeSessionId);
  const metadataOwners = fs.readdirSync(path.join(runtime, 'dist')).filter(file =>
    /^user-turn-transcript\.metadata-.*\.mjs$/.test(file) &&
      fs.readFileSync(path.join(runtime, 'dist', file), 'utf8').includes('buildRunUserTurnIdempotencyKey as i'));
  assert.equal(metadataOwners.length, 1, 'The admitted native user-turn identity helper must have one exact owner');
  const { i: buildRunUserTurnIdempotencyKey } = await import(pathToFileURL(path.join(runtime, 'dist', metadataOwners[0])).href);
  const expectedUserKey = buildRunUserTurnIdempotencyKey(continuedIdentity.runId);
  const continuedUsers = continuedHistory.messages.filter(message => {
    if (message.role !== 'user') return false;
    const rootKey = message.idempotencyKey;
    const metadataKey = message.__openclaw?.idempotencyKey;
    if (rootKey !== undefined && metadataKey !== undefined) assert.equal(rootKey, metadataKey);
    return (rootKey ?? metadataKey) === expectedUserKey;
  });
  assert.equal(continuedUsers.length, 1, 'Exactly one native persisted user entry must own the continued run');
  const continuedText = typeof continuedUsers[0].content === 'string' ? continuedUsers[0].content
    : continuedUsers[0].content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.equal(continuedText, continuation, 'The native persisted user body must retain the literal human input');
  report.checks.push({ label: 'failed-node-continue-same-session-and-lost-ack-reconcile', previous: firstIdentity,
    current: continuedIdentity, acceptedOperations: 1, literalHumanInput: true, savedNoteSeen: true });
  workAttempt = 3;
  const retry = { id: randomUUID(), action: 'retry', text: '' };
  // Identity/history evidence reads above take real time. This separate human
  // action must consume a new detail revision, rather than the previous action's.
  failedDetail = await detail(flow, work);
  assert.deepEqual(await coordinator.interveneSwarmWorkflow(sourceId, flow.id, work.id, failedDetail.revision, retry), { success: true });
  await subscribeHeldWork(3);
  heldWorker.release();
  flow = (await until(flows, value => value[0]?.status === 'completed', 'new-key retry and independent verification/delivery', 180_000))[0];
  work = flow.nodes.find(node => node.kind === 'work');
  const retriedIdentity = await settled(work, 'end');
  assert.notEqual(retriedIdentity.sessionKey, continuedIdentity.sessionKey);
  assert.notEqual(retriedIdentity.nativeSessionId, continuedIdentity.nativeSessionId);
  assert.notEqual(retriedIdentity.runId, continuedIdentity.runId);
  assert.equal(work.attempt, 3);
  const completedDetail = await detail(flow, work);
  assert.equal(completedDetail.canNote, false);
  assert.equal(completedDetail.canContinue, false);
  const afterCompleted = modelRequests.length;
  assert.deepEqual(await coordinator.interveneSwarmWorkflow(sourceId, flow.id, work.id, completedDetail.revision,
    { id: randomUUID(), action: 'note', text: 'SYNTHETIC_REJECT_COMPLETED' }), { success: false });
  assert.equal(modelRequests.length, afterCompleted);
  report.checks.push({ label: 'retry-new-session-and-completed-node-read-only', previous: continuedIdentity, current: retriedIdentity });
  const sourceHistory = await request('chat.history', { sessionKey: parentKey });
  assert.ok(JSON.stringify(sourceHistory.messages).includes('SYNTHETIC_SWARM_REPLY'));
  const statusRun = randomUUID();
  await request('chat.send', { sessionKey: parentKey, sessionId: parentSid, message: 'SYNTHETIC_MAIN_STATUS: inspect the accepted workflow.', idempotencyKey: statusRun });
  const statusTerminal = await until(async () => nativeTerminals.get(statusRun), value => value?.sessionId === parentSid, 'existing source management whole-run terminal');
  assert.equal(statusTerminal.sessionKey, parentKey);
  assert.equal(statusTerminal.data.phase, 'end');
  assert.equal((await flows()).length, 1, 'An ordinary source follow-up must not duplicate a workflow');
  const statusHistory = await request('chat.history', { sessionKey: parentKey });
  assert.ok(JSON.stringify(statusHistory.messages).includes('SYNTHETIC_MAIN_STATUS_COMPLETE'));
  assert.equal(modelRequests.filter(value => value.stage === 'main-status' && value.tool === 'swarm_workflow_status').length, 1,
    'The existing source follow-up must actually call the current native status tool once');
  report.checks.push({ label: 'existing-main-source-status-send', parentKey, nativeSessionId: parentSid, runId: statusRun, flowCount: 1 });
  assert.ok(!methods.includes('sessions.list'));
  assert.equal(new Set([firstIdentity.runId, continuedIdentity.runId, retriedIdentity.runId]).size, 3);
  for (const attempt of [1, 2, 3]) assert.equal(modelRequests.filter(value => value.stage === `work-${attempt}`).length, 2,
    'Each exact work attempt must dispatch one model turn and its post-submission reply, without replay');
  report.checks.push({ label: 'no-global-session-scan', hostListRequests: 0, pluginNoGlobalListLiteral: true,
    exactWorkRuns: [firstIdentity, continuedIdentity, retriedIdentity], nativePluginSourceScanned: true });
  report.verified = true;
} catch (error) { primaryFailure = error; }
finally {
  heldWorker?.release();
  const retirement = await Promise.allSettled([shutdown.stop(child), client ? client.stopAndWait() : Promise.resolve()]);
  for (const result of retirement) if (result.status === 'rejected') cleanupErrors.push(result.reason);
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  for (const key of Object.keys(process.env)) if (/^OPENCLAW_/i.test(key)) delete process.env[key];
  Object.assign(process.env, oldEnvironment);
  report.cleanClose = !shutdown.failure && child.exitCode === 0 && child.signalCode === null && cleanupErrors.length === 0;
  report.modelRequests = modelRequests;
  report.providerRequestCount = providerRequestCount;
  report.nativeStarts = [...nativeStarts].map(([runId, value]) => ({ runId, ...value }));
  report.hostMethods = methods;
  if (primaryFailure) report.failure = String(primaryFailure.message ?? primaryFailure);
  fs.writeFileSync(path.join(evidence, 'gateway.log'), output.replaceAll(token, '<fixture-token>'));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, verified: report.verified, cleanClose: report.cleanClose, checks: report.checks,
    ...(primaryFailure ? { failure: report.failure } : {}) }));
}
if (primaryFailure || cleanupErrors.length) throw new AggregateError(
  [...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors], 'Swarm host/native sending failed or did not close cleanly');
