import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const {
  precompileOpenClawExtensions,
} = require('../../openclaw/precompile-openclaw-extensions.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const serve = args.includes('--serve');
const verifyRetention = args.includes('--retention');
const verifyAcceptedLimits = args.includes('--extreme');
const verifyToolDispatch = args.includes('--tool-dispatch');
const verifyUi = args.includes('--ui');
assert.ok(
  !verifyToolDispatch || (!verifyRetention && !verifyAcceptedLimits),
  'Use --tool-dispatch separately from scenario-only variants',
);
assert.ok(
  !verifyUi || (!verifyToolDispatch && !verifyRetention && !verifyAcceptedLimits),
  'Use --ui separately from scenario-only variants and --tool-dispatch',
);
const viewerOriginFlag = args.indexOf('--viewer-origin');
const viewerOrigin = viewerOriginFlag >= 0 ? args[viewerOriginFlag + 1] : 'http://127.0.0.1:43390';
const parsedViewerOrigin = new URL(viewerOrigin);
assert.equal(parsedViewerOrigin.protocol, 'http:');
assert.equal(parsedViewerOrigin.hostname, '127.0.0.1');
assert.equal(parsedViewerOrigin.origin, viewerOrigin, 'Use one exact loopback viewer origin');
const runtime = path.resolve(
  (args[0] && !args[0].startsWith('--') ? args[0] : undefined) ??
    path.join(root, 'vendor/openclaw-runtime/current'),
);
const runtimePackage = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
assert.equal(runtimePackage.version, '2026.9.8', 'Use the locked prepared runtime');
const buildInfo = JSON.parse(await readFile(path.join(runtime, 'runtime-build-info.json'), 'utf8'));
const fixture = await mkdtemp(path.join(os.tmpdir(), 'interactive-ui-gateway-'));
const state = path.join(fixture, 'state');
const workspace = path.join(fixture, 'project');
const pluginRoot = path.join(fixture, 'runtime/dist/extensions/interactive-ui');
const configPath = path.join(fixture, 'openclaw.json');
const token = randomBytes(24).toString('hex');
const scenario = {
  version: 1,
  language: 'en',
  summary: 'Synthetic delivery comparison',
  tasks: [{ label: 'Synthetic implementation', hours: 448 }],
  dailyRate: 700,
  budget: 80000,
  deadline: 21,
  people: 6,
  focus: 6,
  ...(verifyAcceptedLimits
    ? {
        summary: 'Accepted-limit synthetic workload and cost',
        tasks: Array.from({ length: 12 }, (_, index) => ({
          label: `Synthetic allocation ${index + 1}`,
          hours: 2000,
        })),
        dailyRate: 5000,
        budget: 1000000,
        deadline: 365,
        people: 12,
        focus: 2,
      }
    : {}),
};
const ui = {
  version: 1,
  language: 'en',
  summary: 'Synthetic controlled delivery comparison',
  note: 'Synthetic fixture data; no external submission or persisted input state.',
  blocks: [
    {
      type: 'table',
      id: 'table',
      title: 'Delivery data',
      columns: [
        { id: 'name', label: 'Name', type: 'text' },
        { id: 'days', label: 'Days', type: 'number' },
      ],
      rows: [
        ['Lean', 39],
        ['Balanced', 18],
        ['Fast', 11],
        ['Small batch', 22],
        ['Extended scope', 28],
        ['Pilot', 7],
        ['Phased delivery', 16],
      ],
    },
    {
      type: 'compare',
      id: 'compare',
      title: 'Plans',
      metrics: ['Days', 'Cost'],
      items: [
        { id: 'lean', title: 'Lean', values: [39, 81900] },
        { id: 'balanced', title: 'Balanced', values: [18, 75600] },
      ],
    },
    {
      type: 'chart',
      id: 'chart',
      title: 'Delivery',
      chartType: 'line',
      labels: ['Day 1', 'Day 2', 'Day 3'],
      unit: 'hours',
      series: [
        { id: 'balanced', label: 'Balanced', values: [25.8, 51.6, 77.4] },
        { id: 'lean', label: 'Lean', values: [11.5, 23, 34.5] },
      ],
    },
    {
      type: 'form',
      id: 'form',
      title: 'Requirements',
      fields: [
        { id: 'topic', label: 'Topic', type: 'text', value: 'Synthetic', required: true },
        { id: 'budget', label: 'Budget', type: 'number', value: 80000, min: 0, max: 1000000 },
        {
          id: 'plan',
          label: 'Plan',
          type: 'select',
          value: 'Balanced',
          options: ['Lean', 'Balanced'],
        },
        { id: 'confirmed', label: 'Confirmed', type: 'checkbox', value: true },
      ],
    },
    {
      type: 'steps',
      id: 'steps',
      title: 'Explanation',
      items: [
        { title: 'Choose inputs', body: 'Use explicit assumptions.' },
        { title: 'Compare', body: 'Check the common source data.' },
      ],
    },
  ],
};
const registeredWidgetKind = verifyUi ? 'interactive-answer' : 'scenario-explorer';
const rendererPath = verifyUi ? '/__interactive_ui__/ui.js' : '/__interactive_ui__/scenario.js';
const widgetArgs = verifyToolDispatch
  ? {
      title: 'Synthetic native HTML',
      kind: 'html',
      widget_code:
        '<main><h2>Synthetic native dispatcher widget</h2><label>Team size <input id="team" type="range" min="2" max="12" value="6"></label><output id="value">6 people</output><button id="follow" type="button">Analyze this selection</button></main><script>document.getElementById("team").addEventListener("input",event=>{document.getElementById("value").textContent=event.target.value+" people"});document.getElementById("follow").addEventListener("click",event=>{if(event.isTrusted)void openclaw.prompt.send("Analyze the synthetic selection: "+document.getElementById("team").value+" people")});</script>',
    }
  : {
      title: verifyUi ? 'Synthetic controlled UI' : 'Synthetic scenario',
      kind: registeredWidgetKind,
      widget_code: JSON.stringify(verifyUi ? ui : scenario),
    };
const modelRequests = [];
const nativeToolResults = new Map();
const nativeDispatchResults = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
let gateway;
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
    const widgetSchema = widget ? JSON.stringify(widget.function.parameters) : '';
    const registeredScenarioKind = widgetSchema.includes('scenario-explorer');
    const registeredUiKind = widgetSchema.includes('interactive-answer');
    const registeredKind = verifyUi ? registeredUiKind : registeredScenarioKind;
    const messages = input.messages ?? [];
    const turnStart = messages.findLastIndex(
      message =>
        message.role === 'user' &&
        /fixture-(headless|inline|disabled|live|retention):/.test(JSON.stringify(message.content)),
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
      registeredKind,
      registeredScenarioKind,
      registeredUiKind,
      widgetAvailable: Boolean(widget),
      dispatcherAvailable: Boolean(dispatcher),
    });
    assert.ok(
      modelRequests.length <= (serve ? 40 : 8) + (verifyRetention ? 66 : 0),
      'No uncontrolled model loop',
    );
    const invoke =
      !headless && (verifyToolDispatch ? Boolean(dispatcher) : registeredKind) && !completed;
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
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  if (!gateway || gateway.exitCode !== null) return;
  const child = gateway;
  await new Promise(resolve => {
    child.once('exit', resolve);
    child.kill();
  });
}

