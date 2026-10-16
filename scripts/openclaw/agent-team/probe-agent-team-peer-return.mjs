import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import {
  cpSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// Native peer -> organizer execution with synthetic content and a loopback model.
// Never opens the user's state, calls a paid provider, or replays a real request.
const runtimeSource = path.resolve(process.argv[2] ?? 'vendor/openclaw-runtime/current');
const state = mkdtempSync(path.join(os.tmpdir(), 'peer-return-probe-'));
const runtime = path.join(state, 'runtime');
mkdirSync(runtime);
const previousNoAsar = process.noAsar;
process.noAsar = true;
for (const entry of readdirSync(runtimeSource, { withFileTypes: true })) {
  if (entry.name === 'dist' || entry.name === 'node_modules') continue;
  const source = path.join(runtimeSource, entry.name),
    target = path.join(runtime, entry.name);
  if (entry.isDirectory()) symlinkSync(source, target, 'junction');
  else copyFileSync(source, target);
}
process.noAsar = previousNoAsar;
// Dynamic SDKs must resolve the same native state owners as this copied bundle.
// Linking the entire source node_modules would point openclaw at another runtime.
const modules = path.join(runtime, 'node_modules');
mkdirSync(modules);
for (const entry of readdirSync(path.join(runtimeSource, 'node_modules'), {
  withFileTypes: true,
})) {
  if (entry.name === 'openclaw') continue;
  const source = path.join(runtimeSource, 'node_modules', entry.name);
  const target = path.join(modules, entry.name);
  if (entry.isDirectory() || entry.isSymbolicLink()) symlinkSync(source, target, 'junction');
  else copyFileSync(source, target);
}
symlinkSync(runtime, path.join(modules, 'openclaw'), 'junction');
mkdirSync(path.join(runtime, 'dist'));
for (const entry of readdirSync(path.join(runtimeSource, 'dist'), { withFileTypes: true })) {
  if (entry.name === 'extensions') continue;
  const source = path.join(runtimeSource, 'dist', entry.name),
    target = path.join(runtime, 'dist', entry.name);
  if (entry.name === 'plugin-sdk') cpSync(source, target, { recursive: true });
  else if (entry.isDirectory()) symlinkSync(source, target, 'junction');
  else copyFileSync(source, target);
}
require('../../../src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs').ensureOpenClawGatewayBundleLauncher(
  runtime,
);
const bundled = path.join(runtime, 'dist', 'extensions');
const plugin = path.join(bundled, 'peer-return-probe');
mkdirSync(plugin, { recursive: true });
writeFileSync(
  path.join(plugin, 'package.json'),
  JSON.stringify({
    name: 'peer-return-probe',
    type: 'module',
    openclaw: { extensions: ['./index.mjs'] },
  }),
);
writeFileSync(
  path.join(plugin, 'openclaw.plugin.json'),
  JSON.stringify({
    id: 'peer-return-probe',
    name: 'Peer return fixture',
    activation: { onStartup: true },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }),
);
writeFileSync(
  path.join(plugin, 'index.mjs'),
  `
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { createSessionVisibilityChecker } from 'openclaw/plugin-sdk/session-visibility';
export default { id: 'peer-return-probe', name: 'Peer return fixture', register(api) {
  let remove;
  const stats = globalThis[Symbol.for('peer-return-probe.metrics')] ??= { grants: 0, receipts: [] };
  api.registerService({ id: 'peer-return-probe', start() {
    remove = createSessionVisibilityChecker.registerScopedAccessProvider(request => {
      if (request.action !== 'send' || request.requesterSessionKey !== 'agent:writer:peer-return-probe' || request.targetSessionKey !== 'agent:main:peer-return-probe') return;
      const entry = getSessionEntry({ agentId: 'main', sessionKey: request.targetSessionKey, readConsistency: 'latest' });
      if (entry?.sessionId) stats.grants++;
      return entry?.sessionId ? { expectedSessionId: entry.sessionId } : undefined;
    });
  }, stop() { remove?.(); } });
  api.on('after_tool_call', (event, context) => {
    if (event.toolName !== 'sessions_send' || context.sessionKey !== 'agent:writer:peer-return-probe') return;
    const result = event.result?.details;
    stats.receipts.push({ sourceRunId: context.runId, status: result?.status, runId: result?.runId });
  });
  api.registerGatewayMethod('peerProbe.receipts', ({ respond }) => respond(true, stats), { scope: 'operator.admin' });
} };
`,
);
const workspace = path.join(state, 'workspace');
mkdirSync(workspace);
const key = agent => `agent:${agent}:peer-return-probe`;
const events = [];
const outcomes = [];
let modelRequests = 0;
const model = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  modelRequests++;
  const messages = body.messages;
  const lastUser = messages.findLastIndex(
    item =>
      item.role === 'user' &&
      !JSON.stringify(item.content).includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>'),
  );
  const turn = messages.slice(lastUser);
  const text = JSON.stringify(turn[0]?.content);
  const taskRound = text.match(/WORKER_TASK (\d+)/)?.[1];
  const returnedRound = text.match(/PEER_RESULT (\d+)/)?.[1];
  const tools = turn.filter(item => item.role === 'tool');
  const tool = taskRound !== undefined && !tools.length;
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'peer-return',
            type: 'function',
            function: {
              name: 'tool_call',
              arguments: JSON.stringify({
                id: 'sessions_send',
                args: {
                  sessionKey: key('main'),
                  message: `PEER_RESULT ${taskRound}: completed synthetic draft`,
                  mode: 'followup',
                  timeoutSeconds: 0,
                },
              }),
            },
          },
        ],
      }
    : {
        role: 'assistant',
        content: returnedRound !== undefined
          ? `ORGANIZER_RECEIVED ${returnedRound}`
          : taskRound !== undefined
            ? 'WORKER_FINISHED'
            : 'REPLY_SKIP',
      };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const token = randomBytes(24).toString('hex');
