'use strict';

// Opt-in native retry regression. All model responses and browser page results
// are synthetic; the Gateway, plugin hooks and Main event adapter are real.
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
assert.deepEqual(args.slice(0, 1), ['--runtime-dir']);
assert.ok(
  args.length === 2 || (args.length === 4 && args[2] === '--source-root'),
  'Pass --runtime-dir <prepared-runtime> [--source-root <baseline-source>]',
);
const runtime = fs.realpathSync(path.resolve(args[1]));
const sourceRoot = args[3] ? fs.realpathSync(path.resolve(args[3])) : root;
const executable = path.join(runtime, 'node-runtime/node.exe');
assert.equal(
  fs.realpathSync(process.execPath),
  fs.realpathSync(executable),
  'Use the selected runtime Node',
);
const verifier = require('../../openclaw/verify-openclaw-runtime-patches.cjs');
verifier.verifyFrozenOpenClawRuntime(runtime, {
  expectedVersion: require(path.join(root, 'package.json')).openclaw.version,
  expectedTarget: require('../../runtime/setup-node-runtime.cjs').hostTarget(),
  requireBundle: true,
});
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'build/brp-'));
const workspace = path.join(fixture, 'workspace');
const pluginRoot = path.join(fixture, 'runtime/dist/extensions/embedded-browser');
for (const directory of [
  'h',
  'a',
  'l',
  't',
  'state',
  'workspace',
  'cache',
  'runtime/dist/extensions',
])
  fs.mkdirSync(path.join(fixture, directory), { recursive: true });
const token = randomBytes(24).toString('hex');
const configPath = path.join(fixture, 'openclaw.json');
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
  Object.entries(process.env).filter(([key]) => systemKeys.has(key.toUpperCase())),
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
  OPENCLAW_HOME: fixture,
  OPENCLAW_STATE_DIR: path.join(fixture, 'state'),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixture, 'runtime/dist/extensions'),
  OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1',
  OPENCLAW_NO_RESPAWN: '1',
  OPENCLAW_SKIP_CHANNELS: '1',
  VITEST: 'true',
  OPENCLAW_TEST_RUNTIME_LOG: '1',
  OPENCLAW_TEST_CONSOLE: '1',
  NODE_ENV: 'test',
  NODE_DISABLE_COMPILE_CACHE: '1',
  JITI_CACHE_DIR: path.join(fixture, 'cache'),
});
// The authenticated SDK importer must use the same isolated device/state roots.
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);
const report = {
  ok: false,
  fixture,
  boundaries:
    'frozen native Gateway and current plugin/Main adapter; localhost synthetic model and browser execute result; no Electron, user profile, company service or transcript reads',
  gatewayBundleSha256: sha256(path.join(runtime, 'gateway-bundle.mjs')),
  strictCurrentSourceProof: false,
  requests: [],
  browserEvents: [],
  executions: [],
  releases: [],
  terminals: [],
};
let gateway;
let socket;
let bridge;
let lifecycle;
let failure;
let gatewayLog = '';
let modelStep = 0;
const key = 'agent:main:justdo:browser-retry-fixture';
const redact = value => String(value).replaceAll(token, '<fixture-token>');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, budget = 30000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (await read()) return;
    if (gateway && gateway.exitCode !== null)
      throw new Error(`Isolated Gateway exited ${gateway.exitCode}`);
    await delay(50);
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
const textOf = content =>
  typeof content === 'string' ? content : (content ?? []).map(block => block.text ?? '').join('\n');
