import probePaths from '../probe-paths.cjs';
const { hostRoot, pluginRoot, hostRequire } = probePaths;
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { buildSync } = hostRequire("esbuild");


const repoRoot = hostRoot;

// Real isolated Gateway and public plugin SDK; local deterministic model only.
// Records a failed gate instead of changing native source-session state to hide it.
assert.ok(process.argv[2], 'Prepared runtime directory required');
const runtimeSource = path.resolve(process.argv[2]);
const state = mkdtempSync(path.join(os.tmpdir(), 'justdo-source-gateway-'));
const workspace = path.join(state, 'workspace'),
  project = path.join(state, 'project'),
  runtime = path.join(state, 'runtime');
mkdirSync(runtime);
for (const entry of readdirSync(runtimeSource, { withFileTypes: true })) {
  if (entry.name === 'dist') continue;
  const source = path.join(runtimeSource, entry.name),
    target = path.join(runtime, entry.name);
  if (entry.isDirectory()) symlinkSync(source, target, 'junction');
  else copyFileSync(source, target);
}
mkdirSync(path.join(runtime, 'dist'));
for (const entry of readdirSync(path.join(runtimeSource, 'dist'), { withFileTypes: true })) {
  if (entry.name === 'extensions') continue;
  const source = path.join(runtimeSource, 'dist', entry.name),
    target = path.join(runtime, 'dist', entry.name);
  if (entry.isDirectory()) symlinkSync(source, target, 'junction');
  else copyFileSync(source, target);
}
const bundled = path.join(runtime, 'dist', 'extensions'),
  pluginPath = path.join(bundled, 'agent-team');
