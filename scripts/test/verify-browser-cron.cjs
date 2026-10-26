'use strict';

// Explicit real native at-timer probe; never connects to the user's Gateway.
// <runtime>/node-runtime/node.exe scripts/test/verify-browser-cron.cjs --runtime-dir <runtime>
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomInt } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
assert.equal(args[0], '--runtime-dir');
assert.equal(args.length, 2, 'Pass only --runtime-dir <prepared-runtime>');
const runtime = fs.realpathSync(path.resolve(args[1]));
const executable = fs.realpathSync(path.join(runtime, 'node-runtime/node.exe'));
assert.equal(
  fs.realpathSync(process.execPath),
  executable,
  'Use the selected runtime bundled Node',
);
const appPackage = require(path.join(root, 'package.json'));
const verifier = require('../openclaw/verify-openclaw-runtime-patches.cjs');
const { hostTarget } = require('../runtime/setup-node-runtime.cjs');
const version = appPackage.openclaw.version;
verifier.verifyFrozenOpenClawRuntime(runtime, {
  expectedVersion: version,
  expectedTarget: hostTarget(),
  requireBundle: true,
});
const buildInfo = require(path.join(runtime, 'runtime-build-info.json'));
assert.equal(
  verifier.buildOpenClawPatchSetFingerprint(root, version),
  buildInfo.patchSetSha256,
  'Native patch set must match the current feature source',
);
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const strictSourceRoot = fs.existsSync(path.resolve(runtime, '../../../package.json'))
  ? path.resolve(runtime, '../../..')
  : root;
let strictSourceProofError;
try {
  verifier.verifyOpenClawPatchManifest(runtime, { repoRoot: strictSourceRoot });
} catch (error) {
  strictSourceProofError = error.message;
}
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'build/bnc-'));
fs.mkdirSync(path.join(root, '.agent-tasks/browser-artifacts'), { recursive: true });
const artifactRoot = fs.mkdtempSync(
  path.join(root, '.agent-tasks/browser-artifacts/native-cron-中文 空格-'),
);
const workspace = path.join(artifactRoot, 'workspace');
for (const directory of [
  'h',
  'a',
  'l',
  't',
  'state',
  'workspace',
  'nc',
  'jiti',
  'xdg-cache',
  'xdg-config',
  'xdg-state',
  'runtime/dist/extensions',
])
  fs.mkdirSync(path.join(fixture, directory), { recursive: true });