function completion(response, input, command, callId) {
  const invoke = Boolean(command);
  const message = invoke
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: { name: 'browser', arguments: JSON.stringify(command) },
          },
        ],
      }
    : { role: 'assistant', content: 'Browser retry fixture complete.' };
  const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
  if (!input.stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion',
        model: 'fixture',
        choices: [{ index: 0, message, finish_reason: invoke ? 'tool_calls' : 'stop' }],
        usage,
      }),
    );
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = invoke
    ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] }
    : message;
  for (const value of [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: invoke ? 'tool_calls' : 'stop' }], usage },
  ])
    response.write(
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', ...value })}\n\n`,
    );
  response.end('data: [DONE]\n\n');
}
const provider = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'fixture', object: 'model', created: 1, owned_by: 'synthetic' }],
        }),
      );
      return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      assert.ok(raw.length < 1000000);
    }
    const input = JSON.parse(raw);
    assert.ok(
      input.tools?.some(tool => tool.function?.name === 'browser'),
      'Native runtime must advertise the actual browser tool',
    );
    const results = input.messages.filter(message => message.role === 'tool');
    report.requests.push({
      step: modelStep,
      results: results.map(message => message.tool_call_id),
    });
    assert.ok(report.requests.length <= 6, 'No uncontrolled model loop');
    if (modelStep === 0) {
      modelStep++;
      completion(
        response,
        input,
        { action: 'open', url: 'https://synthetic.invalid/retry' },
        'fixtureopen',
      );
      return;
    }
    if (modelStep === 1) {
      assert.match(
        textOf(results.find(message => message.tool_call_id === 'fixtureopen')?.content),
        /synthetic-browser-opened/u,
      );
      modelStep++;
      report.injected503At = Date.now();
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message: 'Authorization failed: automatic enrollment unavailable',
            type: 'server_error',
            code: 'synthetic_retry',
          },
        }),
      );
      return;
    }
    if (modelStep === 2) {
      modelStep++;
      completion(response, input, { action: 'status' }, 'fixturestatus');
      return;
    }
    const result = textOf(
      results.find(message => message.tool_call_id === 'fixturestatus')?.content,
    );
    report.statusResult = result;
    modelStep++;
    completion(response, input);
  } catch (error) {
    failure = error;
    response.writeHead(500);
    response.end('Synthetic provider assertion failed');
  }
});