const cfg = {
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: {
    ownership: 'explicit',
    entries: { main: {}, writer: {} },
    defaults: {
      workspace,
      skipBootstrap: true,
      heartbeat: { every: '0m' },
      systemAgent: { agentId: 'main' },
      model: { primary: 'fixture/answer' },
      models: { 'fixture/answer': { agentRuntime: { id: 'openclaw' } } },
      blockStreamingDefault: 'off',
    },
  },
  models: {
    mode: 'replace',
    catalogRefresh: { enabled: false },
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        apiKey: 'synthetic-probe-key',
        api: 'openai-completions',
        request: { allowPrivateNetwork: true },
        models: [
          {
            id: 'answer',
            name: 'Fixture',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 1024,
          },
        ],
      },
    },
  },
  tools: {
    profile: 'coding',
    agentToAgent: { enabled: false },
    sessions: { visibility: 'all' },
  },
  session: { maintenance: { mode: 'warn', coldStorage: { enabled: false, afterDays: 30 } } },
  plugins: {
    slots: { memory: 'none' },
    allow: ['peer-return-probe'],
    load: { paths: [plugin] },
    entries: { 'peer-return-probe': { enabled: true } },
  },
};
const configPath = path.join(state, 'openclaw.json');
writeFileSync(configPath, JSON.stringify(cfg));
const env = {
  ...process.env,
  OPENCLAW_HOME: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_RESPAWN: '1',
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: '0',
  OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
};
const child = spawn(
  process.execPath,
  [
    path.join(runtime, 'gateway-launcher.cjs'),
    'gateway',
    'run',
    '--allow-unconfigured',
    '--port',
    String(port),
  ],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
);
let output = '',
  client,
  poll;
