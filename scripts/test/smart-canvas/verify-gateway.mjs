import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveNativeSmokeTarget } from '../../../tests/openclaw/runtime/native-smoke-target.mjs';

const require = createRequire(import.meta.url);
const {
  precompileOpenClawExtensions,
} = require('../../openclaw/precompile-openclaw-extensions.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const serve = args.includes('--serve');
const verifyRetention = args.includes('--retention');
const verifyToolDispatch = args.includes('--tool-dispatch');
const verifyInteraction = args.includes('--interaction-contract');
const verifyPresentation = args.includes('--presentation');
assert.ok(
  !verifyPresentation || verifyInteraction,
  'Use --presentation with --interaction-contract',
);
assert.ok(
  !verifyInteraction || (!serve && !verifyToolDispatch && !verifyRetention),
  'Use --interaction-contract separately from --serve, --tool-dispatch and --retention',
);
assert.ok(
  !verifyToolDispatch || !verifyRetention,
  'Use --tool-dispatch separately from --retention',
);
const supportedFlags = new Set([
  '--serve',
  '--retention',
  '--tool-dispatch',
  '--interaction-contract',
  '--presentation',
  '--viewer-origin',
]);
for (const arg of args) {
  if (arg.startsWith('--'))
    assert.ok(supportedFlags.has(arg), `Unknown verification option: ${arg}`);
}
const viewerOriginFlag = args.indexOf('--viewer-origin');
const viewerOrigin = viewerOriginFlag >= 0 ? args[viewerOriginFlag + 1] : 'http://127.0.0.1:43390';
const parsedViewerOrigin = new URL(viewerOrigin);
assert.equal(parsedViewerOrigin.protocol, 'http:');
assert.equal(parsedViewerOrigin.hostname, '127.0.0.1');
assert.equal(parsedViewerOrigin.origin, viewerOrigin, 'Use one exact loopback viewer origin');
const requestedRuntime =
  args[0] && !args[0].startsWith('--') ? args[0] : process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR;
assert.ok(requestedRuntime, 'Select the final runtime explicitly.');
const { runtimeRoot: runtime, identity: runtimeIdentity } =
  resolveNativeSmokeTarget(requestedRuntime);
const runtimePackage = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
assert.equal(runtimePackage.version, '2026.10.7', 'Use the locked prepared runtime');
const buildInfo = JSON.parse(await readFile(path.join(runtime, 'runtime-build-info.json'), 'utf8'));
const fixture = await mkdtemp(path.join(os.tmpdir(), 'smart-canvas-gateway-'));
const state = path.join(fixture, 'state');
const workspace = path.join(fixture, 'project');
const bundledSkillsDir = path.join(fixture, 'bundled-skills');
const pluginRoot = path.join(fixture, 'runtime/dist/extensions/smart-canvas');
const loadTracePath = path.join(fixture, 'smart-canvas-module-loads.log');
const configPath = path.join(fixture, 'openclaw.json');
const token = randomBytes(24).toString('hex');
const widgetMarker = 'Synthetic native HTML widget';
const widgetArgs = {
  title: 'Synthetic HTML selection',
  kind: 'html',
  widget_code: `<main>
  <h2>${widgetMarker}</h2>
  <label>Value <input id="value-input" type="range" min="1" max="10" value="2"></label>
  <output id="value">2</output>
  <button id="follow" type="button">Analyze this selection</button>
</main>
<script>
  const input = document.getElementById('value-input');
  input.addEventListener('input', () => {
    document.getElementById('value').textContent = input.value;
  });
  document.getElementById('follow').addEventListener('click', event => {
    if (event.isTrusted) void openclaw.prompt.send('Analyze the synthetic selection: ' + input.value);
  });
</script>`,
};
const modelRequests = [];
const nativeToolResults = new Map();
const nativeDispatchResults = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
async function readLoadTrace() {
  try {
    return await readFile(loadTracePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function assertWidgetHtml(html) {
  for (const marker of [widgetMarker, 'id="value-input"', 'id="follow"']) {
    assert.ok(html.includes(marker), `Native widget HTML missing ${marker}`);
  }
}

let gateway;
let launcherLifecycle;
let gatewayLog = '';
const sockets = new Set();
const provider = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      assert.ok(raw.length < 2_000_000, 'Bound fixture provider input');
    }
    const input = JSON.parse(raw);
    const tools = input.tools ?? [];
    const widget = tools.find(tool => tool.function?.name === 'show_widget');
    const dispatcher = tools.find(tool => tool.function?.name === 'tool_call');
    if (widget) {
      assert.deepEqual(
        widget.function.parameters.properties.kind.enum,
        ['html'],
        'Native show_widget exposes only HTML source kinds',
      );
    }
    const messages = input.messages ?? [];
    const turnStart = messages.findLastIndex(
      message =>
        message.role === 'user' &&
        /fixture-(headless|inline|disabled|live|retention|interaction):/.test(
          JSON.stringify(message.content),
        ),
    );
    const turnMessages = messages.slice(turnStart + 1);
    const headless =
      turnStart >= 0 && JSON.stringify(messages[turnStart].content).includes('fixture-headless:');
    const completed = turnMessages.some(message => message.role === 'tool');
    for (const message of turnMessages) {
      if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
      const output = findCanvas(message.content);
      if (output)
        nativeToolResults.set(message.tool_call_id, { toolCallId: message.tool_call_id, output });
      if (verifyToolDispatch) {
        const wrapped = readNativeDispatcherEnvelope(message.content);
        assert.ok(wrapped, 'Model receives the actual native core dispatcher result');
        nativeDispatchResults.set(message.tool_call_id, {
          toolCallId: message.tool_call_id,
          output: wrapped,
        });
      }
    }
    modelRequests.push({
      headless,
      widgetAvailable: Boolean(widget),
      dispatcherAvailable: Boolean(dispatcher),
      interactionSeen:
        turnStart >= 0 &&
        JSON.stringify(messages[turnStart].content).includes('fixture-interaction: budget=5000'),
    });
    assert.ok(
      modelRequests.length <=
        (serve ? 40 : verifyInteraction ? 12 : 8) + (verifyRetention ? 66 : 0),
      'No uncontrolled model loop',
    );
    const invoke =
      !headless && (verifyToolDispatch ? Boolean(dispatcher) : Boolean(widget)) && !completed;
    const toolCall = {
      id: `fixture-widget-${modelRequests.length}`,
      type: 'function',
      function: verifyToolDispatch
        ? {
            name: 'tool_call',
            arguments: JSON.stringify({ id: 'openclaw:core:show_widget', args: widgetArgs }),
          }
        : { name: 'show_widget', arguments: JSON.stringify(widgetArgs) },
    };
    const text = 'Synthetic fixture complete.';
    if (input.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: invoke ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] } : { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: invoke ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'fixture',
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
    response.writeHead(500);
    response.end(String(error.message));
  }
});

