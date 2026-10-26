import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Real group and summary services with disposable state and a loopback model.
// Usage: node scripts/test/agent-team/verify-group-discussion-runtime.mjs [runtime-directory] [--tool-inheritance]
// No live configuration, credentials or user history is read or modified.
const root = path.resolve(import.meta.dirname, '../../..');
const args = process.argv.slice(2);
const toolInheritanceOnly = args.includes('--tool-inheritance');
const runtime = path.resolve(
  args.find(argument => !argument.startsWith('--')) ??
    path.join(root, 'vendor/openclaw-runtime/current'),
);
const base = path.join(root, '.tmp', 'group-mode-native-' + randomUUID());
const workspace = path.join(base, 'project');
await mkdir(workspace, { recursive: true });
const requests = [];
const terminals = new Map();
let missingTools;
const model = http.createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  // Native inter-session inputs can include the internal-context wrapper. Select
  // the latest synthetic task itself, including a wrapped summary handoff.
  let lastInput = body.messages?.findLastIndex(
    message =>
      message.role === 'user' &&
      (JSON.stringify(message.content).includes('FIXTURE_') ||
        JSON.stringify(message.content).includes('A group discussion has ended.')),
  );
  if (lastInput === undefined || lastInput < 0)
    lastInput = body.messages?.findLastIndex(message => message.role === 'user') ?? -1;
  const last = JSON.stringify(body.messages?.[lastInput]?.content ?? '');
  const second = JSON.stringify(body.messages ?? []).includes('Group thread round 2.');
  const slow = last.includes('FIXTURE_SLOW');
  const failed = last.includes('FIXTURE_FAIL');
  const silent = last.includes('FIXTURE_SILENT');
  const summary = last.includes('A group discussion has ended.');
  const toolStage = summary
    ? 'continuation'
    : last.includes('FIXTURE_TOOL_MEMBER')
      ? 'member'
      : last.includes('FIXTURE_BORROWED')
        ? 'borrowed'
        : undefined;
  const toolFinished = body.messages?.slice(lastInput + 1).some(message => message.role === 'tool');
  const toolNames = (body.tools ?? []).map(tool => tool.function?.name);
  const request = {
    second,
    slow,
    failed,
    silent,
    summary,
    toolStage,
    toolFinished,
    tools: toolNames.length,
    toolNames,
    lastInputIndex: lastInput,
    lastInputExcerpt: last.length > 1600 ? `${last.slice(0, 800)}\n...\n${last.slice(-800)}` : last,
    responsePhase: 'pending',
  };
  requests.push(request);
  if (failed) {
    request.responsePhase = 'provider-error';
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: 'isolated group fixture provider failure',
          type: 'invalid_request_error',
        },
      }),
    );
    return;
  }
  if (slow) await new Promise(resolve => setTimeout(resolve, 8000));
  if (res.destroyed) {
    request.responsePhase = 'disconnected';
    return;
  }
  if (toolStage && !toolFinished) {
    if (!toolNames.includes('write') && !toolNames.includes('tool_call')) {
      request.responsePhase = 'missing-tools';
      missingTools = new Error(`${toolStage} must retain source write tools`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: missingTools.message, type: 'invalid_request_error' } }),
      );
      return;
    }
    const args = {
      path: path.join(workspace, `${toolStage}-finished.txt`),
      content: `FIXTURE_${toolStage.toUpperCase()}_COMPLETE`,
    };
    const direct = toolNames.includes('write');
    request.responsePhase = 'tool_call';
    request.selectedToolName = direct ? 'write' : 'tool_call';
    request.deferredToolName = direct ? undefined : 'write';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          id: randomUUID(),
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `fixture_${toolStage}`,
                    type: 'function',
                    function: {
                      name: direct ? 'write' : 'tool_call',
                      arguments: JSON.stringify(direct ? args : { id: 'write', args }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
    return;
  }
  const text = second || silent ? 'NO_REPLY' : 'FIXTURE_RESULT_' + requests.length;
  request.responsePhase = text === 'NO_REPLY' ? 'silent' : 'final';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        id: randomUUID(),
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const token = randomBytes(24).toString('hex');
const configPath = path.join(base, 'config.json');
await writeFile(
  configPath,
  JSON.stringify({
    logging: { file: path.join(base, 'native.log'), level: 'debug', consoleLevel: 'debug' },
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    update: { checkOnStart: false, auto: { enabled: false } },
    agents: {
      ownership: 'explicit',
      entries: { main: { name: 'Main' }, alice: { name: 'Alice' }, bob: { name: 'Bob' } },
      defaults: {
        workspace,
        skipBootstrap: true,
        heartbeat: { every: '0m' },
        model: { primary: 'fixture/fixture' },
        systemAgent: { agentId: 'main' },
        compaction: { memoryFlush: { enabled: false } },
      },
    },
    models: {
      mode: 'replace',
      catalogRefresh: { enabled: false },
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
          api: 'openai-completions',
          apiKey: 'isolated-fixture',
          agentRuntime: { id: 'openclaw' },
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: 'fixture',
              name: 'Fixture',
              input: ['text'],
              contextWindow: 200000,
              maxTokens: 1000,
            },
          ],
        },
      },
    },
    tools: {
      profile: 'full',
      codeMode: { enabled: false },
      toolSearch: { enabled: true, mode: 'directory' },
    },
    surfaces: { 'justdo-team': { silentReply: { group: 'allow' } } },
    session: { maintenance: { mode: 'warn', coldStorage: { enabled: false, afterDays: 30 } } },
    plugins: {
      slots: { memory: 'none' },
      allow: ['openai', 'agent-team', 'runtime-services'],
      entries: {
        openai: { enabled: true },
        'agent-team': { enabled: true },
        'runtime-services': { enabled: true },
      },
    },
  }),
);
const env = {
  ...process.env,
  OPENCLAW_HOME: base,
  OPENCLAW_STATE_DIR: base,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_RESPAWN: '1',
};
for (const name of [
  'VITEST',
  'OPENCLAW_BUNDLED_PLUGINS_DIR',
  'OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR',
]) {
  delete env[name];
  delete process.env[name];
}
Object.assign(process.env, env);
const { GatewayClient } = await import(
  pathToFileURL(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js'))
);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 90000, { checkModel = true } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (checkModel && missingTools) throw missingTools;
    const value = await check();
    if (value) return value;
    await pause(250);
  }
  throw Error('Timeout: ' + label);
}
let child,
  client,
  output = '';