async function main() {
  const { build } = require('esbuild');
  const entry = path.join(fixture, 'entry.ts');
  fs.writeFileSync(
    entry,
    [
      `export { EmbeddedBrowserGatewayBridge } from ${JSON.stringify(path.join(sourceRoot, 'src/main/browser/embeddedBrowserGatewayBridge.ts'))};`,
      `export * from ${JSON.stringify(path.join(root, 'src/main/openclaw/runtime/launch/openclawLauncher.ts'))};`,
      `export { SHUTDOWN_BUDGET_MS } from ${JSON.stringify(path.join(root, 'src/shared/app/shutdownPolicy.ts'))};`,
    ].join('\n'),
  );
  await build({
    entryPoints: [entry],
    outfile: path.join(fixture, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  lifecycle = require(path.join(fixture, 'main.cjs'));
  fs.cpSync(path.join(sourceRoot, 'plugins/extensions/embedded-browser'), pluginRoot, {
    recursive: true,
  });
  await require('../../openclaw/precompile-openclaw-extensions.cjs').precompileOpenClawExtensions(
    path.join(fixture, 'runtime'),
    { required: true },
  );
  report.pluginBundleSha256 = sha256(path.join(pluginRoot, 'index.js'));
  report.mainAdapterSha256 = sha256(path.join(fixture, 'main.cjs'));
  const providerPort = await listen(provider);
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
        },
      },
      models: {
        mode: 'replace',
        catalogRefresh: { enabled: false },
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${providerPort}/v1`,
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
                maxTokens: 4000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      tools: { allow: ['browser'], codeMode: false, toolSearch: false },
      browser: { enabled: true },
      plugins: {
        slots: { memory: 'none' },
        allow: ['embedded-browser'],
        entries: { browser: { enabled: false }, 'embedded-browser': { enabled: true } },
      },
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
  const capture = chunk => {
    gatewayLog = (gatewayLog + chunk).slice(-60000);
    fs.appendFileSync(path.join(fixture, 'gateway-output.log'), redact(chunk));
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
  bridge = new lifecycle.EmbeddedBrowserGatewayBridge({
    isEnabled: () => true,
    getDesktopSession: sessionKey =>
      sessionKey === key ? { id: 'browser-retry-fixture', cwd: workspace } : null,
    getScheduledTask: async () => null,
    execute: async (_sessionKey, command, signal, scope) => {
      signal.throwIfAborted();
      report.executions.push({ action: command.action, runId: scope.runId });
      return {
        ok: true,
        targetId: 'synthetic-page',
        url: 'https://synthetic.invalid/retry',
        marker: command.action === 'open' ? 'synthetic-browser-opened' : 'synthetic-browser-status',
      };
    },
    releaseScope: (id, closePages) => report.releases.push({ id, closePages }),
    revokeAll() {},
    resolve: (requestId, response) =>
      socket.request('embeddedBrowser.resolve', { requestId, ...response }),
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Isolated authenticated handshake timeout')),
      30000,
    );
    socket = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientName: 'gateway-client',
      mode: 'backend',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      caps: ['tool-events'],
      requestTimeoutMs: 20000,
      env,
      onHelloOk: () => {
        clearTimeout(timer);
        resolve();
      },
      onConnectError: error => {
        clearTimeout(timer);
        reject(error);
      },
      onEvent: event => {
        if (event.event.startsWith('plugin.embedded-browser.')) {
          const value = event.payload;
          report.browserEvents.push({
            event: event.event,
            run: value?.run,
            action: value?.command?.action,
            at: Date.now(),
            admissionRevision: value?.admissionRevision,
          });
          bridge.handleEvent(event);
        }
        if (
          event.event === 'agent' &&
          event.payload?.stream === 'lifecycle' &&
          event.payload?.data?.executionSettled === true
        )
          report.terminals.push(event.payload);
      },
    });
    socket.start();
  });
  await until(async () => {
    try {
      await socket.request('health', {});
      return true;
    } catch (error) {
      if (!String(error).includes('startup-sidecars')) throw error;
      return false;
    }
  }, 'native sidecar readiness');
  await socket.request('sessions.create', { key, cwd: workspace, permissionMode: 'full' });
  const send = await socket.request('chat.send', {
    sessionKey: key,
    message: 'Synthetic browser retry verification: use browser open, then browser status.',
    deliver: false,
    idempotencyKey: randomBytes(16).toString('hex'),
  });
  report.acceptedRunId = send.runId;
  await until(
    () => report.terminals.some(event => event.runId === send.runId),
    'same-run whole execution terminal',
    90000,
  );
  report.nativeSameModelRetry = /transient same-model retry 1\//u.test(gatewayLog);
  assert.equal(
    report.nativeSameModelRetry,
    true,
    '503 must reach the native same-model retry owner',
  );
  const requested = report.browserEvents.filter(event => event.event.endsWith('.requested'));
  assert.ok(
    requested.some(event => event.action === 'open'),
    'Initial browser call must pass native/plugin admission',
  );
  assert.ok(
    report.browserEvents.some(
      event => event.event.endsWith('.revoked') && event.at >= report.injected503At,
    ),
    'Failed attempt cleanup must revoke old browser effects',
  );
  assert.deepEqual(
    requested.map(event => event.action),
    ['open', 'status'],
    'Retried status must pass current plugin admission',
  );
  assert.deepEqual(
    report.executions.map(event => event.action),
    ['open', 'status'],
    'Retried status must pass the actual Main event adapter',
  );
  assert.match(report.statusResult, /synthetic-browser-status/u);
  const identity = requested[0].run;
  for (const event of requested) {
    assert.equal(event.run.runId, send.runId, 'Retry must retain exact native run identity');
    assert.deepEqual(
      event.run,
      identity,
      'Retry must retain the exact native session, trigger and workspace',
    );
  }
  assert.ok(
    report.terminals.some(
      event =>
        event.runId === send.runId &&
        event.sessionId === identity.sessionId &&
        event.sessionKey === identity.sessionKey &&
        event.data.phase === 'end' &&
        event.data.aborted !== true,
    ),
    'Recovered native run must settle successfully',
  );
  report.ok = true;
}
main()
  .catch(error => {
    report.error = redact(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    bridge?.revoke();
    await socket?.stopAndWait();
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          report.gatewayForceKilled = true;
          gateway.kill();
        }, lifecycle.SHUTDOWN_BUDGET_MS.gatewayGrace);
        gateway.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        if (gateway.connected) gateway.send(lifecycle.OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
        else gateway.kill();
      });
    }
    await new Promise(resolve => provider.close(resolve));
    report.gatewayExitCode = gateway?.exitCode;
    if (report.gatewayForceKilled || (gateway && gateway.exitCode !== 0)) {
      report.ok = false;
      process.exitCode = 1;
    }
    report.nativeLogSignals = gatewayLog
      .split(/\r?\n/u)
      .filter(line =>
        /transient same-model retry|no current native execution authority/u.test(line),
      )
      .map(redact);
    if (!report.ok) report.gatewayDiagnostics = redact(gatewayLog).slice(-12000);
    fs.writeFileSync(path.join(fixture, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        ok: report.ok,
        report: path.join(fixture, 'report.json'),
        executions: report.executions,
        nativeSameModelRetry: report.nativeSameModelRetry,
        error: report.error?.split('\n')[0],
      }),
    );
  });