async function adjacentLoopbackPorts() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = net.createServer();
    const second = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        first.once('error', reject);
        first.listen(0, '127.0.0.1', resolve);
      });
      const port = first.address().port;
      if (port === 65535) continue;
      await new Promise((resolve, reject) => {
        second.once('error', reject);
        second.listen(port + 1, '127.0.0.1', resolve);
      });
      return port;
    } catch {
      // Reserve a fresh adjacent pair rather than sharing a developer Gateway.
    } finally {
      await Promise.all(
        [first, second].map(server => new Promise(resolve => server.close(resolve))),
      );
    }
  }
  throw new Error('No isolated adjacent loopback ports available');
}

async function stopGateway() {
  const joins = [...sockets].map(socket => socket.stopAndWait());
  if (gateway && gateway.exitCode === null) {
    const child = gateway;
    joins.push(
      (async () => {
        await new Promise(resolve => {
          child.once('exit', resolve);
          if (child.connected) child.send(launcherLifecycle.OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
          else child.kill();
          const timer = setTimeout(() => child.kill(), 90_000);
          child.once('exit', () => clearTimeout(timer));
        });
        assert.equal(child.exitCode, 0, 'Isolated Gateway closes its native resources cleanly');
      })(),
    );
  }
  // Auth persistence may need the Gateway's state-writer lease to retire first.
  const settled = await Promise.allSettled(joins);
  sockets.clear();
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
}

async function startGateway(port, env) {
  gateway = spawn(
    process.execPath,
    [
      '--require',
      launcherLifecycle.ensureGatewayShutdownPreload(fixture),
      path.join(runtime, 'gateway-launcher.cjs'),
      'gateway',
      'run',
      '--allow-unconfigured',
      '--port',
      String(port),
      '--bind',
      'loopback',
    ],
    {
      cwd: fixture,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  gateway.stdout.on('data', chunk => {
    gatewayLog = (gatewayLog + chunk).slice(-40_000);
  });
  gateway.stderr.on('data', chunk => {
    gatewayLog = (gatewayLog + chunk).slice(-40_000);
  });
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (gateway.exitCode !== null) throw new Error(`Isolated Gateway exited ${gateway.exitCode}`);
    try {
      if (
        (await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(500) })).ok
      )
        return;
    } catch {
      /* Wait for this isolated listener only. */
    }
    await delay(200);
  }
  throw new Error('Isolated Gateway startup timed out');
}

