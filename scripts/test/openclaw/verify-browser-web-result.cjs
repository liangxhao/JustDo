'use strict';

// Opt-in capability probe. Only a new disposable Gateway and loopback model run.
// <runtime>/node-runtime/node.exe scripts/test/openclaw/verify-browser-web-result.cjs --runtime-dir <runtime>
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);
assert.equal(args[0], '--runtime-dir');
assert.equal(args.length, 2, 'Pass only --runtime-dir <prepared-runtime>');
const runtime = fs.realpathSync(path.resolve(args[1]));
const executable = fs.realpathSync(path.join(runtime, 'node-runtime/node.exe'));
assert.equal(fs.realpathSync(process.execPath), executable, 'Use the selected bundled Node');
const verifier = require('../../openclaw/verify-openclaw-runtime-patches.cjs');
const expectedVersion = require(path.join(root, 'package.json')).openclaw.version;
verifier.verifyFrozenOpenClawRuntime(runtime, {
  expectedVersion,
  expectedTarget: require('../../runtime/setup-node-runtime.cjs').hostTarget(),
  requireBundle: true,
});
const buildInfo = require(path.join(runtime, 'runtime-build-info.json'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const artifactRoot = path.join(root, '.agent-tasks/browser-artifacts');
fs.mkdirSync(artifactRoot, { recursive: true });
const artifacts = fs.mkdtempSync(path.join(artifactRoot, 'web-result-'));
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'build/wrp-'));
for (const directory of ['h', 'a', 'l', 't', 'state', 'workspace', 'cache', 'extensions'])
  fs.mkdirSync(path.join(fixture, directory), { recursive: true });
const workspace = path.join(fixture, 'workspace');
const fixtureFile = path.join(workspace, 'fixture.txt');
fs.writeFileSync(fixtureFile, 'SYNTHETIC_TOOL_READ_OK\n');
const configPath = path.join(fixture, 'openclaw.json');
const token = randomBytes(24).toString('hex');
const systemKeys = new Set([
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'SYSTEMDRIVE',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
]);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => systemKeys.has(name.toUpperCase())),
);
Object.assign(env, {
  HOME: path.join(fixture, 'h'),
  USERPROFILE: path.join(fixture, 'h'),
  APPDATA: path.join(fixture, 'a'),
  LOCALAPPDATA: path.join(fixture, 'l'),
  TEMP: path.join(fixture, 't'),
  TMP: path.join(fixture, 't'),
  TMPDIR: path.join(fixture, 't'),
  XDG_CACHE_HOME: path.join(fixture, 'cache'),
  XDG_CONFIG_HOME: path.join(fixture, 'cache'),
  XDG_STATE_HOME: path.join(fixture, 'state'),
  JITI_CACHE_DIR: path.join(fixture, 'cache'),
  OPENCLAW_HOME: fixture,
  OPENCLAW_STATE_DIR: path.join(fixture, 'state'),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixture, 'extensions'),
  OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1',
  OPENCLAW_NO_RESPAWN: '1',
  OPENCLAW_SKIP_CHANNELS: '1',
  VITEST: 'true',
  OPENCLAW_TEST_RUNTIME_LOG: '1',
  NODE_ENV: 'test',
  NODE_DISABLE_COMPILE_CACHE: '1',
});
// The SDK's device identity and every child process use the fixture too.
for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
Object.assign(process.env, env);

const report = {
  ok: false,
  boundaries:
    'Frozen native Gateway and authenticated native SDK; deterministic loopback provider; no product implementation, real company model, user profile, existing Gateway or transcript-file reads.',
  runtime: {
    root: runtime,
    executable,
    node: process.version,
    version: buildInfo.openclawVersion,
    target: buildInfo.target,
    gatewayBundleSha256: sha256(fs.readFileSync(path.join(runtime, 'gateway-bundle.mjs'))),
    gatewayAsarSha256: buildInfo.gatewayAsarSha256,
    patchSetSha256: buildInfo.patchSetSha256,
    buildRecipeSha256: buildInfo.buildRecipeSha256,
    frozenRuntimeVerified: true,
    strictCurrentSourceProof: false,
  },
  probeSha256: sha256(fs.readFileSync(__filename)),
  fixture,
  artifacts,
  paths: Object.fromEntries(
    [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'OPENCLAW_STATE_DIR',
      'OPENCLAW_CONFIG_PATH',
    ].map(name => [name, env[name]]),
  ),
  checks: [],
  runs: [],
  providerRequests: [],
  rpcMethods: [],
};
let gateway;
let client;
let lifecycle;
let gatewayOutput = '';
let failure;
let scenario;
const events = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const redact = value => String(value).replaceAll(token, '<fixture-token>');
const textOf = content =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(block => block.text ?? '').join('\n')
      : '';
