'use strict';

// Opt-in real Gateway probe. Only its own isolated state, ports and processes
// are used; the selected frozen artifact is verified and only disposable state is written.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { runtimeRoot: runtime, identity: runtimeIdentity } = require('../../runtime/native-smoke-target.mjs').resolveNativeSmokeTarget();
const longProbe = process.env.JUSTDO_EXECUTION_LONG === '1';
const feedbackProbe = process.env.TOOL_CALL_FEEDBACK_PROBE === '1';
const goalProbe = process.env.GOAL_CONTINUATION_NATIVE_PROBE === '1';
if (goalProbe && feedbackProbe) throw new Error('Run Goal and format fixtures separately.');
const feedbackFailureProbe = process.env.TOOL_CALL_FEEDBACK_FAILURE;
const feedbackCase = process.env.TOOL_CALL_FEEDBACK_CASE || 'xml';
const feedbackOwner = process.env.TOOL_CALL_FEEDBACK_OWNER || 'main';
const feedbackCases = {
  xml: { raw: '<private-parameter>', hint: 'invalid JSON (XML-like input; use a JSON object)' },
  truncated: { raw: '{"command":"private-parameter', hint: 'invalid JSON (unterminated JSON string)' },
  escape: { raw: '{"command":"private-parameter\\q"}', hint: 'invalid JSON (invalid JSON escape)' },
  array: { raw: '["private-parameter"]', hint: 'arguments must be a JSON object' },
  oversized: { raw: '<private-parameter>' + '😀'.repeat(10000), hint: 'Some diagnostics were omitted.' },
  persistent: { raw: '<private-parameter>', hint: 'invalid JSON (XML-like input; use a JSON object)' },
};
if (!Object.hasOwn(feedbackCases, feedbackCase) || !['main', 'sub'].includes(feedbackOwner) ||
    (feedbackFailureProbe && !['disconnect', 'http', 'http-long'].includes(feedbackFailureProbe)) ||
    (feedbackCase === 'persistent' && feedbackFailureProbe) ||
    (feedbackOwner === 'sub' && !feedbackFailureProbe && feedbackCase !== 'persistent')) throw new Error('Unsupported feedback probe scenario.');