fs.mkdirSync(workspace);
const configPath = path.join(fixture, 'openclaw.json');
const token = randomBytes(24).toString('hex');
const systemEnvironment = new Set([
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
  Object.entries(process.env).filter(([key]) => systemEnvironment.has(key.toUpperCase())),
);
const inheritedPath = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
if (inheritedPath) {
  env.PATH = `${path.dirname(executable)}${path.delimiter}${env[inheritedPath]}`;
  if (inheritedPath !== 'PATH') delete env[inheritedPath];
}
Object.assign(env, {
  HOME: path.join(fixture, 'h'),
  USERPROFILE: path.join(fixture, 'h'),
  APPDATA: path.join(fixture, 'a'),
  LOCALAPPDATA: path.join(fixture, 'l'),
  TEMP: path.join(fixture, 't'),
  TMP: path.join(fixture, 't'),
  OPENCLAW_HOME: fixture,
  OPENCLAW_STATE_DIR: path.join(fixture, 'state'),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixture, 'runtime/dist/extensions'),
  OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1',
  OPENCLAW_NO_RESPAWN: '1',
  OPENCLAW_SKIP_CHANNELS: '1',
  VITEST: 'true',
  OPENCLAW_TEST_RUNTIME_LOG: '1',
  NODE_ENV: 'test',
  NODE_DISABLE_COMPILE_CACHE: '1',
});
Object.assign(env, {
  TMPDIR: path.join(fixture, 't'),
  NODE_COMPILE_CACHE: path.join(fixture, 'nc'),
  JITI_CACHE_DIR: path.join(fixture, 'jiti'),
  XDG_CACHE_HOME: path.join(fixture, 'xdg-cache'),
  XDG_CONFIG_HOME: path.join(fixture, 'xdg-config'),
  XDG_STATE_HOME: path.join(fixture, 'xdg-state'),
});
// The public SDK creates its own device identity; isolate this importer too.
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);
const report = {
  ok: false,
  fixture,
  artifactRoot,
  workspace,
  boundaries:
    'real frozen native Gateway, authenticated SDK, at timer, current plugin and Main/Electron; deterministic local provider, no company model or SSO',
  runtime: {
    root: runtime,
    node: process.version,
    executable,
    version: buildInfo.openclawVersion,
    target: buildInfo.target,
    gatewayBundleSha256: sha256(path.join(runtime, 'gateway-bundle.mjs')),
    patchSetSha256: buildInfo.patchSetSha256,
    buildRecipeSha256: buildInfo.buildRecipeSha256,
    frozenRuntimeVerified: true,
    strictCurrentSourceProof: false,
    currentMainPluginSourceRoot: root,
    strictCurrentSourceProofReason:
      'This probe compiles current Main/plugin code separately and verifies a frozen native artifact; it does not validate a fresh complete application runtime build.',
    frozenArtifactSourceProof: !strictSourceProofError,
    strictNativeSourceRoot: strictSourceRoot,
    currentSourceBuildRecipeSha256: verifier.buildOpenClawBuildRecipeFingerprint(
      strictSourceRoot,
      version,
    ),
    strictSourceProofError,
  },
  paths: Object.fromEntries(
    [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      'OPENCLAW_HOME',
      'OPENCLAW_STATE_DIR',
      'OPENCLAW_CONFIG_PATH',
    ].map(key => [key, env[key]]),
  ),
  nodeCompileCacheDisabled: true,
  browserEvents: [],
  cronEvents: [],
  terminals: [],
  providerRequests: [],
  providerResults: {},
  siteVisits: [],
  rpcMethods: [],
};
let gateway;
let electron;
let socket;
let lifecycle;
let gatewayLog = '';
let failure;
let childReady = false;
let childReleased = false;
let childFinished = false;
let modelStep = 0;
let targetId;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = value =>
  String(value)
    .replaceAll(token, '<fixture-token>')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gu, '<synthetic-image>')
    .replace(/[A-Za-z0-9+/]{1024,}={0,2}/gu, '<long-encoded-payload>');
async function until(read, description, timeout = 30000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    if (failure) throw failure;
    if (await read()) return;
    if (gateway?.exitCode !== null && gateway?.exitCode !== undefined)
      throw new Error(`Gateway exited ${gateway.exitCode}`);
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}
async function listen(server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(randomInt(30000, 50000), '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      return server.address().port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No safe isolated loopback port available');
}
const textOf = content =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(block => block.text ?? '').join('\n')
      : '';