child.stdout.on('data', chunk => (output += chunk));
child.stderr.on('data', chunk => (output += chunk));
const watchdog = setTimeout(() => child.kill(), 180000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(run, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Gateway exited: ${child.exitCode}`);
    const result = await run();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  await until(
    async () => {
      try {
        return (
          await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })
        ).ok;
      } catch {
        return false;
      }
    },
    'health',
    60000,
  );
  const clientFile = readdirSync(path.join(runtime, 'dist')).find(
    file =>
      /^client-.*\.mjs$/.test(file) &&
      readFileSync(path.join(runtime, 'dist', file), 'utf8').includes('GatewayClient as t'),
  );
  const { t: GatewayClient } = await import(pathToFileURL(path.join(runtime, 'dist', clientFile)));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Handshake timed out')), 15000);
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
        if (event.event === 'agent') events.push(event.payload);
      },
    });
    client.start();
  });
  for (const agent of ['main', 'writer'])
    await client.request('sessions.create', {
      key: key(agent),
      cwd: workspace,
      permissionMode: 'full',
    });
  let polling = false;
  poll = setInterval(() => {
    if (polling) return;
    polling = true;
    Promise.all([
      client.request('sessions.list', { limit: 100 }),
      client.request('chat.history', { sessionKey: key('main'), limit: 1 }),
    ])
      .catch(() => {})
      .finally(() => (polling = false));
  }, 100);
  for (let round = 0; round < 5; round++) {
    const startIndex = events.length;
    const sent = await client.request('chat.send', {
      sessionKey: key('writer'),
      message: `WORKER_TASK ${round}`,
      idempotencyKey: `peer-probe-${round}`,
    });
    await until(
      () =>
        events
          .slice(startIndex)
          .find(
            event =>
              event.runId === sent.runId &&
              event.stream === 'lifecycle' &&
              event.data.executionSettled === true,
          ),
      'worker terminal',
      45000,
    );
    const observed = await client.request('peerProbe.receipts', {});
    assert.ok(observed.grants > round, 'the native send must use the exact-session grant');
    const receipt = observed.receipts.find(item => item.sourceRunId === sent.runId);
    assert.equal(receipt?.status, 'accepted');
    assert.ok(receipt?.runId, 'native acceptance must identify this return execution');
    await until(
      () =>
        events
          .slice(startIndex)
          .find(
            event =>
              event.sessionKey === key('main') &&
              event.runId === receipt.runId &&
              event.stream === 'lifecycle' &&
              event.data.executionSettled === true,
          ),
      'organizer terminal',
      45000,
    );
    const terminal = events
      .slice(startIndex)
      .filter(event => event.stream === 'lifecycle' && event.data.executionSettled === true);
    assert.equal(terminal.length, 2, 'both exact native executions must settle once');
    assert.ok(terminal.every(event => event.data.phase === 'end' && !event.data.aborted));
    const history = await client.request('chat.history', { sessionKey: key('main'), limit: 10 });
    assert.ok(JSON.stringify(history).includes(`ORGANIZER_RECEIVED ${round}`));
    outcomes.push({
      round,
      terminals: terminal.map(event => ({
        key: event.sessionKey,
        runId: event.runId,
        phase: event.data.phase,
      })),
    });
    console.log(JSON.stringify({ check: 'peer-return', round, settled: terminal.length }));
  }
  assert.ok(!output.includes('database is locked'), 'native writes must not fail');
  console.log(JSON.stringify({ state, modelRequests, outcomes }));
} catch (error) {
  console.error(error.stack ?? error.message);
  console.error(
    JSON.stringify({
      state,
      modelRequests,
      terminals: events
        .filter(
          event => event.stream === 'lifecycle' && ['end', 'error'].includes(event.data.phase),
        )
        .map(event => ({
          runId: event.runId,
          key: event.sessionKey,
          phase: event.data.phase,
          aborted: event.data.aborted,
          error: event.data.error,
          executionSettled: event.data.executionSettled,
        })),
    }),
  );
  console.error(output.slice(-8000));
  process.exitCode = 1;
} finally {
  clearInterval(poll);
  clearTimeout(watchdog);
  client?.stop();
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
}