async function connectOnce(port, caps) {
  const { GatewayClient } = await import(
    pathToFileURL(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js')).href
  );
  const events = [];
  let socket;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Isolated Gateway handshake timed out')),
        60_000,
      );
      socket = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: 'gateway-client',
        mode: 'backend',
        scopes: ['operator.admin', 'operator.read', 'operator.write'],
        caps,
        requestTimeoutMs: 20_000,
        env: process.env,
        onEvent: event => events.push(event),
        onHelloOk: hello => {
          clearTimeout(timer);
          if (hello.protocol !== 4) reject(new Error('Unexpected native Gateway protocol'));
          else resolve();
        },
        onConnectError: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      sockets.add(socket);
      socket.start();
    });
  } catch (error) {
    // Retire transport now; final shutdown joins auth persistence with the Gateway.
    socket?.stop();
    throw error;
  }
  // A business mutation is submitted once; an unknown response is never replayed.
  const rpc = (method, params) => socket.request(method, params);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await rpc('health', {});
      break;
    } catch (error) {
      if (!String(error).includes('startup-sidecars')) throw error;
      await delay(200);
    }
  }
  return { rpc, events };
}

async function connect(port, caps) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await connectOnce(port, caps);
    } catch (error) {
      if (!/gateway starting|startup-sidecars/.test(String(error))) throw error;
      await delay(200);
    }
  }
  throw new Error('Isolated Gateway never admitted fixture connection');
}