nativeProbe: try {
  child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('message',m=>{if(m==='stop')process.emit('SIGTERM');});const entry=process.argv[1];process.argv=[process.execPath,...process.argv.slice(1)];import(require('node:url').pathToFileURL(entry).href);",
      path.join(runtime, 'gateway-launcher.cjs'),
      'gateway',
      'run',
      '--allow-unconfigured',
      '--port',
      String(port),
    ],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', data => {
      output += data;
    });
  await until(async () => {
    if (child.exitCode !== null) throw Error('Gateway exit ' + child.exitCode);
    try {
      return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(700) }))
        .ok;
    } catch {
      return false;
    }
  }, 'Gateway ready');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Handshake timeout')), 20000);
    client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientName: 'gateway-client',
      mode: 'backend',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      onHelloOk: () => {
        clearTimeout(timer);
        resolve();
      },
      onConnectError: error => {
        clearTimeout(timer);
        reject(error);
      },
      onEvent: frame => {
        const event = frame.payload;
        if (
          frame.event === 'agent' &&
          event?.stream === 'lifecycle' &&
          event.data?.executionSettled === true &&
          ['end', 'error'].includes(event.data.phase)
        )
          terminals.set(event.runId, event);
      },
    });
    const request = client.request.bind(client);
    client.request = (method, params, options) =>
      request(method, params, { timeoutMs: 75000, ...options });
    client.start();
  });
  const sourceKey = 'agent:main:justdo:source';
  await client.request('sessions.create', {
    key: sourceKey,
    cwd: workspace,
    permissionMode: 'full',
  });
  const described = await client.request('teamDiscussion.summary', {
    operation: 'source',
    sessionKey: sourceKey,
  });
  assert.ok(described.source?.sessionId);
  const source = { ...described.source, agentId: 'main', sessionKey: sourceKey };
  const sourceSubscription = await client.request('sessions.messages.subscribe', {
    key: sourceKey,
    agentId: source.agentId,
  });
  assert.equal(sourceSubscription.subscribed, true);
  const initial = await client.request('chat.send', {
    sessionKey: sourceKey,
    message:
      'FIXTURE_SOURCE_TASK: after the group discussion, finish the authorized task by writing continuation-finished.txt in this project.',
    idempotencyKey: randomUUID(),
  });
  const initialTerminal = await client.request(
    'agent.wait',
    { runId: initial.runId, timeoutMs: 60000 },
    { timeoutMs: 75000 },
  );
  assert.equal(initialTerminal.status, 'ok');
  async function prepare(id, borrowed = false) {
    const result = await client.request('teamDiscussion.prepare', {
      roomId: id,
      cwd: workspace,
      agentIds: ['alice', 'bob'],
      permissionMode: 'ask',
      sourceSessionId: 'source',
      summarySource: source,
    });
    const members = result.members;
    for (const member of members) {
      const key = `agent:${member.agentId}:justdo-team:group:${id}`;
      const subscribed = await client.request('sessions.messages.subscribe', {
        key,
        agentId: member.agentId,
      });
      assert.equal(subscribed.subscribed, true);
      assert.equal(subscribed.key, key);
    }
    const roster = members.map(member => ({ ...member, name: member.agentId }));
    if (borrowed) {
      members.push({ ...source, permissionMode: 'full', sessionRoot: workspace });
      roster.push({ ...source, name: 'Main', ownership: 'source' });
    }
    return {
      members,
      room: {
        id,
        title: 'Isolated group fixture',
        cwd: workspace,
        permissionMode: 'ask',
        readOnly: true,
        members: roster,
        revision: 1,
        generation: 0,
        state: 'ready',
        rounds: 2,
        createdAt: 1,
        updatedAt: 1,
        sourceSessionId: 'source',
        summarySource: source,
      },
    };
  }
  async function start(f, id, text, selected = [], rounds = 1) {
    return client.request('teamDiscussion.start', {
      room: f.room,
      members: f.members,
      discussionId: id,
      send: {
        roomId: f.room.id,
        requestId: id,
        expectedRevision: 1,
        message: text,
        selectedAgentIds: selected,
        rounds,
      },
      resources: {
        settingsRevision: 0,
        maxRounds: 4,
        maxTurns: f.members.length * rounds,
        maxConcurrent: 2,
      },
    });
  }
  async function settled(f, id) {
    return until(async () => {
      const status = await client.request('teamDiscussion.status', {
        roomId: f.room.id,
        discussionId: id,
      });
      return ['completed', 'failed', 'cancelled'].includes(status.state) ? status : false;
    }, 'group terminal ' + id);
  }
  async function history(f, id) {
    return client.request('teamDiscussion.history', {
      roomId: f.room.id,
      discussionIds: [id],
      members: f.room.members
        .filter(member => member.ownership !== 'source')
        .map(member => ({
          agentId: member.agentId,
          sessionId: member.sessionId,
          sessionKey: `agent:${member.agentId}:justdo-team:group:${f.room.id}`,
        })),
    });
  }
  async function assertWholeRun(execution) {
    const terminal = await until(
      () => terminals.get(execution.runId),
      'exact whole-run terminal ' + execution.runId,
    );
    assert.equal(terminal.sessionKey, execution.sessionKey);
    assert.equal(terminal.sessionId, execution.sessionId);
    assert.equal(terminal.data.executionSettled, true);
    assert.equal(terminal.data.phase, 'end');
    assert.notEqual(terminal.data.aborted, true);
  }
  async function assertNativeReceipt(f, id, summary = false) {
    const receipt = JSON.parse(
      await readFile(
        path.join(
          base,
          'agent-team',
          summary ? 'summary-receipts' : 'discussion-receipts',
          `${id}.json`,
        ),
        'utf8',
      ),
    );
    assert.equal(receipt.roomId, f.room.id);
    assert.equal(receipt.discussionId, id);
    assert.equal(receipt.state, 'completed');
    assert.equal(receipt.cleanupComplete, true);
    assert.ok(receipt.executions.length > 0);
    for (const execution of receipt.executions) {
      const member = summary
        ? source
        : f.members.find(member => member.agentId === execution.agentId);
      assert.ok(member);
      const borrowed = f.room.members.some(
        candidate => candidate.agentId === execution.agentId && candidate.ownership === 'source',
      );
      assert.equal(
        execution.sessionKey,
        summary || borrowed
          ? sourceKey
          : `agent:${execution.agentId}:justdo-team:group:${f.room.id}`,
      );
      assert.equal(execution.sessionId, member.sessionId);
      assert.equal(execution.lifecycleRevision, member.lifecycleRevision);
      assert.equal(execution.outcome, 'completed');
      assert.ok(receipt.settledRunIds.includes(execution.runId));
      await assertWholeRun(execution);
    }
    if (summary) assert.ok(receipt.outputEntryIds.length > 0);
    return receipt;
  }
  async function verifySummary(f, id) {
    await client.request('teamDiscussion.summary', {
      operation: 'start',
      roomId: f.room.id,
      discussionId: id,
      room: f.room,
    });
    const summary = await until(async () => {
      const state = await client.request('teamDiscussion.summary', {
        operation: 'status',
        roomId: f.room.id,
        discussionId: id,
      });
      return ['delivered', 'failed', 'cancelled'].includes(state.state) ? state : false;
    }, 'source summary');
    assert.equal(summary.state, 'delivered');
    await assertNativeReceipt(f, id, true);
    const sourceHistory = await client.request('chat.history', {
      sessionKey: sourceKey,
      limit: 10,
    });
    assert.equal(sourceHistory.sessionId, source.sessionId);
    assert.ok(JSON.stringify(sourceHistory.messages).includes('FIXTURE_SOURCE_TASK'));
    assert.ok(
      sourceHistory.messages.some(
        message =>
          message.role === 'user' &&
          message.provenance?.kind === 'inter_session' &&
          message.provenance?.sourceChannel === 'justdo-team' &&
          message.provenance?.sourceTool === 'team_discussion',
      ),
      'native history must identify the internal summary trigger for renderer projection',
    );
    assert.ok(sourceHistory.messages.some(message => message.role === 'assistant'));
    assert.equal(
      await readFile(path.join(workspace, 'continuation-finished.txt'), 'utf8'),
      'FIXTURE_CONTINUATION_COMPLETE',
    );
    assert.ok(
      requests.some(request => request.summary && request.toolFinished),
      'automatic source result handoff must continue through a real native tool call',
    );
    console.log(
      'PASS automatic source continuation uses tools and retains original native instance',
    );
  }
  async function verifyOwnedWrite() {
    const working = await prepare('working');
    await start(working, 'working-batch', 'FIXTURE_TOOL_MEMBER', ['alice']);
    assert.equal((await settled(working, 'working-batch')).state, 'completed');
    await assertNativeReceipt(working, 'working-batch');
    assert.equal(
      await readFile(path.join(workspace, 'member-finished.txt'), 'utf8'),
      'FIXTURE_MEMBER_COMPLETE',
    );
    assert.ok(requests.some(request => request.toolStage === 'member' && request.toolFinished));
    console.log(
      'PASS owned group member inherits source execution permission and writes its artifact',
    );
    return working;
  }
  async function verifyBorrowedWrite() {
    const borrowed = await prepare('borrowed', true);
    await start(borrowed, 'borrowed-batch', 'FIXTURE_BORROWED', ['main']);
    const borrowedStatus = await settled(borrowed, 'borrowed-batch');
    assert.equal(borrowedStatus.state, 'completed');
    assert.equal(borrowedStatus.executions[0].sessionId, source.sessionId);
    await assertNativeReceipt(borrowed, 'borrowed-batch');
    assert.equal(
      await readFile(path.join(workspace, 'borrowed-finished.txt'), 'utf8'),
      'FIXTURE_BORROWED_COMPLETE',
    );
    assert.ok(requests.some(request => request.toolStage === 'borrowed' && request.toolFinished));
    const borrowedHistory = await history(borrowed, 'borrowed-batch');
    assert.ok(
      borrowedHistory.messages.some(
        message => message.role === 'user' && message.text.includes('FIXTURE_BORROWED'),
      ),
    );
    assert.ok(
      borrowedHistory.messages.some(
        message => message.agentId === 'main' && message.role === 'assistant',
      ),
    );
    console.log('PASS source-only participation, shared SID, room-owned public question and reply');
  }
  if (toolInheritanceOnly) {
    await assertWholeRun({ ...source, runId: initial.runId });
    const working = await verifyOwnedWrite();
    await verifySummary(working, 'working-batch');
    await verifyBorrowedWrite();
    console.log(
      JSON.stringify({ fixture: base, mode: 'tool-inheritance', modelRequests: requests.length }),
    );
    break nativeProbe;
  }
  const all = await prepare('broadcast');
  const beforeBroadcast = requests.length;
  await start(all, 'broadcast-batch', 'FIXTURE_BROADCAST', [], 2);
  const allStatus = await settled(all, 'broadcast-batch');
  assert.equal(allStatus.state, 'completed');
  assert.equal(allStatus.executions.length, 4);
  const allHistory = await history(all, 'broadcast-batch');
  assert.ok(
    allHistory.messages.some(
      message => message.role === 'user' && message.text.includes('FIXTURE_BROADCAST'),
    ),
  );
  assert.equal(
    requests.length - beforeBroadcast,
    4,
    'intentional silence must not trigger an empty-answer retry',
  );
  assert.equal(allHistory.messages.filter(message => message.role === 'assistant').length, 2);
  for (const member of all.members) {
    const memberHistory = await client.request('chat.history', {
      sessionKey: `agent:${member.agentId}:justdo-team:group:${all.room.id}`,
      limit: 20,
    });
    const inputs = memberHistory.messages.filter(message => message.role === 'user');
    assert.equal(inputs.length, 2, 'both native group rounds must persist their input identity');
    assert.ok(
      inputs.every(message => message.__openclaw?.transport?.channel === 'justdo-team'),
      'native transport attribution must remain available for already stored channel turns',
    );
    assert.ok(
      inputs.every(
        message =>
          message.provenance?.kind === 'inter_session' &&
          message.provenance?.sourceChannel === 'justdo-team' &&
          message.provenance?.sourceTool === 'team_discussion',
      ),
      'owned member dispatch must preserve explicit provenance for every round',
    );
  }
  console.log('PASS broadcast, second-round NO_REPLY, native terminals, public history');
  await verifySummary(all, 'broadcast-batch');
  await verifyOwnedWrite();
  const silent = await prepare('silent');
  const beforeSilent = requests.length;
  await start(silent, 'silent-batch', 'FIXTURE_SILENT', [], 2);
  const silentStatus = await settled(silent, 'silent-batch');
  assert.equal(silentStatus.state, 'completed');
  assert.equal(
    silentStatus.executions.length,
    2,
    'an entirely silent round ends the discussion early',
  );
  assert.equal(requests.length - beforeSilent, 2, 'neither empty-answer retries nor extra rounds');
  assert.equal(
    (await history(silent, 'silent-batch')).messages.filter(message => message.role === 'assistant')
      .length,
    0,
  );
  console.log('PASS silent first round ends early without visible replies or retries');
  const directed = await prepare('directed');
  await start(directed, 'directed-batch', 'FIXTURE_DIRECTED', ['bob']);
  const directedStatus = await settled(directed, 'directed-batch');
  assert.equal(directedStatus.state, 'completed');
  assert.deepEqual(
    directedStatus.executions.map(execution => execution.agentId),
    ['bob'],
  );
  console.log('PASS exact @ recipient without first-round broadcast');
  await verifyBorrowedWrite();
  const stopped = await prepare('stopped');
  await start(stopped, 'stopped-batch', 'FIXTURE_SLOW', ['alice']);
  await until(() => requests.some(request => request.slow), 'slow model started');
  await client.request('teamDiscussion.stop', {
    roomId: stopped.room.id,
    discussionId: 'stopped-batch',
  });
  assert.equal((await settled(stopped, 'stopped-batch')).state, 'cancelled');
  console.log('PASS whole-group Stop waits for native cancellation');
  const failed = await prepare('failed');
  await start(failed, 'failed-batch', 'FIXTURE_FAIL', ['alice']);
  assert.equal((await settled(failed, 'failed-batch')).state, 'failed');
  console.log('PASS provider failure stays failed');
  console.log(JSON.stringify({ fixture: base, modelRequests: requests.length }));
} finally {
  await writeFile(
    path.join(base, 'model-requests.json'),
    JSON.stringify(
      { mode: toolInheritanceOnly ? 'tool-inheritance' : 'general', requests },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(base, 'gateway-console.log'),
    output.replaceAll(token, '[fixture-token]'),
  );
  client?.stop();
  if (child?.exitCode === null) {
    try {
      child.send('stop');
    } catch {
      child.kill();
    }
    await until(() => child.exitCode !== null, 'fixture shutdown', 10000, {
      checkModel: false,
    }).catch(() => child.kill());
  }
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
}