const feedbackExhausted = feedbackCase === 'persistent';
const gatewayPort = Number(process.env.RUNTIME_EXECUTION_PROBE_PORT || 43241);
const gatewayToken = randomBytes(24).toString('hex');
if (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65534) throw new Error('Invalid isolated probe port.');
const feedbackProviderError = 'Synthetic model service unavailable during format correction';
if (!runtime) throw new Error('Set JUSTDO_EXECUTION_RUNTIME to an isolated prepared prototype.');
const base = path.resolve('.agent-tasks/runtime/plugin-owned-execution-' + Date.now());
const project = path.join(base, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(base, 'runtime-identity.json'), JSON.stringify(runtimeIdentity, null, 2));
const plugins = path.join(base, 'extensions');
for (const id of ['owned-probe', 'other-probe']) {
  const directory = path.join(plugins, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'openclaw.plugin.json'), JSON.stringify({ id, activation: { onStartup: true }, configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: id, type: 'module', openclaw: { extensions: ['./index.js'] } }));
  fs.writeFileSync(path.join(directory, 'index.js'), `export default { id: ${JSON.stringify(id)}, register(api) {
    for (const operation of ['run', 'describe', 'cancel']) api.registerGatewayMethod(${JSON.stringify(id)} + '.' + operation, async ({ params, respond }) => {
      try {
        if (operation === 'run') {
          const created = await api.runtime.gateway.request('sessions.create', { key: params.key, agentId: 'main', cwd: ${JSON.stringify(project)}, permissionMode: 'full', displayName: 'Execution probe' }, { scopes: ['operator.admin'] });
          const result = await api.runtime.subagent.run({ sessionKey: created.key, message: params.message, disableTools: !['fixture background', 'fixture long', 'fixture format sub'].includes(params.message), timeoutSeconds: params.timeoutSeconds ?? 120, managedToolsLifetime: 'run', idempotencyKey: params.id });
          respond(true, result);
        } else respond(true, await api.runtime.subagent[operation === 'describe' ? 'describeRun' : 'cancelRun']({ runId: params.runId }));
      } catch (error) { respond(false, undefined, { code: 'UNAVAILABLE', message: String(error) }); }
    }, { scope: 'operator.admin' });
  } };`);
}
let modelCalls = 0;
const pendingResponses = new Set();
const feedbackStages = new Map();
const feedbackLifecycle = [];
const feedbackChatEvents = [];
const feedbackEvidence = [];
let feedbackFailure;
let goalSetupReady = false;
let releaseGoalSetup;
const goalSetupGate = new Promise(resolve => { releaseGoalSetup = resolve; });
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    modelCalls++;
    const input = JSON.parse(body || '{}');
    fs.writeFileSync(path.join(base, 'provider-input-' + modelCalls + '.json'), JSON.stringify(input, null, 2));
    const content = JSON.stringify(input.messages || []);
    if (goalProbe && content.includes('fixture goal setup')) {
      const creating = !(input.messages || []).some(message => message.role === 'tool');
      if (!creating && !content.includes('fixture goal continuation')) {
        goalSetupReady = true;
        await goalSetupGate;
      }
      const tool = { id: 'fixture-create-goal', type: 'function', function: {
        name: 'tool_call', arguments: JSON.stringify({ id: 'create_goal', args: {
          objective: 'Keep the fixture objective active until the isolated probe completes.',
        } }),
      } };
      const delta = creating ? { role: 'assistant', tool_calls: [{ index: 0, ...tool }] }
        : { role: 'assistant', content: 'Goal fixture ready.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'goal-' + modelCalls, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ id: 'goal-' + modelCalls, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: creating ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    if (feedbackProbe && /fixture format (main|sub)/.test(content)) {
      try {
        const owner = /fixture format (main|sub)/.exec(content)[1];
        const stage = feedbackStages.get(owner) ?? 0;
        const file = path.join(project, 'feedback-' + owner + '.txt');
        if (stage > 0) assert.equal(fs.readFileSync(file, 'utf8'), stage === 3 && !feedbackExhausted ? 'AB' : 'A');
        if (stage === 2 || (feedbackExhausted && stage === 3)) {
          assert.ok(content.includes(feedbackCases[feedbackCase].hint));
          assert.ok(content.includes('all 2 calls were withheld, including valid siblings'));
          assert.ok((input.messages || []).some(message => message.role === 'tool'));
          assert.ok(!content.includes('private-parameter'));
          const correction = (input.messages || []).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
            .find(text => text?.includes('The previous response contained malformed tool calls'));
          assert.ok(correction, 'Missing actual correction instruction in provider request');
          assert.ok(Buffer.byteLength(correction) <= 3072);
          feedbackEvidence.push({ owner, retryAttempt: stage - 1, instructionBytes: Buffer.byteLength(correction), instruction: correction });
          if (feedbackFailureProbe) {
            if (feedbackFailureProbe === 'disconnect') { req.socket.destroy(); return; }
            res.writeHead(503, { 'Content-Type': 'application/json' });
            const message = feedbackFailureProbe === 'http-long'
              ? feedbackProviderError + ' token=synthetic-private-provider-token ' + '😀'.repeat(100000)
              : feedbackProviderError;
            res.end(JSON.stringify({ error: { message, type: 'service_unavailable', code: 'fixture_model_offline' } }));
            return;
          }
        }
        const argumentsText = JSON.stringify({ command: `node -e "require('fs').appendFileSync('feedback-${owner}.txt','${stage === 0 ? 'A' : 'B'}')"`, workdir: project });
        const toolCalls = stage === 3 && !feedbackExhausted ? [] : [{ id: 'feedback-' + owner + '-' + stage, type: 'function', function: { name: 'exec', arguments: argumentsText } }];
        if (stage === 1 || (feedbackExhausted && stage >= 2)) toolCalls.push({ id: 'feedback-invalid-' + owner + '-' + stage, type: 'function', function: { name: 'exec', arguments: feedbackCases[feedbackCase].raw } });
        feedbackStages.set(owner, stage + 1);
        assert.ok(stage < 4, 'Unexpected extra model request');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ id: 'feedback-' + modelCalls, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: toolCalls.length ? { role: 'assistant', tool_calls: toolCalls.map((tool, index) => ({ index, ...tool })) } : { role: 'assistant', content: 'Feedback probe complete.' }, finish_reason: null }] }) + '\n\n');
        res.end('data: ' + JSON.stringify({ id: 'feedback-' + modelCalls, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
        return;
      } catch (error) {
        feedbackFailure = error;
        res.writeHead(500); res.end('Synthetic feedback fixture failed'); return;
      }
    }
    if (content.includes('fixture hold')) {
      pendingResponses.add(res);
      res.on('close', () => pendingResponses.delete(res));
      return;
    }
    const long = content.includes('fixture long');
    const toolMessages = (input.messages || []).filter(m => m.role === 'tool');
    const background = (content.includes('fixture background') || long) && !toolMessages.length;
    if (content.includes('fixture background') && !background) {
      for (let i = 0; i < 50 && !fs.existsSync(path.join(project, 'owned-probe.pid')); i++) await delay(100);
    }
    let tool = { id: 'exec-background', type: 'function', function: { name: 'exec', arguments: JSON.stringify({ command: long
      ? 'node -e "require(\'fs\').writeFileSync(\'long-start.pid\',String(process.pid));setTimeout(()=>require(\'fs\').writeFileSync(\'long-done.txt\',String(Date.now())),3700000)"'
      : 'node -e "require(\'fs\').writeFileSync(\'owned-probe.pid\',String(process.pid));setInterval(()=>{},1000)"', workdir: project, background: true, timeoutSeconds: long ? 4000 : 120 }) } };
    let callsTool = background;
    if (long && !background && !fs.existsSync(path.join(project, 'long-done.txt'))) {
      const session = JSON.stringify(toolMessages).match(/session ([a-zA-Z0-9_-]+), pid/);
      if (!session) throw new Error('Missing owned long-process identity.');
      await delay(25000);
      tool = { id: 'poll-' + modelCalls, type: 'function', function: { name: 'process', arguments: JSON.stringify({ action: 'poll', sessionId: session[1], timeout: 30000 }) } };
      callsTool = true;
    }
    const message = callsTool ? { role: 'assistant', content: null, tool_calls: [tool] } : { role: 'assistant', content: 'Probe complete.' };
    const finish = callsTool ? 'tool_calls' : 'stop';
    if (input.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'probe-' + modelCalls, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: callsTool ? { role: 'assistant', tool_calls: [{ index: 0, ...tool }] } : message, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ id: 'probe-' + modelCalls, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'probe-' + modelCalls, object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    }
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let gatewayClient;
let log = '';
const config = {
  logging: { file: path.join(base, 'native-gateway.log'), level: 'debug', consoleLevel: 'info' },
  gateway: { mode: 'local', port: gatewayPort, bind: 'loopback', auth: { mode: 'token', token: gatewayToken } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: { ownership: 'explicit', entries: { main: {} }, defaults: { embeddedAgent: { cyberFailover: { mode: 'off' } }, heartbeat: { every: '0m' }, workspace: project, skipBootstrap: true, timeoutSeconds: longProbe ? 7200 : 120, model: { primary: 'fixture/fixture' } } },
  tools: { exec: { host: 'gateway', security: 'full', ask: 'off' } },
  models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: { fixture: { baseUrl: 'http://127.0.0.1:' + (gatewayPort + 1) + '/v1', apiKey: 'fixture-only', api: 'openai-completions', agentRuntime: { id: 'openclaw' }, request: { allowPrivateNetwork: true }, models: [{ id: 'fixture', name: 'fixture', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  plugins: { allow: ['owned-probe', 'other-probe'], entries: { 'owned-probe': { enabled: true }, 'other-probe': { enabled: true } } },
};
fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify(config));
const inheritedPath = process.env.PATH ?? '';
const inheritedEnvironment = { ...process.env };
for (const name of Object.keys(inheritedEnvironment)) {
  if (/^OPENCLAW_/i.test(name) || /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(name)) {
    delete inheritedEnvironment[name];
    delete process.env[name];
  }
}
const env = { ...inheritedEnvironment, PATH: path.dirname(process.execPath) + path.delimiter + inheritedPath, OPENCLAW_HOME: base, OPENCLAW_STATE_DIR: path.join(base, 'state'), OPENCLAW_CONFIG_PATH: path.join(base, 'config.json'), OPENCLAW_BUNDLED_PLUGINS_DIR: plugins, OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1', VITEST: 'true', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1' };
// The target client creates its signed device identity lazily. Import it only
// after binding both the client and Gateway to this disposable profile.
Object.assign(process.env, env);
function launch() {
  const launcher = [path.join(runtime, 'gateway-launcher.cjs')];
  child = spawn(process.execPath, [...launcher, 'gateway', 'run', '--allow-unconfigured', '--port', String(gatewayPort), '--bind', 'loopback'], { env, cwd: base, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
}
async function connect() {
  let listening = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('Isolated Gateway exited: ' + child.exitCode);
    try { listening = (await fetch('http://127.0.0.1:' + gatewayPort + '/startupz', { signal: AbortSignal.timeout(800) })).ok; }
    catch { /* A failed health read does not submit any business request. */ }
    if (listening) break;
    await delay(500);
  }
  assert.equal(listening, true, 'Isolated Gateway startup timed out');
  const { GatewayClient } = await import(pathToFileURL(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js')).href);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native authenticated Gateway handshake timed out')), 60000);
    gatewayClient = new GatewayClient({
      url: 'ws://127.0.0.1:' + gatewayPort, token: gatewayToken, env,
      clientName: 'gateway-client', mode: 'backend',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      onHelloOk: () => { clearTimeout(timer); resolve(); },
      onConnectError: error => { clearTimeout(timer); reject(error); },
      onEvent: event => {
        if ((feedbackProbe || goalProbe) && event.event === 'agent' && event.payload?.stream === 'lifecycle') feedbackLifecycle.push(event.payload);
        if (feedbackProbe && event.event === 'chat') feedbackChatEvents.push(event.payload);
      },
    });
    gatewayClient.start();
  });
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      try { return await gatewayClient.request(method, params); }
      catch (error) {
        // Only an explicit negative admission is retryable. Transport close,
        // timeout and other unknown mutator outcomes are never resubmitted.
        if (error?.retryable !== true || error?.details?.reason !== 'startup-sidecars' || attempt >= 20) throw error;
        await delay(500);
      }
    }
  };
}
async function until(rpc, runId, predicate) {
  for (let i = 0; i < 40; i++) { if (feedbackFailure) throw feedbackFailure; const state = await rpc('owned-probe.describe', { runId }); if (predicate(state)) return state; await delay(500); }
  throw new Error('Exact execution evidence did not converge: ' + runId);
}
async function stop() {
  // Retire the client and close only its own Gateway, then join transport,
  // accepted device-auth storage and process exit before restarting.
  const clientStop = gatewayClient?.stopAndWait() ?? Promise.resolve();
  gatewayClient = undefined;
  const ownedChild = child;
  const gatewayStop = ownedChild && ownedChild.exitCode === null
    ? new Promise((resolve, reject) => {
      ownedChild.once('exit', resolve);
      if (process.platform === 'win32') execFile(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(ownedChild.pid), '/T', '/F'], { windowsHide: true }, error => {
          if (error && ownedChild.exitCode === null) { ownedChild.kill(); reject(error); }
        });
      else ownedChild.kill();
    }) : Promise.resolve();
  const settled = await Promise.allSettled([clientStop, gatewayStop]);
  const failure = settled.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
(async () => {
  try {
    await new Promise(resolve => provider.listen(gatewayPort + 1, '127.0.0.1', resolve));
    launch();
    let rpc = await connect();
    const run = async (name, message, timeoutSeconds) => rpc('owned-probe.run', { key: 'agent:main:subagent:owned-probe-' + name, message, timeoutSeconds, id: 'owned-probe-' + name });
    if (goalProbe) {
      const key = 'agent:main:fixture:goal';
      const observe = async () => (await rpc('sessions.describe', { key })).session;
      const waitFor = async (read, label) => {
        for (let index = 0; index < 200; index++) { const value = await read(); if (value) return value; await delay(100); }
        throw new Error('Goal fixture did not converge: ' + label);
      };
      await rpc('sessions.create', { key, agentId: 'main', cwd: project, permissionMode: 'full' });
      const predecessor = await rpc('chat.send', { sessionKey: key, message: 'fixture goal setup. Explicitly create a goal for this isolated fixture.', idempotencyKey: 'fixture-goal-predecessor' });
      await waitFor(() => goalSetupReady, 'native create_goal result');
      const active = await observe();
      fs.writeFileSync(path.join(base, 'goal-active-observation.json'), JSON.stringify(active, null, 2));
      assert.ok(active?.goal, 'Native tool_call(create_goal) must persist the explicit fixture Goal');
      assert.equal(active.goal.status, 'active');
      assert.equal(active.goalContinuation?.predecessor, undefined);
      const request = (row, predecessorRunId, idempotencyKey) => ({
        message: 'fixture goal continuation', sessionKey: key, agentId: 'main',
        expectedExistingSessionId: row.sessionId, expectedExistingSessionLifecycleRevision: row.lifecycleRevision,
        deliver: false, suppressPromptPersistence: true, idempotencyKey,
        goalContinuation: { goalId: row.goal.id, predecessorRunId, maxAutomaticContinuations: 1, automatic: true },
      });
      await assert.rejects(rpc('agent', request(active, predecessor.runId, 'fixture-goal-unconfirmed')), /main-running/);
      releaseGoalSetup();
      assert.equal((await rpc('agent.wait', { runId: predecessor.runId, timeoutMs: 20000 })).status, 'ok');
      const settled = await waitFor(async () => {
        const value = await observe();
        return value.goalContinuation?.predecessor?.runId === predecessor.runId && value.goalContinuation.predecessor.executionSettled === true ? value : undefined;
      }, 'exact persisted whole-run predecessor');
      const payload = request(settled, predecessor.runId, 'fixture-goal-successor');
      const accepted = await rpc('agent', payload);
      assert.equal(accepted.runId, payload.idempotencyKey);
      assert.equal(accepted.goalContinuation.continuationTurns, 1);
      const replay = await rpc('agent', payload);
      assert.equal(replay.runId, accepted.runId);
      assert.equal((await rpc('agent.wait', { runId: accepted.runId, timeoutMs: 20000 })).status, 'ok');
      const successor = await waitFor(async () => {
        const value = await observe();
        return value.goalContinuation?.predecessor?.runId === accepted.runId ? value : undefined;
      }, 'successor native terminal');
      assert.equal(successor.goal.continuationTurns, 1);
      await assert.rejects(rpc('agent', request(successor, accepted.runId, 'fixture-goal-over-limit')), /limit-reached/);
      assert.equal((await observe()).goal.continuationTurns, 1);
      assert.equal(feedbackLifecycle.filter(event => event.runId === predecessor.runId && event.data?.executionSettled === true).length, 1);
      assert.equal(feedbackLifecycle.filter(event => event.runId === accepted.runId && event.data?.executionSettled === true).length, 1);
      assert.equal(modelCalls, 3, 'Two setup requests and one successor; rejected or replayed admissions cannot dispatch');
      fs.writeFileSync(path.join(base, 'goal-result.json'), JSON.stringify({ accepted, replay, successor, modelCalls, passed: true }, null, 2));
      console.log('PASS exact whole-run Goal predecessor, deferred live turn, atomic count, replay and limit');
      return;
    }
    if (feedbackProbe) {
      const key = feedbackOwner === 'sub' ? 'agent:main:subagent:owned-probe-feedback' : 'agent:main:feedback-main';
      if (feedbackOwner === 'main') await rpc('sessions.create', { key, agentId: 'main', cwd: project, permissionMode: 'full' });
      if (feedbackOwner === 'main') await rpc('sessions.messages.subscribe', { key });
      const main = feedbackOwner === 'sub' ? await run('feedback', 'fixture format sub')
        : await rpc('chat.send', { sessionKey: key, message: 'fixture format main', idempotencyKey: 'format-main' });
      if (feedbackOwner === 'sub') await rpc('sessions.messages.subscribe', { key });
      // A wait timeout does not settle or restart execution. Poll the same run
      // within its configured two-minute budget, including cold-start queueing.
      let mainResult;
      let waitTimeouts = 0;
      do {
        mainResult = await rpc('agent.wait', { runId: main.runId, timeoutMs: 20000 });
        if (mainResult.status === 'timeout') waitTimeouts++;
      } while (mainResult.status === 'timeout' && waitTimeouts < 6);
      if (feedbackFailure) throw feedbackFailure;
      const expectsError = Boolean(feedbackFailureProbe || feedbackExhausted);
      assert.equal(mainResult.status, expectsError ? 'error' : 'ok');
      const mainTerminal = () => feedbackLifecycle.find(event => event.runId === main.runId && event.sessionKey === key &&
        event.data?.executionSettled === true && ['end', 'error'].includes(event.data.phase));
      for (let index = 0; index < 60 && !mainTerminal(); index++) await delay(100);
      assert.equal(mainTerminal()?.data.phase, expectsError ? 'error' : 'end', 'Missing exact whole-run execution-settled terminal');
      const record = result => fs.writeFileSync(path.join(base, 'feedback-result.json'), JSON.stringify({ case: feedbackCase, failure: feedbackFailureProbe ?? null,
        owner: feedbackOwner, modelCalls, waitTimeouts, feedback: feedbackEvidence, ...result, passed: result.waitErrorPreserved !== false }, null, 2));
      if (expectsError) {
        const errors = feedbackChatEvents.filter(event => event.runId === main.runId && event.sessionKey === key && event.state === 'error');
        fs.writeFileSync(path.join(base, 'feedback-observation.json'), JSON.stringify({ result: mainResult, terminal: mainTerminal().data, errors }, null, 2));
        const expectedReason = feedbackExhausted ? /couldn't finish this reply/i : feedbackFailureProbe === 'disconnect' ? /couldn't connect to the AI service/i
          : feedbackFailureProbe === 'http-long' ? /the AI service is (?:temporarily overloaded|having trouble)/i
            : /temporarily overloaded/i;
        // The native owner deliberately publishes safe classified copy, not raw HTTP bodies.
        const summary = String(mainResult.error ?? '').slice(0, 300).replaceAll('synthetic-private-provider-token', '[REDACTED]').replaceAll('😀', '*');
        assert.ok(errors.some(event => expectedReason.test(event.errorMessage ?? '')), 'Latest safe provider failure did not reach chat: ' + JSON.stringify({ summary, eventCount: errors.length }));
        assert.match(mainTerminal().data.error, expectedReason);
        for (const error of errors) {
          assert.match(error.errorMessage ?? '', expectedReason, 'Every final error must retain the latest cause');
          if (!feedbackExhausted) assert.ok(!/malformed tool call|couldn't generate a response/i.test(error.errorMessage ?? ''));
          assert.ok(!JSON.stringify(error).includes('😀'));
        }
        for (const publicError of [...errors, mainResult, mainTerminal().data]) {
          const serialized = JSON.stringify(publicError);
          assert.ok(Buffer.byteLength(serialized) < 3072);
          assert.ok(!serialized.includes('synthetic-private-provider-token'));
        }
        assert.equal(feedbackStages.get(feedbackOwner), feedbackExhausted ? 4 : 2);
        assert.equal(fs.readFileSync(path.join(project, 'feedback-' + feedbackOwner + '.txt'), 'utf8'), 'A');
        const retries = feedbackLifecycle.filter(event => event.runId === main.runId && event.sessionKey === key && event.data?.reason === 'tool_call_format');
        assert.deepEqual(retries.map(event => event.data.retryAttempt), feedbackExhausted ? [1, 2] : [1]);
        let ownedResult;
        if (feedbackOwner === 'sub') {
          ownedResult = await until(rpc, main.runId, state => state.state === 'settled');
          assert.equal(ownedResult.outcome, 'error');
          assert.equal(ownedResult.executionSettled, true);
          assert.equal(ownedResult.cleanupSettled, true);
        }
        record({ result: mainResult, terminal: mainTerminal().data, errors, ownedResult, writes: 'A', retries: retries.length,
          waitErrorPreserved: expectedReason.test(mainResult.error ?? '') });
        assert.match(mainResult.error, expectedReason, 'Latest failure was lost by agent.wait despite specific chat and settled lifecycle errors');
        console.log('PASS ' + feedbackOwner + ' ' + (feedbackFailureProbe || feedbackCase) + ': latest safe error, exact settlement, no replay, retries=' + retries.length);
        return;
      }
      assert.equal(feedbackOwner, 'main', 'Successful scenario probes both main and sub automatically');
      const sub = await run('feedback', 'fixture format sub');
      await rpc('sessions.messages.subscribe', { key: sub.sessionKey ?? 'agent:main:subagent:owned-probe-feedback' });
      const result = await until(rpc, sub.runId, state => state.state === 'settled');
      assert.equal(result.executionSettled, true);
      assert.equal(result.cleanupSettled, true);
      assert.equal(result.outcome, 'ok');
      for (const [runId, sessionKey] of [[main.runId, key], [sub.runId, sub.sessionKey ?? 'agent:main:subagent:owned-probe-feedback']]) {
        assert.equal(feedbackLifecycle.filter(event => event.runId === runId && event.sessionKey === sessionKey &&
          event.data?.reason === 'tool_call_format' && event.data.retryAttempt === 1).length, 1);
      }
      for (const owner of ['main', 'sub']) {
        assert.equal(feedbackStages.get(owner), 4);
        assert.equal(fs.readFileSync(path.join(project, 'feedback-' + owner + '.txt'), 'utf8'), 'AB');
      }
      record({ result: mainResult, subResult: result, writes: { main: 'AB', sub: 'AB' }, retries: { main: 1, sub: 1 } });
      console.log('PASS ' + feedbackCase + ' main chat.send and actual runtime.subagent.run: specific feedback, preserved results, whole-batch zero dispatch, each write once');
      return;
    }
    const first = await run('plain', 'fixture normal');
    const complete = await until(rpc, first.runId, s => s.state === 'settled');
    assert.equal(complete.executionSettled, true); assert.equal(complete.cleanupSettled, true);
    await assert.rejects(rpc('other-probe.describe', { runId: first.runId }), /does not own/);
    console.log('PASS durable tool-free settlement and cross-plugin ownership');
    const background = await run('background', 'fixture background');
    const backgroundState = await until(rpc, background.runId, s => s.state === 'settled');
    if (!fs.existsSync(path.join(project, 'owned-probe.pid'))) {
      fs.writeFileSync(path.join(base, 'background-history.json'), JSON.stringify(await rpc('chat.history', { sessionKey: background.sessionKey ?? 'agent:main:subagent:owned-probe-background', limit: 10 }), null, 2));
      throw new Error('Background command did not start: ' + JSON.stringify(backgroundState));
    }
    const pid = Number(fs.readFileSync(path.join(project, 'owned-probe.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0));
    console.log('PASS background process extinction before cleanup settlement');
    const held = await run('cancel', 'fixture hold cancel');
    await until(rpc, held.runId, s => s.state === 'running');
    assert.equal((await rpc('owned-probe.cancel', { runId: held.runId })).accepted, true);
    const cancelled = await until(rpc, held.runId, s => s.state === 'settled');
    assert.equal(cancelled.cancelled, true);
    console.log('PASS exact cancellation convergence');
    const interrupted = await run('restart', 'fixture hold restart');
    await until(rpc, interrupted.runId, s => s.state === 'running');
    await stop();
    for (const response of pendingResponses) response.destroy();
    launch(); rpc = await connect();
    assert.equal((await rpc('owned-probe.describe', { runId: first.runId })).state, 'settled');
    assert.equal((await rpc('owned-probe.describe', { runId: interrupted.runId })).state, 'unknown');
    await assert.rejects(rpc('owned-probe.cancel', { runId: interrupted.runId }), /uncertain/);
    console.log('PASS durable evidence and unknown interrupted execution after restart');
    if (longProbe) {
      const started = Date.now();
      const long = await rpc('owned-probe.run', { key: 'agent:main:subagent:owned-probe-long', id: 'owned-probe-long', message: 'fixture long', timeoutSeconds: 7200 });
      let observed;
      for (let i = 0; i < 440; i++) {
        observed = await rpc('owned-probe.describe', { runId: long.runId });
        if (observed.state === 'settled') break;
        if (i % 30 === 0) console.log('LONG running ' + Math.round((Date.now() - started) / 1000) + 's');
        await delay(10000);
      }
      assert.equal(observed.state, 'settled');
      assert.equal(observed.outcome, 'ok');
      assert.equal(observed.cleanupSettled, true);
      assert.ok(Date.now() - started > 3600000);
      assert.ok(fs.existsSync(path.join(project, 'long-done.txt')));
      fs.writeFileSync(path.join(base, 'long-result.json'), JSON.stringify({ elapsedMs: Date.now() - started, observed }, null, 2));
      console.log('PASS real >1-hour native execution and cleanup');
    }
    fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({ complete, cancelled, modelCalls, passed: true }, null, 2));
  } catch (error) { console.error(String(error).replaceAll(gatewayToken, '<fixture-token>')); console.error(log.slice(-7000).replaceAll(gatewayToken, '<fixture-token>')); if (fs.existsSync(path.join(base, 'native-gateway.log'))) console.error(fs.readFileSync(path.join(base, 'native-gateway.log'), 'utf8').slice(-8000).replaceAll(gatewayToken, '<fixture-token>')); process.exitCode = 1; }
  finally { releaseGoalSetup(); await stop(); for (const response of pendingResponses) response.destroy(); provider.close(); fs.writeFileSync(path.join(base, 'gateway.log'), log.replaceAll(gatewayToken, '<fixture-token>')); console.log('FIXTURE ' + base); }
})().catch(error => { console.error(error); process.exitCode = 1; });