const provider = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/v1/models') {
      report.providerDiscoveryRequests = (report.providerDiscoveryRequests ?? 0) + 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'fixture', object: 'model', created: 1, owned_by: 'synthetic-local-provider' },
          ],
        }),
      );
      return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      assert.ok(raw.length < 10000000, 'Bound provider input');
    }
    const input = JSON.parse(raw);
    const browser = (input.tools ?? []).find(tool => tool.function?.name === 'browser');
    assert.ok(browser, 'Native cron must actually advertise the embedded browser schema');
    const messages = input.messages ?? [];
    const toolResults = messages.filter(message => message.role === 'tool');
    report.providerRequests.push({
      step: modelStep,
      browserSchema: true,
      toolResults: toolResults.map(message => message.tool_call_id),
      stream: input.stream === true,
    });
    assert.ok(report.providerRequests.length <= 5, 'No uncontrolled model loop');
    let command;
    let callId;
    if (modelStep === 0) {
      command = { action: 'open', url: report.pageUrl };
      callId = 'fixtureopen';
    }
    if (modelStep === 1) {
      const output = textOf(
        toolResults.find(message => message.tool_call_id === 'fixtureopen')?.content,
      );
      assert.match(output, /"headless"\s*:\s*true/u);
      targetId = /"targetId"\s*:\s*"([^"]+)"/u.exec(output)?.[1];
      assert.ok(targetId);
      report.providerResults.open = {
        toolCallId: 'fixtureopen',
        headless: true,
        targetId,
      };
      command = { action: 'text', targetId };
      callId = 'fixturetext';
    }
    if (modelStep === 2) {
      const output = textOf(
        toolResults.find(message => message.tool_call_id === 'fixturetext')?.content,
      );
      assert.match(output, /native-cron-page-verified/u);
      report.providerResults.text = { toolCallId: 'fixturetext', markerSeen: true };
      command = { action: 'screenshot', targetId };
      callId = 'fixturescreenshot';
    }
    if (modelStep === 3) {
      const result = toolResults.find(message => message.tool_call_id === 'fixturescreenshot');
      assert.ok(result, 'Native screenshot tool result returned to provider');
      const imageSeen = JSON.stringify(messages).includes('data:image/png;base64,');
      assert.equal(imageSeen, true, 'Actual native screenshot image must reach the model request');
      report.providerResults.screenshot = { toolCallId: 'fixturescreenshot', imageSeen };
    }
    const invoke = modelStep < 3;
    modelStep++;
    const toolCall = {
      id: callId,
      type: 'function',
      function: { name: 'browser', arguments: JSON.stringify(command) },
    };
    const text = 'Native cron browser fixture complete.';
    if (input.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const value of [
        {
          choices: [
            {
              index: 0,
              delta: invoke
                ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }
                : { role: 'assistant', content: text },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: invoke ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'synthetic-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', ...value })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'synthetic-fixture',
          object: 'chat.completion',
          model: 'fixture',
          choices: [
            {
              index: 0,
              message: invoke
                ? { role: 'assistant', content: null, tool_calls: [toolCall] }
                : { role: 'assistant', content: text },
              finish_reason: invoke ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    }
  } catch (error) {
    failure = error;
    response.writeHead(500);
    response.end('Synthetic provider protocol assertion failed');
  }
});
const site = http.createServer((request, response) => {
  report.siteVisits.push({ path: request.url, at: Date.now() });
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(
    '<!doctype html><html><meta charset="utf-8"><body style="background:#e5effa;color:#132c47;font:32px sans-serif"><h1>native-cron-page-verified</h1><p>真实原生定时器浏览器验证</p></body></html>',
  );
});