const messageText = message => textOf(message.content ?? message.text);
const messageId = message =>
  message.__openclaw?.id ?? message.id ?? message.messageId ?? message.eventId;
const runIdOf = message => message.__openclaw?.runId;
const summarize = message => ({
  role: message.role,
  id: messageId(message),
  runId: runIdOf(message),
  phase: message.phase ?? message.__openclaw?.phase,
  stopReason: message.stopReason,
  text: messageText(message),
  contentTypes: Array.isArray(message.content) ? message.content.map(block => block.type) : [],
  metadata: message.__openclaw,
});
async function until(read, label, budget = 90000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const value = await read();
    if (value) return value;
    if (gateway && gateway.exitCode !== null)
      throw new Error(`Isolated Gateway exited ${gateway.exitCode}`);
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server.address().port;
}
async function rpc(method, params) {
  report.rpcMethods.push(method);
  return client.request(method, params);
}
function completion(response, input, step) {
  const invoke = step.tool;
  const message = {
    role: 'assistant',
    content: step.text,
    ...(invoke
      ? {
          tool_calls: [
            {
              id: `fixture-call-${scenario.cursor}`,
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ path: fixtureFile }) },
            },
          ],
        }
      : {}),
  };
  const usage = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 };
  const finish = invoke ? 'tool_calls' : 'stop';
  if (!input.stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion',
        model: 'fixture',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      }),
    );
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = {
    ...message,
    ...(invoke ? { tool_calls: message.tool_calls.map(call => ({ index: 0, ...call })) } : {}),
  };
  for (const value of [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
  ])
    response.write(
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', ...value })}\n\n`,
    );
  response.end('data: [DONE]\n\n');
}
const provider = http.createServer(async (request, response) => {
  try {
    assert.equal(request.socket.remoteAddress, '127.0.0.1');
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'fixture', object: 'model', owned_by: 'synthetic' }],
        }),
      );
      return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      assert.ok(raw.length < 1_000_000);
    }
    const input = JSON.parse(raw);
    assert.ok(scenario, 'No active fixture scenario');
    const step = scenario.steps[scenario.cursor++];
    assert.ok(step, `Unexpected model round in ${scenario.name}`);
    scenario.lastInput = input;
    report.providerRequests.push({
      name: scenario.name,
      round: scenario.cursor,
      roles: input.messages.map(message => message.role),
      toolNames: (input.tools ?? []).map(tool => tool.function?.name),
      toolResultSeen: input.messages.some(
        message =>
          message.role === 'tool' && textOf(message.content).includes('SYNTHETIC_TOOL_READ_OK'),
      ),
    });
    completion(response, input, step);
  } catch (error) {
    failure = error;
    response.writeHead(500);
    response.end('Synthetic fixture assertion failed');
  }
});

