// Offline integration: real Gateway/worker execution against a loopback-only model fixture.
// Add --run-progress to check slow 64 KiB tool arguments, live metadata and whole-run settlement.
// --buffered-run-progress uses legacy function_call frames to exercise pre-public-event activity.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
(async () => {
  const root = path.resolve(process.argv[2] || 'vendor/openclaw-runtime/current');
  const bufferedRunProgress = process.argv.includes('--buffered-run-progress');
  const checkRunProgress = bufferedRunProgress || process.argv.includes('--run-progress');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-chat-stream-smoke-'));
  const workspace = path.join(state, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'read-fixture.txt'), 'native-tool-read-evidence');
  const token = randomBytes(24).toString('hex');
  const events = []; let requests = 0; let toolRequested = false; let toolResultSeen = false;
  const toolCallId = 'fixture-read-call';
  let expectedRunId; let expectedSessionKey; let replayActivityConfirmed = false; let providerFailure; let argumentChars = 0; let progressBeforeArgumentsEnd = false;
  const progressEvents = () => events.filter(event => event.event === 'agent' &&
    event.payload?.runId === expectedRunId && event.payload.stream === 'item' &&
    event.payload.data?.itemId === 'run-stream-progress');
  const requestActivityEvents = () => events.filter(event => event.event === 'agent' &&
    event.payload?.runId === expectedRunId && event.payload.stream === 'item' &&
    event.payload.data?.itemId === 'run-request-activity');
  const toolStarted = () => events.some(event => event.payload?.runId === expectedRunId &&
    (event.event === 'session.tool' || event.event === 'agent' && event.payload.stream === 'tool') &&
    (event.payload.data?.phase ?? event.payload.phase) === 'start');
  const provider = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body); requests++;
    const toolResult = parsed.messages?.find(message => message.role === 'tool');
    toolResultSeen ||= Boolean(toolResult && JSON.stringify(toolResult).includes('native-tool-read-evidence'));
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = delta => response.write('data: ' + JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', created: 1, model: 'review-model', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    send({ role: 'assistant' });
    const tools = parsed.tools?.map(tool => tool.function?.name) || [];
    if (!toolResult && tools.length) {
      if (!tools.includes('read')) throw new Error('Native read missing from model tools: ' + tools.join(','));
      toolRequested = true;
      send({ reasoning_content: 'Inspecting the isolated fixture before answering.' });
      await new Promise(resolve => setTimeout(resolve, 100));
      send({ content: 'Reading the fixture now.' });
      const args = JSON.stringify({ path: path.join(workspace, 'read-fixture.txt') });
      if (checkRunProgress) {
        try {
          // Legal JSON whitespace makes the native read input large without changing its arguments.
          const streamedArgs = args.slice(0, -1) + ' '.repeat(64 * 1024) + '}';
          argumentChars = streamedArgs.length;
          for (let offset = 0; offset < streamedArgs.length; offset += 4096) {
            assert.equal(toolStarted(), false, 'native tool must wait for complete argument delivery');
            const first = offset === 0;
            const functionDelta = { ...(first ? { name: 'read' } : {}),
              arguments: streamedArgs.slice(offset, offset + 4096) };
            send(bufferedRunProgress ? { function_call: functionDelta } : { tool_calls: [{
              index: 0, ...(first ? { id: toolCallId, type: 'function' } : {}), function: functionDelta,
            }] });
            if (offset === 5 * 4096) {
              await waitFor(() => bufferedRunProgress ? requestActivityEvents().length >= 2 :
                progressEvents().filter(event => {
                  const progress = event.payload.data.progress;
                  return progress?.kind === 'tool-input' && progress.toolCallId === toolCallId &&
                    progress.complete === false && progress.receivedChars > 0;
                }).length >= 2, 'argument progress before remaining input is sent', 10_000);
              if (bufferedRunProgress) assert.equal(progressEvents().some(event =>
                event.payload.data.progress?.kind === 'tool-input'), false,
              'legacy arguments stay provisional until terminal');
              assert.equal(toolStarted(), false, 'argument observations cannot start the native tool');
              // Only this request is open at the barrier; subsequent model calls have independent throttles.
              const activityTimes = requestActivityEvents().map(event => event.payload.data.at);
              assert.ok(activityTimes.length >= 2, 'request activity before argument completion');
              for (let index = 1; index < activityTimes.length; index++)
                assert.ok(activityTimes[index] - activityTimes[index - 1] >= 1000, 'per-request activity throttle');
              const replay = await client.request('chat.history', { sessionKey: expectedSessionKey, limit: 1 });
              assert.equal(replay.inFlightRun?.runId, expectedRunId);
              const statusItems = replay.inFlightRun?.events?.filter(event => event.stream === 'item' &&
                ['run-request-activity', 'run-stream-progress'].includes(event.data?.itemId)) || [];
              assert.ok(statusItems.length <= 2, 'activity snapshots are bounded by the two item IDs');
              const retainedActivity = statusItems.find(event => event.data.itemId === 'run-request-activity');
              const retainedAt = retainedActivity?.data.at;
              assert.ok(Number.isSafeInteger(retainedAt) && retainedAt >= activityTimes.at(-1),
                'replay retains the source activity time without rewinding');
              await waitFor(() => requestActivityEvents().some(event => event.payload.data.at === retainedAt),
                'wire event matching the native activity snapshot', 5_000);
              if (!bufferedRunProgress) assert.ok(statusItems.some(event =>
                event.data.itemId === 'run-stream-progress' && event.data.progress?.kind === 'tool-input'),
              'detailed argument progress is retained independently');
              replayActivityConfirmed = true;
              progressBeforeArgumentsEnd = true;
            }
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        } catch (error) {
          providerFailure = error;
          response.destroy();
          return;
        }
      } else {
        send({ tool_calls: [{ index: 0, id: toolCallId, type: 'function', function: { name: 'read', arguments: args } }] });
      }
      response.write('data: ' + JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: bufferedRunProgress ? 'function_call' : 'tool_calls' }] }) + '\n\n');
    } else {
      send({ reasoning_content: 'The file was checked.' });
      send({ content: 'Fixture verified: native-tool-read-evidence.' });
      response.write('data: ' + JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const modelPort = provider.address().port;
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    update: { checkOnStart: false, auto: { enabled: false } },
    models: { catalogRefresh: { enabled: false }, mode: 'replace', providers: { fixture: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', apiKey: 'isolated-fixture-key', models: [{ id: 'review-model', name: 'Fixture', reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 1024 }] } } },
    agents: { entries: { main: {} }, defaults: { workspace, model: { primary: 'fixture/review-model' }, thinkingDefault: 'high', verboseDefault: 'full', systemAgent: { agentId: 'main' } } },
    tools: { codeMode: { enabled: false } },
    plugins: { allow: ['memory-core', ...(process.argv.includes('--browser-pairing') ? ['browser'] : [])], entries: { 'memory-core': { enabled: true } } },
  };
  fs.writeFileSync(path.join(state, 'openclaw.json'), JSON.stringify(config));
  const env = { ...process.env, OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'), OPENCLAW_NO_RESPAWN: '1' };
  Object.assign(process.env, { OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json') });
  let output = ''; let client;
  const child = spawn(process.execPath, [path.join(root, 'gateway-launcher.cjs'), 'gateway', 'run', '--allow-unconfigured', '--port', String(port)], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  const waitFor = async (predicate, label, timeout = 60000) => { const deadline = Date.now() + timeout; while (!predicate()) { if (providerFailure) throw providerFailure; if (child.exitCode !== null) throw new Error('Gateway exited: '+child.exitCode); if (Date.now() > deadline) throw new Error(label+' timed out'); await new Promise(resolve => setTimeout(resolve, 100)); } };
  const deadline = setTimeout(() => child.kill(), 150000);
  try {
    const file = fs.readdirSync(path.join(root, 'dist')).find(name => /^client-.*\.mjs$/.test(name) && fs.readFileSync(path.join(root, 'dist', name), 'utf8').includes('GatewayClient as t'));
    const { t: GatewayClient } = await import(pathToFileURL(path.join(root, 'dist', file)).href);
    let connected = false;
    client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token, sharedStateMode: 'read-only', deviceIdentity: null, clientName: 'gateway-client', mode: 'backend', caps: ['tool-events'], scopes: ['operator.admin'], onHelloOk: () => connected = true, onEvent: event => events.push(event) });
    client.start(); await waitFor(() => connected, 'connect');
    const key = 'agent:main:justdo:stream-smoke';
    await client.request('sessions.create', { key, cwd: workspace, permissionMode: 'guarded' });
    await client.request('sessions.messages.subscribe', { key });
    const runId = 'fixture-run-' + randomBytes(6).toString('hex');
    expectedRunId = runId;
    expectedSessionKey = key;
    await client.request('chat.send', { sessionKey: key, message: 'Read read-fixture.txt and confirm its exact contents.', idempotencyKey: runId });
    await waitFor(() => events.some(event => event.event === 'chat' && event.payload?.runId === runId && ['final','error','aborted'].includes(event.payload.state)), 'terminal');
    const terminal = events.find(event => event.event === 'chat' && event.payload?.runId === runId && ['final', 'error', 'aborted'].includes(event.payload.state));
    assert.equal(terminal.payload.state, 'final', JSON.stringify(terminal.payload));
    if (checkRunProgress) {
      await waitFor(() => events.some(event => event.event === 'agent' &&
        event.payload?.runId === runId && event.payload.stream === 'lifecycle' &&
        event.payload.data?.executionSettled === true), 'whole-run execution settlement');
      const settled = events.find(event => event.event === 'agent' &&
        event.payload?.runId === runId && event.payload.stream === 'lifecycle' &&
        event.payload.data?.executionSettled === true);
      assert.equal(settled.payload.data.phase, 'end', JSON.stringify(settled.payload.data));
      assert.notEqual(settled.payload.data.aborted, true);
      const terminalModule = fs.readdirSync(path.join(root, 'dist')).find(name =>
        /^agent-run-terminal-outcome-.*\.mjs$/.test(name) &&
        fs.readFileSync(path.join(root, 'dist', name), 'utf8').includes('resolveAgentRunLifecycleTerminalFacts as u'));
      assert.ok(terminalModule, 'native lifecycle outcome classifier');
      const { u: resolveTerminalFacts, i: classifyTerminal } = await import(pathToFileURL(path.join(root, 'dist', terminalModule)).href);
      assert.equal(classifyTerminal(resolveTerminalFacts({ phase: 'end', data: settled.payload.data })), 'success',
        'whole-run settlement must be successful, not cancelled, timed out or failed');
      assert.equal(progressBeforeArgumentsEnd, true, 'progress must cross the real wire before all arguments arrive');
      assert.equal(replayActivityConfirmed, true, 'native snapshots must retain activity during streaming');
      const observations = progressEvents();
      const requestActivity = requestActivityEvents();
      assert.ok(requestActivity.length >= 2, 'multiple real request activity observations');
      for (const event of requestActivity) {
        const data = event.payload.data;
        assert.equal(event.payload.sessionKey, key);
        assert.deepEqual(Object.keys(data).sort(), ['at', 'itemId', 'kind', 'phase', 'progress', 'status', 'title']);
        assert.deepEqual(data.progress, { kind: 'model-activity' });
        assert.ok(Number.isSafeInteger(data.at) && data.at > 0);
        assert.equal(data.kind, 'status'); assert.equal(data.phase, 'update');
        assert.equal(data.status, 'running');
      }
      assert.ok(observations.length > 2, 'multiple live native progress observations');
      for (const event of observations) {
        const data = event.payload.data;
        assert.equal(event.payload.sessionKey, key);
        assert.ok(Number.isSafeInteger(event.payload.seq) && event.payload.seq > 0, 'native sequence');
        assert.deepEqual(Object.keys(data).sort(), ['itemId', 'kind', 'phase', 'progress', 'status', 'title']);
        assert.equal(data.kind, 'status'); assert.equal(data.phase, 'update'); assert.equal(data.status, 'running');
        const progress = data.progress;
        assert.ok(Number.isSafeInteger(progress.receivedChars) && progress.receivedChars >= 0);
        if (progress.kind === 'tool-input') {
          assert.deepEqual(Object.keys(progress).sort(), ['complete', 'kind', 'name', 'receivedChars', 'toolCallId']);
          assert.equal(progress.name, 'read');
          if (!bufferedRunProgress) assert.equal(progress.toolCallId, toolCallId);
          else assert.match(progress.toolCallId, /^call_[0-9a-f]{24}$/);
        } else {
          assert.equal(progress.kind, 'model');
          assert.deepEqual(Object.keys(progress).sort(), ['kind', 'receivedChars']);
        }
      }
      const toolInput = observations.filter(event => event.payload.data.progress.kind === 'tool-input');
      const counts = toolInput.map(event => event.payload.data.progress.receivedChars);
      if (!bufferedRunProgress)
        assert.ok(new Set(counts).size >= 3, 'argument counters must increase over the actual stream');
      assert.deepEqual(counts, [...counts].sort((a, b) => a - b));
      assert.deepEqual(toolInput.at(-1).payload.data.progress, {
        kind: 'tool-input', toolCallId: bufferedRunProgress ? toolInput.at(-1).payload.data.progress.toolCallId : toolCallId,
        name: 'read', receivedChars: argumentChars, complete: true,
      });
      const metadata = JSON.stringify([...observations, ...requestActivity].map(event => event.payload.data));
      assert.ok(!metadata.includes('read-fixture.txt') && !metadata.includes(workspace), 'progress contains no argument path');
      assert.ok(!metadata.includes('Inspecting the isolated fixture') && !metadata.includes('The file was checked'), 'progress contains no model text');
      assert.ok(!metadata.includes(' '.repeat(4096)), 'progress contains no argument fragments');
    }
    const streams = new Set(events.filter(event => event.event === 'agent' && event.payload?.runId === runId).map(event => event.payload.stream));
    assert.ok(toolRequested && toolResultSeen, 'native read must execute and return fixture bytes');
    assert.ok(streams.has('thinking'), 'live Thinking'); assert.ok(streams.has('tool') || events.some(event => event.event === 'session.tool' && event.payload?.runId === runId), 'live Tool'); assert.ok(streams.has('assistant'), 'live Content');
    const history = await client.request('chat.history', { sessionKey: key, limit: 50 });
    assert.ok(JSON.stringify(history.messages).includes('native-tool-read-evidence'), 'persisted history');
    if (process.argv.includes('--browser-pairing')) {
      // The production pairing command uses the public CLI, not the Gateway bundle.
      const { prepareWindowsRuntimeCleanup } = require('../../../src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs');
      const preload = prepareWindowsRuntimeCleanup(root);
      const cliEnv = { ...env };
      if (preload) cliEnv.NODE_OPTIONS = [cliEnv.NODE_OPTIONS, `--require="${preload.replace(/\\/g, '/')}"`].filter(Boolean).join(' ');
      let paired;
      try {
        const result = await promisify(execFile)(process.execPath, [
          '-e', "process.argv[0]='node';import(require('node:url').pathToFileURL(process.argv[1]).href)",
          path.join(root, 'openclaw.mjs'), 'browser', 'extension', 'pair', '--local-gateway', '--json',
        ], { env: cliEnv, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
        paired = JSON.parse(result.stdout);
      } catch (error) {
        // CLI stdout contains the pairing credential; never print the child error.
        throw new Error(`Isolated browser pairing CLI failed (code=${error.code ?? 'parse'}, killed=${error.killed === true})`);
      }
      assert.equal(typeof paired.pairingString, 'string');
      const snapshot = await client.request('config.get', {});
      await client.request('config.patch', {
        baseHash: snapshot.hash,
        raw: JSON.stringify({ browser: { enabled: true, defaultProfile: 'chrome', profiles: { chrome: { driver: 'extension' } } } }),
      });
      const effective = await client.request('config.get', {});
      assert.equal(effective.valid, true);
      assert.equal(effective.config.browser.defaultProfile, 'chrome');
      // Allow asynchronous config reload/retirement to run before reading again.
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    for (let round = 0; round < 3; round++) {
      await client.request('chat.history', { sessionKey: key, limit: 50 });
      await client.request('progressCard.get', { sessionKey: key });
      await client.request('cron.runs', { scope: 'all', limit: 10, offset: 0, sortDir: 'desc' });
    }
    console.log(JSON.stringify({ ok: true, requests, streams: [...streams], nativeRead: toolResultSeen, liveSessionTool: events.some(event => event.event === 'session.tool' && event.payload?.runId === runId), historyMessages: history.messages.length, ...(checkRunProgress ? { bufferedRunProgress, argumentChars, progressObservations: progressEvents().length, requestActivityObservations: requestActivityEvents().length, progressBeforeArgumentsEnd, replayActivityConfirmed } : {}), state }));
  } finally {
    clearTimeout(deadline); if(client) await client.stopAndWait().catch(() => client.stop()); child.kill(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    fs.writeFileSync(path.join(state, 'smoke.log'), output.replaceAll(token, '<fixture-token>')); console.log('Smoke log: '+path.join(state, 'smoke.log'));
  }
})().catch(error => { console.error(error); process.exitCode=1; });