async function main() {
  const esbuild = require('esbuild');
  const entry = path.join(fixture, 'entry.ts');
  fs.writeFileSync(
    entry,
    [
      ['BackgroundBrowserHost', 'src/main/browser/backgroundBrowserHost.ts'],
      ['BrowserAgentBridge', 'src/main/browser/browserAgentBridge.ts'],
      ['EmbeddedBrowserGatewayBridge', 'src/main/browser/embeddedBrowserGatewayBridge.ts'],
      ['mapGatewayJob', 'src/main/scheduler/cronJobService.ts'],
      ['applyBrowserProxyPreference', 'src/main/core/network/systemProxyPreference.ts'],
    ]
      .map(([name, file]) => `export { ${name} } from ${JSON.stringify(path.join(root, file))};`)
      .join('\n'),
  );
  await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(fixture, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    packages: 'external',
  });
  report.mainBundleSha256 = sha256(path.join(fixture, 'main.cjs'));
  report.sdkEntrySha256 = sha256(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js'));
  const lifecycleEntry = path.join(fixture, 'lifecycle-entry.ts');
  fs.writeFileSync(
    lifecycleEntry,
    `export * from ${JSON.stringify(path.join(root, 'src/main/openclaw/runtime/launch/openclawLauncher.ts'))};\nexport { SHUTDOWN_BUDGET_MS } from ${JSON.stringify(path.join(root, 'src/shared/app/shutdownPolicy.ts'))};`,
  );
  await esbuild.build({
    entryPoints: [lifecycleEntry],
    outfile: path.join(fixture, 'lifecycle.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  lifecycle = require(path.join(fixture, 'lifecycle.cjs'));
  report.shutdownBudget = lifecycle.SHUTDOWN_BUDGET_MS;
  const pluginRoot = path.join(fixture, 'runtime/dist/extensions/embedded-browser');
  fs.cpSync(path.join(root, 'plugins/extensions/embedded-browser'), pluginRoot, {
    recursive: true,
  });
  await require('../openclaw/precompile-openclaw-extensions.cjs').precompileOpenClawExtensions(
    path.join(fixture, 'runtime'),
    { required: true },
  );
  report.pluginSourceSha256 = sha256(
    path.join(root, 'plugins/extensions/embedded-browser/index.ts'),
  );
  report.pluginBundleSha256 = sha256(path.join(pluginRoot, 'index.js'));
  const sitePort = await listen(site);
  report.pageUrl = `http://127.0.0.1:${sitePort}/native-cron`;
  const providerPort = await listen(provider);
  const reservation = net.createServer();
  const gatewayPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const config = {
    gateway: { mode: 'local', port: gatewayPort, bind: 'loopback', auth: { mode: 'token', token } },
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
              input: ['text', 'image'],
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
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  console.log(
    '[NativeBrowserCronProbe] Starting isolated frozen Gateway and current Main/plugin code',
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
      String(gatewayPort),
      '--bind',
      'loopback',
    ],
    { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  gateway.stdout.on('data', chunk => {
    gatewayLog = (gatewayLog + chunk).slice(-40000);
  });
  gateway.stderr.on('data', chunk => {
    gatewayLog = (gatewayLog + chunk).slice(-40000);
  });
  await until(
    async () => {
      try {
        return (
          await fetch(`http://127.0.0.1:${gatewayPort}/startupz`, {
            signal: AbortSignal.timeout(500),
          })
        ).ok;
      } catch {
        return false;
      }
    },
    'isolated Gateway startup',
    60000,
  );
  const { GatewayClient } = await import(
    pathToFileURL(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js')).href
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Native authenticated handshake timeout')),
      30000,
    );
    socket = new GatewayClient({
      url: `ws://127.0.0.1:${gatewayPort}`,
      token,
      clientName: 'gateway-client',
      mode: 'backend',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      caps: ['tool-events'],
      requestTimeoutMs: 20000,
      env,
      onHelloOk: hello => {
        clearTimeout(timer);
        if (hello.protocol === 4) resolve();
        else reject(new Error('Unexpected native Gateway protocol'));
      },
      onConnectError: error => {
        clearTimeout(timer);
        reject(error);
      },
      onEvent: event => {
        if (event.event === 'cron') report.cronEvents.push(event.payload);
        if (event.event.startsWith('plugin.embedded-browser.')) {
          const payload = event.payload;
          report.browserEvents.push({
            event: event.event,
            run: payload?.run,
            requestId: payload?.requestId,
            toolCallId: payload?.toolCallId,
            action: payload?.command?.action,
            reason: payload?.reason,
          });
          if (electron?.connected) electron.send({ type: 'gateway-event', event });
          else failure = new Error('Native browser event arrived before Electron');
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
  const rpc = (method, params) => {
    report.rpcMethods.push(method);
    return socket.request(method, params);
  };
  await until(async () => {
    try {
      await rpc('health', {});
      return true;
    } catch (error) {
      if (!String(error).includes('startup-sidecars')) throw error;
      return false;
    }
  }, 'native sidecars readiness');
  const catalog = await rpc('plugins.list', {});
  assert.equal(
    catalog.plugins.find(plugin => plugin.id === 'embedded-browser')?.runtime?.state,
    'active',
  );
  const electronPath = require('electron');
  electron = spawn(
    electronPath,
    [path.join(root, 'tests/browser-background-electron/native-cron.cjs'), fixture, artifactRoot],
    {
      cwd: root,
      env: { ...env, NODE_PATH: path.join(root, 'node_modules') },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  electron.stdout.on('data', () => {});
  electron.stderr.on('data', chunk => {
    report.electronDiagnostics = redact((report.electronDiagnostics ?? '') + chunk).slice(-4000);
  });
  electron.on('message', message => {
    if (message.type === 'ready') childReady = true;
    if (message.type === 'failure') failure = new Error(message.error);
    if (message.type === 'release-observed') {
      childReleased = true;
      report.electron = message.report;
    }
    if (message.type === 'finished') {
      childFinished = true;
      report.electron = message.report;
      if (message.code !== 0) failure ??= new Error('Electron native cron checks failed');
    }
    if (message.type === 'rpc') {
      if (!['cron.get', 'embeddedBrowser.resolve'].includes(message.method)) {
        failure = new Error('Unexpected child RPC');
        return;
      }
      void rpc(message.method, message.params).then(
        result => electron.send({ type: 'rpc-result', id: message.id, ok: true, result }),
        error =>
          electron.send({ type: 'rpc-result', id: message.id, ok: false, error: error.message }),
      );
    }
  });
  electron.once('exit', code => {
    if (!childFinished) failure = new Error(`Electron exited before completion: ${code}`);
  });
  await until(() => childReady, 'real Main/Electron ready');
  const at = new Date(Date.now() + 3000).toISOString();
  const job = await rpc('cron.add', {
    name: 'Synthetic native browser cron',
    schedule: { kind: 'at', at },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    agentId: 'main',
    payload: {
      kind: 'agentTurn',
      message:
        'Synthetic native browser verification. Use the browser tool to inspect the local fixture page and take a screenshot.',
      model: 'fixture/fixture',
      permissionMode: 'full',
      toolsAllow: ['browser'],
      timeoutSeconds: 60,
    },
    delivery: { mode: 'none' },
  });
  report.job = { id: job.id, schedule: job.schedule, createdAt: Date.now() };
  assert.ok(job.id);
  console.log('[NativeBrowserCronProbe] Native cron.add accepted; waiting for its actual at timer');
  await until(() => childReleased, 'actual timer, browser calls, final settled release', 90000);
  assert.equal(modelStep, 4);
  assert.ok(report.siteVisits.some(visit => visit.path === '/native-cron'));
  assert.deepEqual(
    report.browserEvents
      .filter(event => event.event.endsWith('.requested'))
      .map(event => event.action),
    ['open', 'text', 'screenshot'],
  );
  for (const event of report.browserEvents.filter(event => event.run)) {
    assert.equal(event.run.trigger, 'cron');
    assert.equal(event.run.jobId, job.id);
    assert.ok(event.run.sessionId && event.run.runId);
    assert.equal(path.resolve(event.run.workspaceDir), path.resolve(workspace));
  }
  const identity = report.browserEvents.find(event => event.event.endsWith('.requested')).run;
  for (const event of report.browserEvents.filter(event => event.run))
    assert.deepEqual(event.run, identity);
  assert.ok(
    report.siteVisits.find(visit => visit.path === '/native-cron').at >= Date.parse(at),
    'The site was visited before the real at timer',
  );
  await until(
    () =>
      report.terminals.some(
        event =>
          event.runId === identity.runId &&
          event.sessionKey === identity.sessionKey &&
          event.sessionId === identity.sessionId &&
          event.data.phase === 'end' &&
          event.data.executionSettled === true,
      ),
    'exact native whole-run settled terminal',
  );
  let runs;
  await until(async () => {
    runs = await rpc('cron.runs', {
      scope: 'job',
      id: job.id,
      limit: 10,
      offset: 0,
      sortDir: 'desc',
    });
    return runs.entries?.some(
      entry =>
        entry.action === 'finished' &&
        entry.jobId === identity.jobId &&
        entry.sessionId === identity.sessionId &&
        entry.sessionKey === identity.sessionKey,
    );
  }, 'native persistent cron run receipt');
  const finished = runs.entries.find(
    entry =>
      entry.action === 'finished' &&
      entry.jobId === identity.jobId &&
      entry.sessionId === identity.sessionId &&
      entry.sessionKey === identity.sessionKey,
  );
  assert.equal(finished.status, 'ok', JSON.stringify(finished));
  report.cronRun = finished;
  report.cronRunIdentity = {
    jobId: finished.jobId,
    sessionKey: finished.sessionKey,
    sessionId: finished.sessionId,
    runId: finished.runId ?? null,
    runIdContract:
      'Native timer receipts may omit runId; no ID is invented or inferred. Plugin events and the whole-run terminal must match the complete run identity.',
  };
  assert.equal(report.rpcMethods.includes('cron.run'), false);
  assert.equal(report.rpcMethods.includes('agent'), false);
  electron.send({ type: 'finish' });
  await until(() => childFinished, 'Electron owned-resource cleanup');
  report.ok = true;
}

main()
  .catch(error => {
    report.error = redact(error.stack);
    console.error('[NativeBrowserCronProbe]', redact(error.message));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (electron?.exitCode === null && electron?.signalCode === null) {
      if (electron.connected) electron.send({ type: 'finish' });
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          report.electronForceKilled = true;
          electron.kill();
        }, 8000);
        electron.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    report.electronExitCode = electron?.exitCode;
    report.electronSignalCode = electron?.signalCode;
    if (electron && (electron.exitCode !== 0 || report.electronForceKilled)) {
      report.ok = false;
      process.exitCode = 1;
    }
    const closing = [];
    if (socket) closing.push(socket.stopAndWait());
    if (gateway?.exitCode === null && gateway?.signalCode === null)
      closing.push(
        new Promise(resolve => {
          gateway.once('exit', resolve);
          if (gateway.connected) gateway.send(lifecycle.OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
          else gateway.kill();
          const timer = setTimeout(() => {
            report.gatewayForceKilled = true;
            gateway.kill();
          }, lifecycle.SHUTDOWN_BUDGET_MS.gatewayGrace);
          gateway.once('exit', () => clearTimeout(timer));
        }),
      );
    let cleanupDeadline;
    const cleanupResults = await Promise.race([
      Promise.allSettled(closing),
      new Promise(resolve => {
        cleanupDeadline = setTimeout(
          () => {
            report.cleanupTimedOut = true;
            resolve([
              {
                status: 'rejected',
                reason: new Error(
                  'Native process/client retirement remained unconfirmed after the production shutdown allowance',
                ),
              },
            ]);
          },
          (lifecycle?.SHUTDOWN_BUDGET_MS.gatewayStop ?? 350000) + 1000,
        );
      }),
    ]);
    clearTimeout(cleanupDeadline);
    for (const result of cleanupResults) {
      if (result.status === 'rejected') {
        report.ok = false;
        process.exitCode = 1;
        (report.cleanupErrors ??= []).push(redact(result.reason));
      }
    }
    report.gatewayExitCode = gateway?.exitCode;
    report.gatewaySignalCode = gateway?.signalCode;
    if (gateway && (gateway.exitCode !== 0 || report.gatewayForceKilled)) {
      report.ok = false;
      process.exitCode = 1;
    }
    provider.closeAllConnections();
    site.closeAllConnections();
    await Promise.all(
      [provider, site].map(server => new Promise(resolve => server.close(resolve))),
    );
    fs.writeFileSync(path.join(artifactRoot, 'gateway.log'), redact(gatewayLog));
    fs.writeFileSync(path.join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      `[NativeBrowserCronProbe] ${report.ok ? 'PASS' : 'FAIL'} report: ${path.join(artifactRoot, 'report.json')}`,
    );
    if (report.cleanupTimedOut) process.exit(1);
  });