async function history(key) {
  const before = await rpc('sessions.describe', { key });
  const value = await rpc('chat.history', { sessionKey: key, limit: 100 });
  const after = await rpc('sessions.describe', { key });
  assert.equal(before.session.sessionId, after.session.sessionId);
  assert.equal(before.session.lifecycleRevision, after.session.lifecycleRevision);
  assert.equal(value.sessionId, before.session.sessionId);
  assert.equal(value.hasMore, false, 'Fixture history must be complete');
  return {
    value,
    identity: {
      sessionId: after.session.sessionId,
      lifecycleRevision: after.session.lifecycleRevision,
    },
  };
}
function candidates(snapshot, runId) {
  const groups = new Map();
  for (const message of snapshot.value.messages) {
    if (message.role !== 'assistant' || runIdOf(message) !== runId) continue;
    assert.ok(messageId(message), 'Candidate fragments require native message identity');
    const group = groups.get(messageId(message)) ?? [];
    group.push(message);
    groups.set(messageId(message), group);
  }
  return [...groups.values()].flatMap(group => {
    // Display history can split one native tool-bearing assistant into a text
    // fragment without stopReason plus a tool fragment with the same ID/seq.
    if (
      group.some(
        message =>
          ['toolUse', 'error', 'aborted'].includes(message.stopReason) ||
          message.content?.some?.(block =>
            ['toolCall', 'toolUse', 'functionCall'].includes(block.type),
          ),
      )
    )
      return [];
    if (!group.some(message => message.stopReason === 'stop')) return [];
    return [
      {
        ...group[0],
        stopReason: 'stop',
        content: group.flatMap(message =>
          Array.isArray(message.content)
            ? message.content
            : [{ type: 'text', text: messageText(message) }],
        ),
      },
    ];
  });
}
async function run(name, key, steps, expectedText) {
  scenario = { name, steps, cursor: 0 };
  const before = await rpc('sessions.describe', { key });
  const preparedIdentity = {
    sessionId: before.session.sessionId,
    lifecycleRevision: before.session.lifecycleRevision,
  };
  assert.ok(preparedIdentity.sessionId);
  assert.ok(preparedIdentity.lifecycleRevision);
  const accepted = await rpc('chat.send', {
    sessionKey: key,
    message: `Synthetic scenario: ${name}`,
    idempotencyKey: randomBytes(16).toString('hex'),
  });
  assert.ok(accepted.runId);
  const terminal = await until(
    () =>
      events.find(
        event =>
          event.event === 'agent' &&
          event.payload?.runId === accepted.runId &&
          event.payload?.sessionKey === key &&
          event.payload?.sessionId === preparedIdentity.sessionId &&
          event.payload?.stream === 'lifecycle' &&
          event.payload?.data?.executionSettled === true,
      ),
    `${name} exact whole-run terminal`,
  );
  if (expectedText) {
    assert.equal(terminal.payload.data.phase, 'end');
    assert.notEqual(terminal.payload.data.aborted, true);
  } else {
    assert.ok(['end', 'error'].includes(terminal.payload.data.phase));
  }
  let snapshot;
  if (expectedText) {
    snapshot = await until(async () => {
      const next = await history(key);
      return next.value.messages.some(message => messageText(message) === expectedText)
        ? next
        : null;
    }, `${name} committed final history`);
  } else {
    await sleep(1000);
    snapshot = await history(key);
  }
  assert.equal(scenario.cursor, steps.length);
  assert.deepEqual(snapshot.identity, preparedIdentity);
  const output = candidates(snapshot, accepted.runId);
  const evidence = {
    name,
    key,
    runId: accepted.runId,
    preparedIdentity,
    terminal: terminal.payload,
    identity: snapshot.identity,
    historyEnvelope: Object.fromEntries(
      Object.entries(snapshot.value).filter(([name]) => name !== 'messages'),
    ),
    messages: snapshot.value.messages.map(summarize),
    candidates: output.map(summarize),
  };
  report.runs.push(evidence);
  if (expectedText) {
    assert.equal(output.length, 1, `${name} must have exactly one native terminal candidate`);
    assert.equal(messageText(output[0]), expectedText);
    assert.ok(messageId(output[0]), 'Native message identity must be exposed');
    assert.equal(terminal.payload.sessionId, snapshot.identity.sessionId);
    assert.equal(terminal.payload.data.terminalReply?.disposition, 'visible');
    assert.equal(terminal.payload.data.terminalReply?.text, expectedText);
    const anchor = await rpc('chat.history', {
      sessionKey: key,
      sessionId: snapshot.identity.sessionId,
      messageId: messageId(output[0]),
      maxChars: 10000,
    });
    assert.equal(anchor.sessionId, snapshot.identity.sessionId);
    const anchored = candidates({ value: anchor }, accepted.runId);
    assert.equal(anchored.length, 1);
    assert.equal(messageId(anchored[0]), messageId(output[0]));
    assert.equal(messageText(anchored[0]), expectedText);
    const single = await rpc('chat.message.get', {
      sessionKey: key,
      sessionId: snapshot.identity.sessionId,
      messageId: messageId(output[0]),
      maxChars: 10000,
    });
    evidence.messageReread = { ok: single.ok, message: summarize(single.message) };
    assert.equal(single.ok, true);
    assert.equal(runIdOf(single.message), accepted.runId);
    assert.equal(messageId(single.message), messageId(output[0]));
    assert.equal(messageText(single.message), expectedText);
    const after = await rpc('sessions.describe', { key });
    assert.equal(after.session.sessionId, preparedIdentity.sessionId);
    assert.equal(after.session.lifecycleRevision, preparedIdentity.lifecycleRevision);
    report.checks.push(
      `${name}: exact run, whole-run terminal, final candidate and message reread`,
    );
  } else {
    evidence.noTextObservation = {
      candidateCount: output.length,
      authoritativeEmptyProven: false,
      terminalReply: terminal.payload.data.terminalReply,
      reason:
        'Ordinary user turns require a final reply. NO_REPLY can trigger a native recovery turn; neither silence tokens nor absence from history prove a successful empty result.',
    };
    report.checks.push(
      `${name}: exact terminal observed without inferring successful empty from silence`,
    );
  }
  console.log(`[WebResultProbe] PASS ${name}`);
  return { accepted, snapshot, evidence, output };
}