async function startGateway(port, env) {
  gateway = spawn(
    process.execPath,
    [
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
      stdio: ['ignore', 'pipe', 'pipe'],
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
        (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).ok
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
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.add(socket);
  const pending = new Map();
  const events = [];
  let sequence = 0;
  socket.on('message', raw => {
    const packet = JSON.parse(raw.toString());
    if (packet.type === 'event') events.push(packet);
    if (packet.type !== 'res') return;
    const item = pending.get(packet.id);
    if (!item) return;
    pending.delete(packet.id);
    clearTimeout(item.timer);
    packet.ok
      ? item.resolve(packet.payload)
      : item.reject(new Error(`${item.method}: ${packet.error?.message ?? 'rejected'}`));
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = String(++sequence);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 20_000);
      pending.set(id, { method, timer, resolve, reject });
      socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let hello;
  try {
    hello = await rpc('connect', {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: 'cli', version: 'isolated-fixture', platform: process.platform, mode: 'cli' },
      role: 'operator',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      auth: { token },
      caps,
    });
  } catch (error) {
    socket.terminate();
    sockets.delete(socket);
    throw error;
  }
  assert.equal(hello.protocol, 4);
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

async function runTurn(client, key, message) {
  const session = await client.rpc('sessions.create', {
    key,
    cwd: workspace,
    permissionMode: 'workspace',
  });
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
  await cp(path.join(root, 'openclaw-extensions/interactive-ui'), pluginRoot, { recursive: true });
  const print = console.log;
  try {
    console.log = () => {};
    await precompileOpenClawExtensions(path.join(fixture, 'runtime'), { required: true });
  } finally {
    console.log = print;
  }
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
        workspace,
        skipBootstrap: true,
        heartbeat: { every: '0m' },
        model: { primary: 'fixture/fixture' },
      },
    },
    models: {
      mode: 'replace',
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
      allow: ['interactive-ui'],
      entries: { 'interactive-ui': { enabled: !verifyToolDispatch } },
    },
  };
  await writeFile(configPath, JSON.stringify(config));
  const env = {
    ...process.env,
    OPENCLAW_HOME: fixture,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(pluginRoot),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1',
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_SKIP_CHANNELS: '1',
    OPENCLAW_SKIP_CRON: '1',
    VITEST: 'true',
  };
  await startGateway(port, env);
  const headless = await connect(port, ['tool-events']);
  const inline = await connect(port, ['tool-events', 'inline-widgets']);
  const catalog = await inline.rpc('plugins.list', {});
  const initialPlugin = catalog.plugins.find(plugin => plugin.id === 'interactive-ui');
  if (verifyToolDispatch) {
    assert.equal(initialPlugin?.enabled, false);
    assert.ok(['disabled', 'unloaded'].includes(initialPlugin?.runtime?.state));
  } else
    assert.equal(initialPlugin?.runtime?.state, 'active', 'Plugin really loaded in locked Gateway');
  const headlessKey = 'agent:main:interactive-ui:fixture-headless';
  const inlineKey = 'agent:main:interactive-ui:fixture-inline';
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
  const inlineTurn = await runTurn(
    inline,
    inlineKey,
    'fixture-inline: Show the synthetic delivery scenario.',
  );
  assert.ok(
    modelRequests.some(
      request =>
        !request.headless &&
        (verifyToolDispatch ? request.dispatcherAvailable : request.registeredKind),
    ),
    'Inline client receives the requested real native tool surface',
  );
  if (!verifyToolDispatch)
    assert.ok(
      modelRequests.some(request => request.registeredScenarioKind && request.registeredUiKind),
      'Both content kinds coexist in the actual native tool schema',
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
    verifyToolDispatch ? 'Synthetic native dispatcher widget' : rendererPath,
  ])
    assert.ok(view.html.includes(marker), `Canonical document missing ${marker}`);
  assert.ok(!view.html.includes(token));
  assert.ok(view.sandboxUrl && view.sandboxPort);
  assert.equal((await fetch(`http://127.0.0.1:${port}${descriptor.view.url}`)).status, 401);
  if (!verifyToolDispatch) {
    const resource = await fetch(`http://127.0.0.1:${view.sandboxPort}${rendererPath}`);
    assert.equal(
      resource.status,
      200,
      'Registered public renderer served by native sandbox origin',
    );
    assert.match(resource.headers.get('content-type'), /^text\/javascript/);
    const rendererSource = await resource.text();
    assert.ok(rendererSource.length > 0, 'Public renderer has executable source');
    new Script(rendererSource);
    if (!verifyUi) assert.ok(rendererSource.includes('scenario-draft-policy'));
    const otherRendererPath = verifyUi
      ? '/__interactive_ui__/scenario.js'
      : '/__interactive_ui__/ui.js';
    assert.equal(
      (await fetch(`http://127.0.0.1:${view.sandboxPort}${otherRendererPath}`)).status,
      200,
      'Registering the new kind preserves the existing kind resource',
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${view.sandboxPort}/__interactive_ui__/unregistered.js`))
        .status,
      404,
      'Unregistered paths are not public resources',
    );
    if (verifyUi)
      for (const block of ui.blocks)
        assert.ok(view.html.includes(block.title), `Composed document includes ${block.type}`);
  }
  await assert.rejects(
    inline.rpc('canvas.document.view', { docId: 'cv_missing_fixture' }),
    /unavailable/i,
  );
  const htmlHash = hash(view.html);
  const callsBeforeRestart = modelRequests.length;
  await stopGateway();
  await startGateway(port, env);
  const restored = await connect(port, ['tool-events', 'inline-widgets']);
  assert.equal(hash((await restored.rpc('canvas.document.view', { docId })).html), htmlHash);
  assert.ok(
    JSON.stringify(
      await restored.rpc('chat.history', { sessionKey: inlineKey, limit: 20 }),
    ).includes(docId),
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
    const retentionKey = 'agent:main:interactive-ui:fixture-retention';
    const documents = [];
    let retentionSessionId;
    // The native tool owns creation, wrapping, manifests and eviction. Never
    // lower its production cap or write a document/manifest from this fixture.
    for (let index = 0; index < 33; index++) {
      const previousResults = new Set(nativeToolResults.keys());
      const turn = await runTurn(
        restored,
        retentionKey,
        `fixture-retention: Show synthetic scenario ${index + 1}.`,
      );
      retentionSessionId ??= turn.session.sessionId;
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
        await restored.rpc('canvas.document.view', { docId: documents[0].view.id });
        console.log(JSON.stringify({ status: 'retention-cap-reached', nativeDocuments: 32 }));
      }
    }
    await assert.rejects(
      restored.rpc('canvas.document.view', { docId: documents[0].view.id }),
      /unavailable/i,
    );
    for (const output of documents.slice(1)) {
      const retained = await restored.rpc('canvas.document.view', { docId: output.view.id });
      assert.ok(retained.html.includes('/__interactive_ui__/scenario.js'));
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
  await stopGateway();
  config.plugins.entries['interactive-ui'].enabled = false;
  await writeFile(configPath, JSON.stringify(config));
  await startGateway(port, env);
  const disabled = await connect(port, ['tool-events', 'inline-widgets']);
  const disabledCatalog = await disabled.rpc('plugins.list', {});
  const disabledPlugin = disabledCatalog.plugins.find(plugin => plugin.id === 'interactive-ui');
  assert.equal(disabledPlugin?.enabled, false);
  assert.ok(['disabled', 'unloaded'].includes(disabledPlugin?.runtime?.state));
  await runTurn(
    disabled,
    'agent:main:interactive-ui:fixture-disabled',
    'fixture-disabled: Explain the synthetic delivery inputs.',
  );
  assert.equal(
    modelRequests.at(-1).registeredKind,
    false,
    'Explicit disable removes the registered kind',
  );
  assert.equal(modelRequests.at(-1).registeredScenarioKind, false);
  assert.equal(modelRequests.at(-1).registeredUiKind, false);
  if (!verifyToolDispatch) {
    const disabledView = await disabled.rpc('canvas.document.view', { docId });
    assert.equal(
      hash(disabledView.html),
      htmlHash,
      'Disabling a plugin does not rewrite stored documents',
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${disabledView.sandboxPort}${rendererPath}`)).status,
      404,
      'Explicit disable removes the public renderer registration',
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      runtime: runtimePackage.version,
      runtimePackageSha256: buildInfo.runtimePackageSha256,
      ...(verifyToolDispatch
        ? {
            nativeDispatcher: true,
            genericHtml: true,
            pluginDisabled: true,
            historyWrapper: true,
            nativePromptBridge: true,
          }
        : { pluginLoaded: true, publicRenderer: true }),
      headlessCapRejected: true,
      nativeToolSchema: true,
      managedManifest: true,
      canonicalWrapper: true,
      authenticatedView: true,
      historyAndRestart: true,
      noDuplicateExecution: true,
      explicitDisable: true,
      ...(!verifyToolDispatch
        ? { disabledDocumentRetained: true, disabledResourceRejected: true }
        : {}),
      ...(verifyAcceptedLimits ? { acceptedLimits: true } : {}),
      ...(verifyUi
        ? {
            controlledUi: true,
            componentKinds: ui.blocks.map(block => block.type),
            dualKindRegistration: true,
          }
        : {}),
      ...(retention ? { retention } : {}),
      localModelRequests: modelRequests.length,
    }),
  );
  if (serve) {
    await stopGateway();
    config.plugins.entries['interactive-ui'].enabled = !verifyToolDispatch;
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
        livePrompt: 'fixture-live: Show the synthetic delivery scenario.',
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
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  // Cleanup is confined to the one freshly created absolute fixture directory.
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith('interactive-ui-gateway-'));
  await rm(fixture, { recursive: true, force: true });
}
