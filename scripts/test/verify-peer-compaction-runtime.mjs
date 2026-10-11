import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real native peer execution against a loopback model and disposable state.
// No user configuration, transcript, credentials or live runtime is modified.
// Usage: node scripts/test/verify-peer-compaction-runtime.mjs [runtime-directory]
// Optional: --expect-writer-error (old runtime), --provider-overflow,
// --abort-during-compaction, --provider-failure. Artifacts stay in ignored .tmp/.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = path.resolve(process.argv[2] ?? path.join(root, 'vendor/openclaw-runtime/current'));
const flags = new Set(process.argv.slice(3));
for (const flag of flags)
  assert.ok(
    [
      '--expect-writer-error',
      '--provider-overflow',
      '--abort-during-compaction',
      '--provider-failure',
    ].includes(flag),
    'Unknown fixture option',
  );
const base = path.join(root, '.tmp', 'peer-compaction-' + randomUUID());
const workspace = path.join(base, 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(
  path.join(workspace, 'fixture.txt'),
  ('隔离测试工具输出用于压缩恢复验证。'.repeat(40) + '\n').repeat(400),
);
const token = randomBytes(24).toString('hex');
const configPath = path.join(base, 'config.json');
const key = 'agent:researcher:fixture:worker';
const sourceKey = 'agent:main:fixture:organizer';
const fixturePlugin = path.join(base, 'fixture-plugin');
await mkdir(fixturePlugin);
await writeFile(
  path.join(fixturePlugin, 'package.json'),
  JSON.stringify({
    name: 'fixture-access',
    version: '1.0.0',
    type: 'module',
    openclaw: { extensions: ['./index.mjs'] },
  }),
);
await writeFile(
  path.join(fixturePlugin, 'openclaw.plugin.json'),
  JSON.stringify({
    id: 'fixture-access',
    activation: { onStartup: true },
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
  }),
);
await writeFile(
  path.join(fixturePlugin, 'index.mjs'),
  `
import { createSessionVisibilityChecker } from ${JSON.stringify(pathToFileURL(path.join(runtime, 'dist/plugin-sdk/session-visibility.js')).href)};
import fs from 'node:fs';
export default {id: 'fixture-access', register(api) { let removeAccess; api.registerService({ id: 'fixture-access', start() { removeAccess = createSessionVisibilityChecker.registerScopedAccessProvider(request => {
if (request.action !== 'send' || ![${JSON.stringify(key)}, ${JSON.stringify(sourceKey)}].includes(request.requesterSessionKey) || ![${JSON.stringify(key)}, ${JSON.stringify(sourceKey)}].includes(request.targetSessionKey)) return;
const bindings = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(base, 'bindings.json'))}, 'utf8'));
return bindings[request.targetSessionKey] ? {expectedSessionId:bindings[request.targetSessionKey]} : undefined;
}); }, stop() { removeAccess?.(); } }); } };
`,
);
const events = [],
  requests = [];
let ordinary = 0,
  sourceStarted = false,
  acknowledged = false,
  providerOverflowResponses = 0,
  providerFailureResponses = 0;
const model = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const userText = JSON.stringify(
    body.messages?.findLast(
      message =>
        message.role === 'user' &&
        !JSON.stringify(message.content).includes('BEGIN_OPENCLAW_INTERNAL_CONTEXT'),
    )?.content,
  );
  const compact = body.metadata?.request_purpose === 'context_compaction' || !body.tools?.length;
  if (!compact && (userText.includes('ORGANIZER_ONLY') || userText.includes('WORKER_ACK'))) {
    if (userText.includes('WORKER_ACK')) acknowledged = true;
    const start = userText.includes('ORGANIZER_ONLY') && !sourceStarted;
    if (start) sourceStarted = true;
    const delta = start
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'launch-worker',
              type: 'function',
              function: {
                name: 'tool_call',
                arguments: JSON.stringify({
                  id: 'sessions_send',
                  args: {
                    sessionKey: key,
                    message: 'WORKER_READ',
                    mode: 'followup',
                    timeoutSeconds: 0,
                  },
                }),
              },
            },
          ],
        }
      : { role: 'assistant', content: 'ORGANIZER_COMPLETE' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: start ? 'tool_calls' : 'stop' }],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
    return;
  }
  if (!compact && userText.includes('WARMUP_ONLY')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'WARMUP_COMPLETE' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
    return;
  }
  requests.push({
    compact,
    purpose: body.metadata?.request_purpose,
    toolCount: body.tools?.length,
    promptChars: JSON.stringify(body.messages).length,
  });
  console.log('MODEL', requests.at(-1));
  if (!compact) ++ordinary;
  if (flags.has('--provider-overflow') && !compact && ordinary === 2) {
    ++providerOverflowResponses;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
          message: 'maximum context length is 200000 tokens; context length exceeded',
        },
      }),
    );
    return;
  }
  if (flags.has('--provider-failure') && !compact && requests.some(request => request.compact)) {
    ++providerFailureResponses;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: 'Fixture post-compaction provider failure.',
        },
      }),
    );
    return;
  }
  const tool = !compact && ordinary <= 5 && !requests.some(request => request.compact);
  if (compact) await new Promise(resolve => setTimeout(resolve, 2500));
  const summary = [
    '## Decisions',
    'The worker has read the isolated fixture file. Preserve completed work and continue the current task.',
    '## Open TODOs',
    'Finish the worker request and report completion.',
    '## Constraints/Rules',
    'Use only the isolated fixture workspace.',
    '## Pending user asks',
    'None.',
    '## Exact identifiers',
    path.join(workspace, 'fixture.txt'),
  ].join('\n');
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: Array.from({ length: 3 }, (_, index) => ({
          index,
          id: `call-read-fixture-${ordinary}-${index}`,
          type: 'function',
          function: {
            name: 'tool_call',
            arguments: JSON.stringify({
              id: 'read',
              args: {
                path: path.join(workspace, 'fixture.txt'),
                offset: index * 100 + 1,
                limit: 100,
              },
            }),
          },
        })),
      }
    : { role: 'assistant', content: compact ? summary : 'RECOVERY_COMPLETE' };
  if (tool && ordinary === 1)
    delta.tool_calls.push({
      index: 3,
      id: 'ack-organizer',
      type: 'function',
      function: {
        name: 'tool_call',
        arguments: JSON.stringify({
          id: 'sessions_send',
          args: {
            sessionKey: sourceKey,
            message: 'WORKER_ACK',
            mode: 'followup',
            timeoutSeconds: 0,
          },
        }),
      },
    });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion.chunk',
        model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 },
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const ports = net.createServer();
await new Promise(resolve => ports.listen(0, '127.0.0.1', resolve));
const port = ports.address().port;
await new Promise(resolve => ports.close(resolve));
const config = {
  logging: { file: path.join(base, 'native.log'), level: 'debug', consoleLevel: 'debug' },
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: {
    ownership: 'explicit',
    entries: { main: {}, researcher: {} },
    defaults: {
      workspace,
      skipBootstrap: true,
      heartbeat: { every: '0m' },
      model: { primary: 'fixture/fixture' },
      systemAgent: { agentId: 'main' },
      compaction: {
        mode: 'safeguard',
        memoryFlush: { enabled: false },
        midTurnPrecheck: { enabled: true },
      },
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
    sessions: { visibility: 'tree' },
    toolSearch: { enabled: true, mode: 'directory' },
    codeMode: { enabled: false },
  },
  session: { maintenance: { mode: 'warn', coldStorage: { enabled: false, afterDays: 30 } } },
  plugins: {
    load: { paths: [fixturePlugin] },
    slots: { memory: 'none' },
    allow: [
      'openai',
      'fixture-access',
      ...(flags.has('--provider-failure') ? ['runtime-services'] : []),
    ],
    entries: {
      openai: { enabled: true },
      ...(flags.has('--provider-failure') ? { 'runtime-services': { enabled: true } } : {}),
      'fixture-access': { enabled: true },
    },
  },
};
await writeFile(configPath, JSON.stringify(config));
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
let child,
  client,
  poll,
  output = '';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(300);
  }
  throw new Error('Timeout: ' + label);
}
try {
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
      return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) }))
        .ok;
    } catch {
      return false;
    }
  }, 'listening');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Handshake timeout')), 20000);
    client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientName: 'gateway-client',
      mode: 'backend',
      scopes: ['operator.admin'],
      onHelloOk: () => {
        clearTimeout(timer);
        resolve();
      },
      onConnectError: error => {
        clearTimeout(timer);
        reject(error);
      },
      onEvent: event => {
        events.push(event);
        if (event.event === 'agent' && event.payload?.stream === 'lifecycle')
          console.log('LIFECYCLE', event.payload.data);
      },
    });
    client.start();
  });
  await client.request('sessions.create', { key, cwd: workspace, permissionMode: 'full' });
  await client.request('sessions.create', {
    key: sourceKey,
    cwd: workspace,
    permissionMode: 'full',
  });
  const warmup = await client.request('agent', {
    agentId: 'researcher',
    sessionKey: key,
    message: 'WARMUP_ONLY',
    idempotencyKey: 'fixture-warmup',
    channel: 'webchat',
    deliver: false,
    lane: 'nested:' + key,
  });
  await until(
    () =>
      events.some(
        event =>
          event.event === 'agent' &&
          event.payload?.runId === warmup.runId &&
          event.payload?.data?.executionSettled === true,
      ),
    'warmup terminal',
  );
  const store = await import(
    pathToFileURL(path.join(runtime, 'dist/plugin-sdk/session-store-runtime.js'))
  );
  const transcript = await import(
    pathToFileURL(path.join(runtime, 'dist/plugin-sdk/session-transcript-runtime.js'))
  );
  const entry = store.getSessionEntry({
    agentId: 'researcher',
    sessionKey: key,
    readConsistency: 'latest',
  });
  assert.ok(entry?.sessionId, 'fixture native session exists');
  await writeFile(
    path.join(base, 'bindings.json'),
    JSON.stringify({
      [key]: entry.sessionId,
      [sourceKey]: store.getSessionEntry({ agentId: 'main', sessionKey: sourceKey }).sessionId,
    }),
  );
  for (let index = 0; index < 6; index++) {
    await transcript.appendSessionTranscriptMessageByIdentity({
      agentId: 'researcher',
      sessionKey: key,
      sessionId: entry.sessionId,
      config,
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [
          {
            type: 'text',
            text:
              index % 2 === 0
                ? 'Earlier fixture request ' + index
                : 'Earlier fixture answer ' + ('Historical content ' + index + '. ').repeat(3600),
          },
        ],
        timestamp: Date.now() - 10000 + index,
      },
      idempotencyKey: 'fixture-history-' + index,
    });
  }
  const sourceRun = await client.request('chat.send', {
    sessionKey: sourceKey,
    message: 'ORGANIZER_ONLY',
    idempotencyKey: 'fixture-organizer-run',
  });
  await until(
    () =>
      events.find(
        event =>
          event.event === 'agent' &&
          event.payload?.sessionKey === key &&
          event.payload?.stream === 'lifecycle' &&
          event.payload?.data?.phase === 'start' &&
          event.payload?.runId !== warmup.runId,
      ),
    'peer start',
  );
  const accepted = {
    runId: events.find(
      event =>
        event.event === 'agent' &&
        event.payload?.sessionKey === key &&
        event.payload?.stream === 'lifecycle' &&
        event.payload?.data?.phase === 'start' &&
        event.payload?.runId !== warmup.runId,
    ).payload.runId,
  };
  console.log('ACCEPTED', accepted);
  poll = setInterval(() => {
    void client.request('sessions.list', {}).catch(() => {});
    void client.request('chat.history', { sessionKey: key, limit: 100 }).catch(() => {});
  }, 300);
  if (flags.has('--abort-during-compaction')) {
    await until(() => requests.some(request => request.compact), 'compaction model request');
    const aborted = await client.request('chat.abort', { sessionKey: key, runId: accepted.runId });
    assert.equal(aborted.aborted, true, 'native peer cancellation admitted');
  }
  await until(
    () =>
      events.some(
        event =>
          event.event === 'agent' &&
          event.payload?.runId === accepted.runId &&
          event.payload?.stream === 'lifecycle' &&
          event.payload?.data?.executionSettled === true,
      ),
    'whole-run terminal',
    240000,
  );
  const terminals = events
    .filter(
      event =>
        event.event === 'agent' &&
        event.payload?.runId === accepted.runId &&
        event.payload?.stream === 'lifecycle' &&
        event.payload?.data?.executionSettled === true,
    )
    .map(event => event.payload.data);
  const history = await client.request('chat.history', { sessionKey: key, limit: 100 });
  const compactions = events
    .filter(event => event.event === 'agent' && event.payload?.stream === 'compaction')
    .map(event => event.payload.data);
  // Native display history omits provider error fields. Use the same bounded
  // detail RPC as the product, rather than reading the transcript database.
  const failureDetails = flags.has('--provider-failure')
    ? await client.request('runtimeServices.historyDetails', {
        sessionKey: key,
        failureMessageIds: history.messages
          .filter(message => message.role === 'assistant')
          .map(message => message.__openclaw?.id)
          .filter(id => typeof id === 'string'),
      })
    : undefined;
  const result = {
    base,
    requests,
    terminals,
    compactions,
    acknowledged,
    providerOverflowResponses,
    providerFailureResponses,
    historyHasCompletion: JSON.stringify(history.messages).includes('RECOVERY_COMPLETE'),
    historyHasFailure: Boolean(
      (terminals[0]?.error && JSON.stringify(history.messages).includes(terminals[0].error)) ||
      JSON.stringify(failureDetails?.failureDetails ?? {}).includes(
        'Fixture post-compaction provider failure.',
      ),
    ),
  };
  console.log('RESULT', JSON.stringify(result, null, 2));
  await writeFile(path.join(base, 'result.json'), JSON.stringify(result, null, 2));
  assert.equal(history.sessionId, entry.sessionId, 'native session identity unchanged');
  assert.equal(terminals.length, 1, 'exactly one whole-run terminal');
  if (flags.has('--provider-overflow'))
    assert.equal(providerOverflowResponses, 1, 'provider-side overflow response actually injected');
  if (flags.has('--expect-writer-error')) {
    assert.match(
      terminals[0].error ?? '',
      /session writer claim changed before transcript persistence/,
      'old runtime reproduces the writer failure',
    );
  } else if (flags.has('--abort-during-compaction')) {
    assert.equal(terminals[0].aborted, true, 'whole-run cancellation settles');
    assert.equal(result.historyHasCompletion, false, 'cancelled work did not publish completion');
  } else if (flags.has('--provider-failure')) {
    assert.equal(providerFailureResponses, 1, 'post-compaction provider failure actually injected');
    assert.ok(
      requests.some(request => request.compact),
      'automatic compaction used',
    );
    assert.equal(terminals[0].phase, 'error', 'whole-run provider error settles');
    assert.match(terminals[0].error ?? '', /provider rejected the request schema or tool payload/);
    assert.ok(result.historyHasFailure, 'native failure reason persisted in history');
    assert.equal(result.historyHasCompletion, false, 'failed work did not publish completion');
    assert.ok(output.includes('outcome=compacted'), 'native compaction actually succeeded');
  } else {
    assert.ok(
      requests.some(request => request.compact),
      'automatic compaction used',
    );
    assert.ok(result.historyHasCompletion, 'compaction recovered and persisted the final reply');
    assert.equal(terminals[0].phase, 'end', 'whole run succeeded');
    assert.equal(acknowledged, true, 'peer acknowledgment reached the organizer');
    const sourceTerminal = events.find(
      event =>
        event.event === 'agent' &&
        event.payload?.runId === sourceRun.runId &&
        event.payload?.data?.executionSettled === true,
    )?.payload.data;
    assert.equal(sourceTerminal?.phase, 'end', 'organizer completed after launching the peer');
    assert.ok(
      sourceTerminal.endedAt <= terminals[0].endedAt,
      'peer continued after its source turn settled',
    );
    assert.ok(output.includes('outcome=compacted'), 'native compaction actually succeeded');
  }
  if (!flags.has('--expect-writer-error'))
    assert.ok(
      !output.includes('SessionTranscriptWriterClaimReboundError'),
      'no writer scope failure',
    );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearInterval(poll);
  if (client) client.stop();
  if (child && child.exitCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve));
    child.send('stop');
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    await ended;
    clearTimeout(timer);
  }
  await writeFile(path.join(base, 'gateway.log'), output.replaceAll(token, '<fixture-token>'));
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  console.log('ARTIFACTS', base);
}