async function main() {
  const { buildSync } = require('esbuild');
  buildSync({
    entryPoints: [path.join(root, 'src/main/openclaw/runtime/launch/openclawLauncher.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(fixture, 'lifecycle.cjs'),
  });
  lifecycle = require(path.join(fixture, 'lifecycle.cjs'));
  const modelPort = await listen(provider);
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gateway: {
        mode: 'local',
        port,
        bind: 'loopback',
        auth: { mode: 'token', token },
        controlUi: { enabled: false },
      },
      discovery: { mdns: { mode: 'off' } },
      update: { checkOnStart: false, auto: { enabled: false } },
      agents: {
        ownership: 'explicit',
        entries: { main: {} },
        defaults: {
          embeddedAgent: { cyberFailover: { mode: 'off' } },
          workspace,
          skipBootstrap: true,
          heartbeat: { every: '0m' },
          model: { primary: 'fixture/fixture' },
          compaction: { mode: 'safeguard', memoryFlush: { enabled: false } },
        },
      },
      models: {
        mode: 'replace',
        catalogRefresh: { enabled: false },
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${modelPort}/v1`,
            apiKey: 'synthetic-local-only',
            api: 'openai-completions',
            agentRuntime: { id: 'openclaw' },
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: 'fixture',
                name: 'fixture',
                api: 'openai-completions',
                reasoning: false,
                input: ['text'],
                contextWindow: 64000,
                maxTokens: 2000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      tools: { allow: ['read'], codeMode: false, toolSearch: false },
      browser: { enabled: false },
      plugins: { slots: { memory: 'none' }, allow: [], entries: { browser: { enabled: false } } },
      logging: { file: path.join(fixture, 'state/gateway.log'), consoleLevel: 'debug' },
    }),
  );
  gateway = spawn(
    executable,
    [
      '--require',
      lifecycle.ensureGatewayShutdownPreload(fixture),
      path.join(runtime, 'gateway-launcher.cjs'),
      'gateway',
      'run',
      '--allow-unconfigured',
      '--port',
      String(port),
      '--bind',
      'loopback',
    ],
    { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  const capture = data => {
    gatewayOutput = (gatewayOutput + redact(data)).slice(-80000);
    fs.appendFileSync(path.join(artifacts, 'gateway-console.log'), redact(data));
  };
  gateway.stdout.on('data', capture);
  gateway.stderr.on('data', capture);
  await until(
    async () => {
      try {
        return (
          await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(500) })
        ).ok;
      } catch {
        return false;
      }
    },
    'isolated Gateway startup',
    120000,
  );
  const { GatewayClient } = await import(
    pathToFileURL(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js')).href
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Authenticated SDK handshake timeout')), 30000);
    client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientName: 'gateway-client',
      mode: 'backend',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      caps: ['tool-events'],
      env,
      requestTimeoutMs: 30000,
      onHelloOk: () => {
        clearTimeout(timer);
        resolve();
      },
      onConnectError: error => {
        clearTimeout(timer);
        reject(error);
      },
      onEvent: event => events.push(event),
    });
    client.start();
  });
  gateway.send(
    require(path.join(root, 'src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs'))
      .GATEWAY_READY_MESSAGE,
  );
  const key = 'agent:main:fixture:web-result';
  await rpc('sessions.create', { key, cwd: workspace, permissionMode: 'full' });
  const first = await run(
    'simple-final',
    key,
    [{ text: 'SYNTHETIC_FINAL_ONE' }],
    'SYNTHETIC_FINAL_ONE',
  );
  const second = await run(
    'tool-before-final',
    key,
    [{ text: 'SYNTHETIC_INTERMEDIATE_ONLY', tool: true }, { text: 'SYNTHETIC_FINAL_TWO' }],
    'SYNTHETIC_FINAL_TWO',
  );
  assert.ok(
    report.providerRequests.some(
      request => request.name === 'tool-before-final' && request.toolResultSeen,
    ),
    'Actual native read result must reach the follow-up model request',
  );
  const intermediate = second.snapshot.value.messages.find(
    message => messageText(message) === 'SYNTHETIC_INTERMEDIATE_ONLY',
  );
  assert.ok(intermediate, 'Native history must retain tool-before intermediate text');
  assert.equal(runIdOf(intermediate), second.accepted.runId);
  assert.ok(
    second.snapshot.value.messages.some(
      message => messageId(message) === messageId(intermediate) && message.stopReason === 'toolUse',
    ),
    'Tool-before text shares native ID with toolUse fragment',
  );
  assert.equal(candidates(second.snapshot, first.accepted.runId).length, 1);
  assert.equal(
    messageText(candidates(second.snapshot, first.accepted.runId)[0]),
    'SYNTHETIC_FINAL_ONE',
  );
  assert.notEqual(first.accepted.runId, second.accepted.runId);
  report.checks.push(
    'Tool-before text excluded and earlier exact result remains isolated after successor turn',
  );
  await run('native-no-reply', key, [{ text: 'NO_REPLY' }, { text: 'NO_REPLY' }]);
  report.finalResultCapability = {
    exactText: true,
    toolIntermediateIsolation: true,
    successorIsolation: true,
    exactMessageReread: true,
    authoritativeEmpty: false,
    limits:
      'No media, retry/fallback, compaction, truncation, restart or product Main/extension delivery proof; NO_REPLY absence is not an empty-result authority.',
  };
  report.ok = true;
}
main()
  .catch(error => {
    report.error = redact(error.stack);
    fs.writeFileSync(
      path.join(artifacts, 'failure-before-cleanup.json'),
      JSON.stringify(report, null, 2),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    const cleanupErrors = [];
    try {
      await within(Promise.resolve(client?.stopAndWait()), 8000, 'SDK close');
    } catch (error) {
      cleanupErrors.push(redact(error.stack));
      client?.stop();
    }
    try {
      if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
        await within(
          new Promise(resolve => {
            const timer = setTimeout(() => {
              report.gatewayForceKilled = true;
              gateway.kill();
            }, 60000);
            gateway.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            if (gateway.connected) gateway.send(lifecycle.OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
            else gateway.kill();
          }),
          65000,
          'Gateway exit after shutdown and force-kill deadline',
        );
      }
    } catch (error) {
      cleanupErrors.push(redact(error.stack));
      gateway?.kill();
    }
    try {
      provider.closeAllConnections();
      await within(
        new Promise(resolve => provider.close(resolve)),
        5000,
        'loopback provider close',
      );
    } catch (error) {
      cleanupErrors.push(redact(error.stack));
    }
    try {
      report.gatewayExitCode = gateway?.exitCode;
      report.gatewaySignal = gateway?.signalCode;
      if (report.gatewayForceKilled || gateway?.exitCode !== 0) {
        report.ok = false;
        process.exitCode = 1;
      }
    } catch (error) {
      cleanupErrors.push(redact(error.stack));
    }
    if (cleanupErrors.length) {
      report.cleanupErrors = cleanupErrors;
      report.ok = false;
      process.exitCode = 1;
    }
    fs.writeFileSync(path.join(artifacts, 'gateway-console.log'), gatewayOutput);
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      `[WebResultProbe] ${report.ok ? 'PASS' : 'FAIL'} report=${path.join(artifacts, 'report.json')}`,
    );
    if (cleanupErrors.length) process.exit(1);
  });