async function runTurn(client, key, message, existingSession) {
  const session =
    existingSession ??
    (await client.rpc('sessions.create', {
      key,
      cwd: workspace,
      permissionMode: 'workspace',
    }));
  const receipt = await client.rpc('chat.send', {
    sessionKey: key,
    idempotencyKey: randomBytes(8).toString('hex'),
    message,
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await client.rpc('agent.wait', { runId: receipt.runId, timeoutMs: 1 });
    if (result.status === 'ok') return { session, receipt };
    if (result.status === 'error')
      throw new Error(`Synthetic turn failed: ${JSON.stringify(result)}`);
    await delay(200);
  }
  throw new Error('Synthetic turn did not settle');
}

function findCanvas(value, depth = 0) {
  if (depth > 12 || !value) return undefined;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      return findCanvas(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object') return undefined;
  if (value.kind === 'canvas' && typeof value.view?.id === 'string') return value;
  for (const child of Object.values(value)) {
    const descriptor = findCanvas(child, depth + 1);
    if (descriptor) return descriptor;
  }
  return undefined;
}

// This fixture validates the exact native dispatch envelope, never arbitrary
// recursive result text. Native transcript files remain Gateway-owned.
function readNativeDispatcherEnvelope(value) {
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value
            .filter(block => block?.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join('\n')
        : '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    parsed?.tool?.id !== 'openclaw:core:show_widget' ||
    parsed.tool.name !== 'show_widget' ||
    parsed.tool.source !== 'openclaw' ||
    !Array.isArray(parsed.result?.content) ||
    parsed.result?.details?.kind !== 'canvas' ||
    parsed.result.details.presentation?.target !== 'assistant_message' ||
    parsed.result.details.presentation.sandbox !== 'scripts' ||
    typeof parsed.result.details.view?.id !== 'string'
  )
    return undefined;
  return parsed;
}

function assertDispatcherHistory(history, docId) {
  const rows = history.messages;
  assert.ok(Array.isArray(rows), 'Native chat.history publishes message rows');
  const matches = rows.flatMap(row => {
    const message = row.message ?? row;
    if (
      String(message.role).toLowerCase() !== 'toolresult' ||
      message.toolName !== 'tool_call' ||
      message.isError === true
    )
      return [];
    const wrapped = readNativeDispatcherEnvelope(message.content);
    return wrapped?.result.details.view.id === docId ? [{ message, wrapped }] : [];
  });
  assert.equal(
    matches.length,
    1,
    'Exactly one authentic outer dispatcher result survives native history',
  );
  assert.ok(matches[0].message.toolCallId, 'History retains the actual outer call identity');
  return matches[0];
}

try {
  await mkdir(state);
  await mkdir(workspace);
  await mkdir(bundledSkillsDir);
  const lifecycleFile = path.join(fixture, 'host-lifecycle.cjs');
  require('esbuild').buildSync({
    entryPoints: [path.join(root, 'src/main/openclaw/runtime/launch/openclawLauncher.ts')],
    outfile: lifecycleFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  launcherLifecycle = require(lifecycleFile);
  await cp(path.join(root, 'plugins/extensions/smart-canvas'), pluginRoot, { recursive: true });
  const print = console.log;
  try {
    console.log = () => {};
    await precompileOpenClawExtensions(path.join(fixture, 'runtime'), { required: true });
  } finally {
    console.log = print;
  }
  const pluginManifest = JSON.parse(
    await readFile(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8'),
  );
  assert.deepEqual(pluginManifest.activation, { onStartup: false });
  const pluginPackage = JSON.parse(await readFile(path.join(pluginRoot, 'package.json'), 'utf8'));
  assert.deepEqual(pluginPackage.openclaw.extensions, ['./index.js']);
  // Observe evaluation of the copied plugin entry without changing its registration behavior.
  const pluginEntry = path.join(pluginRoot, 'index.js');
  const entrySource = await readFile(pluginEntry, 'utf8');
  await writeFile(
    pluginEntry,
    `${entrySource}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(loadTracePath)}, "entry\\n");\n`,
  );
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = provider.address().port;
  const port = await adjacentLoopbackPorts();
  const config = {
    gateway: {
      mode: 'local',
      port,
      bind: 'loopback',
      auth: { mode: 'token', token },
      controlUi: { allowedOrigins: [viewerOrigin] },
    },
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
    tools: {
      allow: ['read', 'show_widget'],
      codeMode: false,
      toolSearch: verifyToolDispatch ? { enabled: true, mode: 'directory' } : false,
    },
    plugins: {
      allow: ['smart-canvas'],
      entries: { 'smart-canvas': { enabled: !verifyToolDispatch } },
    },
  };
  await writeFile(configPath, JSON.stringify(config));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.toUpperCase().startsWith('OPENCLAW_') &&
        !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase()),
    ),
  );
  Object.assign(env, {
    OPENCLAW_HOME: fixture,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(pluginRoot),
    // Isolate the plugin's skill from the upstream skill with the same name.
    OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkillsDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1',
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_SKIP_CHANNELS: '1',
    OPENCLAW_SKIP_CRON: '1',
    VITEST: 'true',
  });
  // Native device identity is created only inside this disposable profile.
  for (const key of Object.keys(process.env))
    if (key.toUpperCase().startsWith('OPENCLAW_')) delete process.env[key];
  Object.assign(process.env, env);
  await startGateway(port, env);
  const headless = await connect(port, ['tool-events']);
  const inline = await connect(port, ['tool-events', 'inline-widgets']);
  const catalog = await inline.rpc('plugins.list', {});
  const initialPlugin = catalog.plugins.find(plugin => plugin.id === 'smart-canvas');
  if (verifyToolDispatch) {
    assert.equal(initialPlugin?.enabled, false);
    assert.ok(['disabled', 'unloaded'].includes(initialPlugin?.runtime?.state));
  } else {
    assert.equal(initialPlugin?.enabled, true);
    assert.notEqual(initialPlugin?.runtime?.state, 'active', 'Enabled plugin remains unloaded');
  }
  const visualizePath = await realpath(path.join(pluginRoot, 'skills', 'visualize', 'SKILL.md'));
  const hasSmartCanvasSkill = async client => {
    const { skills } = await client.rpc('skills.status', { agentId: 'main' });
    const skill = skills.find(entry => entry.name === 'visualize');
    return skill?.eligible === true && path.relative(visualizePath, await realpath(skill.filePath)) === '';
  };
  assert.equal(await hasSmartCanvasSkill(inline), !verifyToolDispatch);
  assert.equal(await readLoadTrace(), '', 'Startup and skill discovery do not load Smart Canvas');
  const headlessKey = 'agent:main:smart-canvas:fixture-headless';
  const inlineKey = 'agent:main:smart-canvas:fixture-inline';
  await runTurn(headless, headlessKey, 'fixture-headless: Explain the synthetic delivery inputs.');
  assert.ok(
    modelRequests.some(request => request.headless && !request.widgetAvailable),
    'Originating headless client has no show_widget',
  );
  const blocked = await headless.rpc('tools.invoke', {
    name: 'show_widget',
    sessionKey: headlessKey,
    args: widgetArgs,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'not_found');
  assert.equal(await readLoadTrace(), '', 'Headless requests do not load Smart Canvas');
  const inlineTurn = await runTurn(
    inline,
    inlineKey,
    'fixture-inline: Show the synthetic HTML selection.',
  );
  assert.ok(
    modelRequests.some(
      request =>
        !request.headless &&
        (verifyToolDispatch ? request.dispatcherAvailable : request.widgetAvailable),
    ),
    'Inline client receives the requested real native tool surface',
  );
  const history = await inline.rpc('chat.history', { sessionKey: inlineKey, limit: 20 });
  const descriptor = findCanvas(history) ?? findCanvas(inline.events);
  assert.ok(descriptor, 'Native tool returns a canonical Canvas descriptor');
  assert.equal(descriptor.presentation.target, 'assistant_message');
  assert.equal(descriptor.presentation.sandbox, 'scripts');
  const docId = descriptor.view.id;
  let toolResult = verifyToolDispatch
    ? [...nativeDispatchResults.values()].find(
        result => result.output.result.details.view.id === docId,
      )
    : [...nativeToolResults.values()].find(result => result.output.view.id === docId);
  assert.ok(toolResult, 'Capture the actual native model-facing tool output and toolCallId');
  assert.equal(typeof inlineTurn.session.sessionId, 'string');
  assert.match(docId, /^cv_[A-Za-z0-9_-]+$/);
  assert.ok(JSON.stringify(history).includes(docId), 'Gateway history restores native descriptor');
  if (verifyToolDispatch) {
    const wrapped = assertDispatcherHistory(history, docId);
    assert.deepEqual(
      wrapped.wrapped,
      toolResult.output,
      'Native history preserves the actual model-facing dispatcher envelope',
    );
    // Provider-format adapters can normalize outgoing model-facing call IDs.
    // The Gateway history identity remains the canonical native outer call.
    toolResult = { ...toolResult, toolCallId: wrapped.message.toolCallId };
  }
  const manifest = JSON.parse(
    await readFile(path.join(state, 'canvas/documents', docId, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.id, docId);
  assert.equal(manifest.localEntrypoint, 'index.html');
  assert.equal(manifest.cspSandbox, 'scripts');
  const view = await inline.rpc('canvas.document.view', { docId });
  for (const marker of [
    'openclaw:widget-prompt-offer',
    'Content-Security-Policy',
  ])
    assert.ok(view.html.includes(marker), `Canonical document missing ${marker}`);
  assertWidgetHtml(view.html);
  assert.ok(!view.html.includes(token));
  assert.ok(view.sandboxUrl && view.sandboxPort);
  assert.equal((await fetch(`http://127.0.0.1:${port}${descriptor.view.url}`)).status, 401);
  const pinnedName = 'synthetic-html-selection';
  async function readPinned(client) {
    const board = await client.rpc('board.get', { sessionKey: inlineKey, agentId: 'main' });
    const widget = board.widgets.find(candidate => candidate.name === pinnedName);
    assert.equal(widget?.contentKind, 'html');
    assert.equal(widget.contentOwner, 'html');
    assert.equal(widget.grantState, 'none');
    assert.ok(widget.frameUrl && widget.sandboxUrl, 'Gateway returns an authenticated board view');
    const url = new URL(widget.frameUrl, `http://127.0.0.1:${port}`);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    const html = await response.text();
    assertWidgetHtml(html);
    return { instanceId: widget.instanceId, revision: widget.revision, htmlHash: hash(html) };
  }
  let pinned;
  if (!verifyToolDispatch) {
    const result = await inline.rpc('tools.invoke', {
      name: 'show_widget',
      sessionKey: inlineKey,
      args: { ...widgetArgs, pin: true, name: pinnedName },
    });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? result));
    pinned = await readPinned(inline);
    const removedKind = await inline.rpc('tools.invoke', {
      name: 'show_widget',
      sessionKey: inlineKey,
      args: { ...widgetArgs, kind: 'interactive-answer', widget_code: '{}' },
    });
    assert.equal(removedKind.ok, false, 'Native show_widget rejects the retired source kind');
  }
  assert.equal(await readLoadTrace(), '', 'Native widget calls do not load Smart Canvas');
  await assert.rejects(
    inline.rpc('canvas.document.view', { docId: 'cv_missing_fixture' }),
    /unavailable/i,
  );
  const htmlHash = hash(view.html);
  let interactionContract;
  if (verifyInteraction) {
    const beforeInvalidSends = modelRequests.length;
    for (const extra of [{ display_kind: 'hidden' }, { displayKind: 'hidden' }, { silent: true }]) {
      await assert.rejects(
        inline.rpc('chat.send', {
          sessionKey: inlineKey,
          message: 'Must not execute an unsupported hidden send',
          idempotencyKey: randomBytes(8).toString('hex'),
          ...extra,
        }),
        /invalid.*params/i,
      );
    }
    assert.equal(
      modelRequests.length,
      beforeInvalidSends,
      'Rejected fields cannot launch a model turn',
    );
    const create = async html => {
      const result = await inline.rpc('tools.invoke', {
        name: 'show_widget',
        sessionKey: inlineKey,
        args: {
          title: 'Interaction contract',
          kind: 'html',
          name: 'interaction-contract',
          widget_code: html,
        },
      });
      assert.equal(result.ok, true);
      const descriptor = findCanvas(result);
      assert.ok(descriptor);
      return descriptor;
    };
    const first = await create('<p>Original inline document</p>');
    const original = await inline.rpc('canvas.document.view', { docId: first.view.id });
    const second = await create('<p>Replacement requested using the same name</p>');
    assert.notEqual(
      first.view.id,
      second.view.id,
      'Stable names do not update inline document identity',
    );
    assert.equal(
      hash((await inline.rpc('canvas.document.view', { docId: first.view.id })).html),
      hash(original.html),
    );
    const promptDoc = await create(
      '<style>body{margin:0;color:var(--text);font-family:var(--font-body)}main{padding:20px 22px}label{display:grid;gap:8px;font-size:13px}input{box-sizing:border-box;width:100%;padding:10px;color:inherit;background:var(--card);border:1px solid var(--border);border-radius:8px;font:inherit}button{margin-top:16px;padding:9px 16px;border:0;border-radius:8px;background:var(--accent-fill);color:var(--accent-fg);font:inherit}</style><main><form id="form"><label>Budget (CNY)<input id="budget" value="1000"></label><button id="send" type="submit">Continue analysis</button><output id="ack"></output></form></main><script>document.getElementById("form").onsubmit=async(event)=>{event.preventDefault();const result=await openclaw.prompt.send("fixture-interaction: budget="+document.getElementById("budget").value);document.getElementById("ack").textContent=String(result)};</script>',
    );
    const promptView = await inline.rpc('canvas.document.view', { docId: promptDoc.view.id });
    const inputPath = path.join(fixture, 'prompt-view.json');
    await writeFile(inputPath, JSON.stringify({ ...promptView, viewerOrigin }));
    const runBrowserProbe = async (scriptName, inputPath) => {
      const electron = require('electron');
      const browserEnv = { ...process.env };
      delete browserEnv.ELECTRON_RUN_AS_NODE;
      const browser = spawn(
        electron,
        [path.join(root, 'scripts/test/smart-canvas', scriptName), inputPath],
        {
          cwd: root,
          env: browserEnv,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      let errors = '';
      browser.stdout.on('data', chunk => {
        output += chunk;
      });
      browser.stderr.on('data', chunk => {
        errors += chunk;
      });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          browser.kill();
          reject(new Error('Isolated browser probe timed out'));
        }, 90_000);
        browser.once('error', error => {
          clearTimeout(timer);
          reject(error);
        });
        browser.once('exit', code => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(code, 0, `Isolated browser probe failed: ${errors.slice(-2000)}`);
      return output;
    };
    const output = await runBrowserProbe('verify-prompt-bridge.cjs', inputPath);
    const receipt = JSON.parse(
      output.split('\n').find(line => line.startsWith('{"nativePromptBridge"')),
    );
    assert.equal(receipt.prompt, 'fixture-interaction: budget=5000');
    if (verifyPresentation) {
      const outputDirectory = path.join(root, '.agent-tasks/smart-canvas/presentation');
      const presentationPath = path.join(fixture, 'presentation.json');
      await writeFile(
        presentationPath,
        JSON.stringify({
          viewerOrigin,
          gatewayUrl: `ws://127.0.0.1:${port}`,
          outputDirectory,
          descriptor: promptDoc,
          view: promptView,
        }),
      );
      const output = await runBrowserProbe('verify-presentation.cjs', presentationPath);
      const evidence = JSON.parse(
        output.split('\n').find(line => line.startsWith('{"presentation"')),
      );
      assert.equal(evidence.screenshots, 5);
      assert.equal(evidence.htmlFormSubmission, true);
      await writeFile(
        path.join(outputDirectory, 'verification.json'),
        JSON.stringify(evidence, null, 2),
      );
    }

    // Model submission is a separate, explicit host step, not implied by prompt.send(true).
    await runTurn(inline, inlineKey, receipt.prompt, inlineTurn.session);
    assert.ok(modelRequests.some(request => request.interactionSeen));
    const followupHistory = await inline.rpc('chat.history', { sessionKey: inlineKey, limit: 30 });
    assert.ok(JSON.stringify(followupHistory).includes(receipt.prompt));
    assert.equal(hash((await inline.rpc('canvas.document.view', { docId })).html), htmlHash);
    interactionContract = {
      hiddenSendFieldsRejected: true,
      sameNameCreatesNewInlineDocument: true,
      oldDocumentPreserved: true,
      nativePromptBridge: receipt.nativePromptBridge,
      programmaticPromptBlocked: receipt.programmaticPromptBlocked,
      bridgeResolutionIsNotModelReceipt: true,
      explicitFollowupReachedModelAndHistory: true,
      ...(verifyPresentation
        ? { presentationScreenshots: 5, readableHostSuggestion: true, htmlFormSubmission: true }
        : {}),
    };
  }
  const callsBeforeRestart = modelRequests.length;
  const modulesBeforeRestart = await readLoadTrace();
  await stopGateway();
  await startGateway(port, env);
  const restored = await connect(port, ['tool-events', 'inline-widgets']);
  assert.equal(hash((await restored.rpc('canvas.document.view', { docId })).html), htmlHash);
  assert.ok(
    JSON.stringify(
      await restored.rpc('chat.history', { sessionKey: inlineKey, limit: 20 }),
    ).includes(docId),
  );
  if (pinned) assert.deepEqual(await readPinned(restored), pinned);
  assert.equal(
    await readLoadTrace(),
    modulesBeforeRestart,
    'Restart and views leave Smart Canvas cold',
  );
  if (verifyToolDispatch)
    assert.equal(
      assertDispatcherHistory(
        await restored.rpc('chat.history', { sessionKey: inlineKey, limit: 20 }),
        docId,
      ).message.toolCallId,
      toolResult.toolCallId,
      'Restart preserves the actual native outer call identity',
    );
  assert.equal(
    modelRequests.length,
    callsBeforeRestart,
    'History/view restoration does not rerun a model',
  );
  let retention;
  if (verifyRetention) {
    const started = Date.now();
    const retentionKey = 'agent:main:smart-canvas:fixture-retention';
    const documents = [];
    let retentionSession;
    // The native tool owns creation, wrapping, manifests and eviction. Never
    // lower its production cap or write a document/manifest from this fixture.
    for (let index = 0; index < 33; index++) {
      const previousResults = new Set(nativeToolResults.keys());
      const turn = await runTurn(
        restored,
        retentionKey,
        `fixture-retention: Show synthetic widget ${index + 1}.`,
        retentionSession,
      );
      retentionSession ??= turn.session;
      const retentionSessionId = retentionSession.sessionId;
      assert.notEqual(
        retentionSessionId,
        inlineTurn.session.sessionId,
        'Retention checks use a separate native session',
      );
      assert.equal(
        turn.session.sessionId,
        retentionSessionId,
        'All 33 widgets belong to one native session scope',
      );
      const outputs = [...nativeToolResults.values()].filter(
        result => !previousResults.has(result.toolCallId),
      );
      assert.equal(outputs.length, 1, 'Exactly one real native show_widget per synthetic turn');
      const output = outputs[0].output;
      const createdManifest = JSON.parse(
        await readFile(
          path.join(state, 'canvas/documents', output.view.id, 'manifest.json'),
          'utf8',
        ),
      );
      assert.equal(createdManifest.retentionScope, hash(`session:${retentionSessionId}`));
      assert.equal(createdManifest.cspSandbox, 'scripts');
      documents.push(output);
      if (index === 31) {
        await assert.doesNotReject(
          restored.rpc('canvas.document.view', { docId: documents[0].view.id }),
          'The first widget remains readable at the native cap of 32',
        );
        console.log(JSON.stringify({ status: 'retention-cap-reached', nativeDocuments: 32 }));
      }
    }
    await assert.rejects(
      restored.rpc('canvas.document.view', { docId: documents[0].view.id }),
      /unavailable/i,
    );
    for (const output of documents.slice(1)) {
      const retained = await restored.rpc('canvas.document.view', { docId: output.view.id });
      assertWidgetHtml(retained.html);
    }
    assert.equal(
      hash((await restored.rpc('canvas.document.view', { docId })).html),
      htmlHash,
      'Retention is scoped to the native session, not all Gateway documents',
    );
    const retentionHistory = await restored.rpc('chat.history', {
      sessionKey: retentionKey,
      limit: 200,
    });
    assert.ok(
      JSON.stringify(retentionHistory).includes(documents[0].view.id),
      'Native history still describes the evicted widget without recreating it',
    );
    retention = {
      created: 33,
      retained: 32,
      oldestUnavailable: true,
      otherSessionUnaffected: true,
      durationMs: Date.now() - started,
    };
  }
  const modulesBeforeDisable = await readLoadTrace();
  await stopGateway();
  config.plugins.entries['smart-canvas'].enabled = false;
  await writeFile(configPath, JSON.stringify(config));
  await startGateway(port, env);
  const disabled = await connect(port, ['tool-events', 'inline-widgets']);
  const disabledCatalog = await disabled.rpc('plugins.list', {});
  const disabledPlugin = disabledCatalog.plugins.find(plugin => plugin.id === 'smart-canvas');
  assert.equal(disabledPlugin?.enabled, false);
  assert.ok(['disabled', 'unloaded'].includes(disabledPlugin?.runtime?.state));
  assert.equal(await hasSmartCanvasSkill(disabled), false);
  const disabledKey = 'agent:main:smart-canvas:fixture-disabled';
  await runTurn(disabled, disabledKey, 'fixture-disabled: Show the synthetic HTML selection.');
  if (!verifyToolDispatch) {
    assert.equal(modelRequests.at(-1).widgetAvailable, true, 'Native HTML remains available');
    const disabledHistory = await disabled.rpc('chat.history', {
      sessionKey: disabledKey,
      limit: 20,
    });
    const disabledDescriptor = findCanvas(disabledHistory);
    assert.ok(disabledDescriptor, 'Native HTML renders with Smart Canvas disabled');
    const disabledView = await disabled.rpc('canvas.document.view', { docId });
    assert.equal(
      hash(disabledView.html),
      htmlHash,
      'Disabling a plugin does not rewrite stored documents',
    );
    assert.deepEqual(await readPinned(disabled), pinned);
  }
  assert.equal(await readLoadTrace(), modulesBeforeDisable, 'Disabled plugin stays cold');
  console.log(
    JSON.stringify({
      ok: true,
      runtime: runtimePackage.version,
      runtimeIdentity,
      runtimePackageSha256: buildInfo.runtimePackageSha256,
      ...(verifyToolDispatch
        ? {
            nativeDispatcher: true,
            genericHtml: true,
            pluginDisabled: true,
            historyWrapper: true,
            nativePromptBridge: true,
          }
        : { startupDeferred: true, nativeHtmlKeepsPluginCold: true }),
      headlessCapRejected: true,
      nativeToolSchema: true,
      managedManifest: true,
      canonicalWrapper: true,
      authenticatedView: true,
      historyAndRestart: true,
      noDuplicateExecution: true,
      explicitDisable: true,
      ...(!verifyToolDispatch
        ? { disabledDocumentRetained: true, pinnedDocumentRetained: true }
        : {}),
      ...(retention ? { retention } : {}),
      localModelRequests: modelRequests.length,
      ...(interactionContract ? { interactionContract } : {}),
    }),
  );
  if (serve) {
    await stopGateway();
    config.plugins.entries['smart-canvas'].enabled = !verifyToolDispatch;
    await writeFile(configPath, JSON.stringify(config));
    await startGateway(port, env);
    await connect(port, ['tool-events', 'inline-widgets']);
    const metadataPath = path.join(fixture, 'host-metadata.json');
    await writeFile(
      metadataPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        gatewayUrl: `ws://127.0.0.1:${port}`,
        gatewayHttpOrigin: `http://127.0.0.1:${port}`,
        viewerOrigin,
        port,
        stateDir: state,
        workspace,
        sessionKey: inlineKey,
        nativeSessionId: inlineTurn.session.sessionId,
        docId,
        toolResult,
        token,
        livePrompt: 'fixture-live: Show the synthetic HTML selection.',
      }),
      { mode: 0o600 },
    );
    // Host-side code reads this temporary file. Never print or embed its token.
    console.log(JSON.stringify({ fixtureMetadata: metadataPath }));
    await new Promise(resolve => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        if (String(chunk).trim() === 'stop') stop();
      });
      process.stdin.resume();
    });
    process.stdin.pause();
  }
} catch (error) {
  console.error(String(error.message).replaceAll(token, '<fixture-token>'));
  console.error(gatewayLog.replaceAll(token, '<fixture-token>').slice(-8000));
  process.exitCode = 1;
} finally {
  await stopGateway();
  for (const [prefix, name] of [
    ['openclaw-agent-db-lifecycle-', 'closeOpenClawAgentDatabasesAsync'],
    ['openclaw-state-db-cache-', 'closeOpenClawStateDatabaseAsync'],
  ]) {
    const owners = (await readdir(path.join(runtime, 'dist'))).filter(file => {
      if (!file.startsWith(prefix) || !file.endsWith('.mjs')) return false;
      const source = require('node:fs').readFileSync(path.join(runtime, 'dist', file), 'utf8');
      return source.includes(`function ${name}(`) || source.includes(`const ${name} =`);
    });
    assert.equal(owners.length, 1, `One native cleanup owner for ${name}`);
    const module = await import(pathToFileURL(path.join(runtime, 'dist', owners[0])).href);
    const cleanup = Object.values(module).filter(
      value => typeof value === 'function' && value.name === name,
    );
    assert.equal(cleanup.length, 1);
    await cleanup[0]();
  }
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  // Cleanup is confined to the one freshly created absolute fixture directory.
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith('smart-canvas-gateway-'));
  await rm(fixture, { recursive: true, force: true });
}