for (const dir of [workspace, project, bundled, pluginPath]) mkdirSync(dir);
writeFileSync(path.join(project, 'marker.txt'), 'SOURCE_PROJECT_MARKER');
const token = randomBytes(24).toString('hex');
const portServer = net.createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
let modelRequests = 0;
const observations = [];
let heldResponse;
function finish(response, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
  );
}
function call(response, name, args, id) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
  );
}
const model = createServer(async (request, response) => {
  let raw = '';
  for await (const part of request) raw += part;
  const body = JSON.parse(raw);
  modelRequests++;
  const lastUser = body.messages.findLastIndex(
    message =>
      message.role === 'user' &&
      /SOURCE_NORMAL|SOURCE_GROUP_READ|SOURCE_SUMMARY_READ|NORMAL_WRITE|HOLD_SOURCE/.test(
        JSON.stringify(message.content),
      ),
  );
  const turn = body.messages.slice(lastUser),
    text = JSON.stringify(turn[0]?.content),
    tools = turn.filter(message => message.role === 'tool');
  observations.push({
    text,
    offered: (body.tools ?? []).map(tool => tool.function?.name),
    results: tools.map(tool => tool.content),
  });
  if (text.includes('HOLD_SOURCE')) {
    heldResponse = response;
    return;
  }
  if (text.includes('SOURCE_GROUP_READ') || text.includes('SOURCE_SUMMARY_READ')) {
    if (tools.length === 0)
      return call(
        response,
        'write',
        { path: 'forbidden.txt', content: 'must not write' },
        'denied-write',
      );
    if (tools.length === 1) return call(response, 'read', { path: 'marker.txt' }, 'allowed-read');
    return finish(
      response,
      text.includes('SOURCE_SUMMARY_READ') ? 'SOURCE_SUMMARY_FINAL' : 'SOURCE_GROUP_FINAL',
    );
  }
  if (text.includes('NORMAL_WRITE')) {
    if (tools.length === 0)
      return call(
        response,
        'write',
        { path: 'normal.txt', content: 'ordinary permissions retained' },
        'normal-write',
      );
    return finish(response, 'NORMAL_WRITE_FINAL');
  }
  return finish(
    response,
    text.includes('SOURCE_NORMAL_OTHER_AFTER') ? 'OTHER_SOURCE_FINAL' : 'SOURCE_NORMAL_FINAL',
  );
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
buildSync({
  absWorkingDir: repoRoot,
  alias: { '@app-plugin/sdk/native': path.join(hostRoot, 'plugins/sdk/app-plugin-sdk/native.ts') },
  entryPoints: [path.join(pluginRoot, 'tests/fixtures/agent-team-source-probe.ts')],
  outfile: path.join(pluginPath, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['openclaw/plugin-sdk/*'],
});
writeFileSync(
  path.join(pluginPath, 'package.json'),
  JSON.stringify({ name: 'agent-team', type: 'module', openclaw: { extensions: ['./index.mjs'] } }),
);
writeFileSync(
  path.join(pluginPath, 'openclaw.plugin.json'),
  JSON.stringify({
    id: 'agent-team',
    name: 'Source participation fixture',
    channels: ['agent-team'],
    activation: { onStartup: true },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }),
);
const cfg = {
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: {
    ownership: 'explicit',
    entries: { alice: {}, bob: {} },
    defaults: {
      workspace,
      skipBootstrap: true,
      heartbeat: { every: '0m' },
      systemAgent: { agentId: 'alice' },
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
  tools: { profile: 'coding' },
  session: { maintenance: { mode: 'warn', coldStorage: { enabled: false, afterDays: 30 } } },
  plugins: {
    slots: { memory: 'none' },
    allow: ['agent-team'],
    load: { paths: [pluginPath] },
    entries: { 'agent-team': { enabled: true } },
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
Object.assign(process.env, env);
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
const gatewayEvents = [];
let output = '',
  client;
child.stdout.on('data', chunk => (output += chunk));
child.stderr.on('data', chunk => (output += chunk));
const watchdog = setTimeout(() => child.kill(), 120000),
  sourceKey = 'agent:alice:justdo:source-probe';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error(`Gateway exited ${child.exitCode}`);
      try {
        return (
          await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })
        ).ok;
      } catch {
        return false;
      }
    },
    'Gateway health',
    45000,
  );
  const clientFile = readdirSync(path.join(runtime, 'dist')).find(
    file =>
      /^client-.*\.mjs$/.test(file) &&
      readFileSync(path.join(runtime, 'dist', file), 'utf8').includes('GatewayClient as t'),
  );
  const { t: GatewayClient } = await import(pathToFileURL(path.join(runtime, 'dist', clientFile)));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handshake timeout')), 15000);
    client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientName: 'gateway-client',
      mode: 'backend',
      scopes: ['operator.admin'],
      onEvent: event => {
        if (/^(chat|agent|sessions\.)/.test(event.event)) gatewayEvents.push(event);
      },
      onHelloOk: () => {
        clearTimeout(timer);
        resolve();
      },
      onConnectError: error => {
        clearTimeout(timer);
        reject(error);
      },
    });
    client.start();
  });
  await client.request('sessions.create', { key: sourceKey, cwd: project, permissionMode: 'full' });
  await client.request('sessions.create', {
    key: 'agent:bob:agent-team:group:source-probe',
    cwd: project,
    permissionMode: 'read-only',
  });
  async function normal(message, id, key = sourceKey) {
    const sent = await client.request('chat.send', {
      sessionKey: key,
      message,
      idempotencyKey: id,
    });
    return sent;
  }
  async function waitFinal(marker, key = sourceKey) {
    return until(async () => {
      const history = await client.request('chat.history', { sessionKey: key });
      return JSON.stringify(history).includes(marker);
    }, marker);
  }
  await normal('SOURCE_NORMAL', 'normal-before');
  await waitFinal('SOURCE_NORMAL_FINAL');
  const before = (await client.request('sourceProbe.status', {})).source;
  await client.request('sourceProbe.start', { id: 'group-first' });
  const first = await until(async () => {
    const status = await client.request('sourceProbe.status', {});
    return status.state !== 'running' && status;
  }, 'first group');
  assert.equal(first.state, 'completed', JSON.stringify(first));
  assert.equal(first.runs.length, 2);
  assert.ok(first.runs.some(run => run.identity.sessionKey === sourceKey));
  assert.ok(
    first.deliveries.some(
      item => item.identity.sessionKey === sourceKey && item.text.includes('SOURCE_GROUP_FINAL'),
    ),
  );
  assert.equal(
    existsSync(path.join(project, 'forbidden.txt')),
    false,
    'per-run write must be rejected',
  );
  assert.ok(
    observations.some(item => JSON.stringify(item.results).includes('SOURCE_PROJECT_MARKER')),
    'allowed read must execute in project',
  );
  const after = first.source;
  const routeFields = entry => ({ delivery: entry.delivery });
  const routePreserved = JSON.stringify(routeFields(before)) === JSON.stringify(routeFields(after));
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.permissionMode, 'full');
  await normal('NORMAL_WRITE', 'normal-after');
  await waitFinal('NORMAL_WRITE_FINAL');
  assert.equal(
    readFileSync(path.join(project, 'normal.txt'), 'utf8'),
    'ordinary permissions retained',
  );
  await normal('HOLD_SOURCE', 'hold-source');
  await until(() => heldResponse, 'held model');
  const requestCount = modelRequests;
  await client.request('sourceProbe.start', { id: 'group-cancelled' });
  await delay(500);
  const waiting = await client.request('sourceProbe.status', {});
  const startsWhileBusy = waiting.runs.length;
  const stopped = await client.request('sourceProbe.stop', {}, { timeoutMs: 15000 });
  const sourceStillHeld = !heldResponse.destroyed;
  finish(heldResponse, 'HOLD_SOURCE_FINAL');
  await waitFinal('HOLD_SOURCE_FINAL');
  await delay(500);
  const final = await client.request('sourceProbe.status', {});
  assert.equal(startsWhileBusy, 0);
  assert.equal(stopped.state, 'cancelled');
  assert.equal(sourceStillHeld, true);
  assert.equal(modelRequests, requestCount);
  assert.equal(final.state, 'cancelled');
  const cancelledModelRequests = modelRequests - requestCount;
  const variants = [];
  const unrelatedKey = 'agent:alice:justdo:unrelated-probe';
  await client.request('sessions.create', {
    key: unrelatedKey,
    cwd: project,
    permissionMode: 'full',
  });
  await normal('SOURCE_NORMAL_UNRELATED', 'unrelated-before', unrelatedKey);
  await waitFinal('SOURCE_NORMAL_FINAL', unrelatedKey);
  for (const variant of ['internal', 'summary']) {
    const key =
      variant === 'summary'
        ? 'agent:alice:justdo:summary-probe'
        : 'agent:alice:justdo:source-internal-probe';
    await client.request('sessions.create', { key, cwd: project, permissionMode: 'full' });
    await normal('SOURCE_NORMAL', `${variant}-before`, key);
    await waitFinal('SOURCE_NORMAL_FINAL', key);
    const variantBefore = (await client.request('sourceProbe.status', { key })).source;
    const observationStart = observations.length;
    await client.request('sourceProbe.start', { id: `${variant}-first`, variant });
    const settled = await until(async () => {
      const status = await client.request('sourceProbe.status', { key });
      return status.state !== 'running' && status;
    }, `${variant} settlement`);
    assert.equal(settled.state, 'completed', JSON.stringify(settled));
    const expectedFinal = variant === 'summary' ? 'SOURCE_SUMMARY_FINAL' : 'SOURCE_GROUP_FINAL';
    assert.ok(
      settled.deliveries.some(
        item => item.identity.sessionKey === key && item.text.includes(expectedFinal),
      ),
      JSON.stringify(settled),
    );
    await waitFinal(expectedFinal, key);
    assert.equal(settled.source.sessionId, variantBefore.sessionId);
    const preserved =
      JSON.stringify(variantBefore.delivery) === JSON.stringify(settled.source.delivery);
    assert.equal(existsSync(path.join(project, 'forbidden.txt')), false);
    assert.ok(
      observations
        .slice(observationStart)
        .some(item => JSON.stringify(item.results).includes('SOURCE_PROJECT_MARKER')),
    );
    heldResponse = undefined;
    await normal('HOLD_SOURCE', `${variant}-hold`, key);
    await until(() => heldResponse, `${variant} held model`);
    const count = modelRequests;
    await client.request('sourceProbe.start', { id: `${variant}-cancelled`, variant });
    await delay(500);
    const queued = await client.request('sourceProbe.status', { key });
    let independentSourceRequests = 0;
    if (variant === 'summary') {
      const beforeIndependent = modelRequests;
      await normal('SOURCE_NORMAL_OTHER_AFTER', 'unrelated-during-summary', unrelatedKey);
      await waitFinal('OTHER_SOURCE_FINAL', unrelatedKey);
      independentSourceRequests = modelRequests - beforeIndependent;
    }
    const cancelled = await client.request('sourceProbe.stop', {}, { timeoutMs: 15000 });
    const sourceUnaffected = !heldResponse.destroyed;
    finish(heldResponse, 'HOLD_SOURCE_FINAL');
    await waitFinal('HOLD_SOURCE_FINAL', key);
    await delay(300);
    assert.equal(queued.runs.length, 0);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(sourceUnaffected, true);
    assert.equal(modelRequests, count + independentSourceRequests);
    heldResponse = undefined;
    await normal('HOLD_SOURCE', `${variant}-release-hold`, key);
    await until(() => heldResponse, `${variant} second held model`);
    await client.request('sourceProbe.start', { id: `${variant}-released`, variant });
    await delay(500);
    const beforeRelease = await client.request('sourceProbe.status', { key });
    assert.equal(beforeRelease.runs.length, 0);
    finish(heldResponse, 'HOLD_SOURCE_RELEASED');
    await waitFinal('HOLD_SOURCE_RELEASED', key);
    const released = await until(async () => {
      const status = await client.request('sourceProbe.status', { key });
      return status.state !== 'running' && status;
    }, `${variant} runs after source release`);
    assert.equal(released.state, 'completed', JSON.stringify(released));
    assert.equal(released.runs.length, variant === 'summary' ? 1 : 2);
    assert.ok(released.deliveries.some(item => item.text.includes(expectedFinal)));
    assert.deepEqual(released.source.delivery, variantBefore.delivery);
    const sourceRunIds = new Set(
      [...settled.runs, ...released.runs]
        .filter(run => run.identity.sessionKey === key)
        .map(run => run.runId),
    );
    const relatedEvents = gatewayEvents.filter(event => sourceRunIds.has(event.payload?.runId));
    const eventProjection = relatedEvents.map(event => ({
      event: event.event,
      sessionKey: event.payload?.sessionKey,
      runId: event.payload?.runId,
      stream: event.payload?.stream,
      state: event.payload?.state,
      keys: Object.keys(event.payload ?? {}),
    }));
    assert.ok(
      relatedEvents.some(event => event.payload?.sessionKey === key),
      `Missing source-key/run events for ${variant}`,
    );
    assert.ok(
      relatedEvents.every(event => !event.payload?.sessionKey || event.payload.sessionKey === key),
      'run events must not target another source',
    );
    variants.push({
      variant,
      routePreserved: preserved,
      before: variantBefore.delivery,
      after: settled.source.delivery,
      sourceSameSession: true,
      readonlyWriteRejected: true,
      visibleNativeHistory: true,
      busyNoSteer: true,
      queuedCancellation: true,
      sourceUnaffected: true,
      waitingExecutionResumed: true,
      gatewayEventCorrelation: eventProjection,
    });
  }
  const unrelatedHistory = await client.request('chat.history', { sessionKey: unrelatedKey });
  assert.ok(!JSON.stringify(unrelatedHistory).includes('SOURCE_GROUP_FINAL'));
  assert.ok(!JSON.stringify(unrelatedHistory).includes('SOURCE_SUMMARY_FINAL'));
  const safeObservations = observations.map(({ text, ...rest }) => rest);
  const report = {
    stateDirectory: state,
    version: JSON.parse(readFileSync(path.join(runtime, 'package.json'), 'utf8')).version,
    sourceSameSession: true,
    perRunWriteRejected: true,
    readExecuted: true,
    normalPermissionRetained: true,
    routePreserved,
    variants,
    unrelatedSourceHistoryIsolated: true,
    gatewayEventNames: [...new Set(gatewayEvents.map(event => event.event))],
    channelIngressCandidateGate: routePreserved ? 'candidate' : 'blocked-persistent-route-changed',
    before: routeFields(before),
    after: routeFields(after),
    busy: {
      startsWhileBusy,
      modelRequestsAfterStart: cancelledModelRequests,
      stopped: stopped.state,
      sourceStillHeld,
      finalState: final.state,
    },
    limitations: [
      'local deterministic model; no model quality claim',
      'no source-reset or restart recovery test',
      'channel ingress route failure; internal dispatch candidate passes tested scenarios',
      'no durable restart idempotency or Renderer event-correlation acceptance',
    ],
    observations: safeObservations,
  };
  writeFileSync(path.join(state, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (client) await client.stopAndWait().catch(() => client.stop());
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.connected) child.send('stop');
    else child.kill();
    const timer = setTimeout(() => child.kill(), 3000);
    await exited;
    clearTimeout(timer);
  }
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  writeFileSync(path.join(state, 'probe.log'), output.replaceAll(token, '<fixture-token>'));
  console.log(`Fixture log: ${path.join(state, 'probe.log')}`);
}
