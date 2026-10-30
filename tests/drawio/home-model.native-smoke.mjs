// Frozen Gateway, plugin RPC and model tools; model output/editor ACK are synthetic.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveNativeSmokeTarget } from '../openclaw/runtime/native-smoke-target.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const { runtimeRoot: runtime, executable, identity } = resolveNativeSmokeTarget();
const output = path.join(root, '.agent-tasks/drawio');
fs.mkdirSync(output, { recursive: true });
const state = fs.mkdtempSync(path.join(output, 'home-model-native-'));
const workspace = path.join(state, 'workspace');
const agentWorkspace = path.join(state, 'agent-home');
const plugin = path.join(state, 'plugin');
for (const directory of [workspace, agentWorkspace, plugin]) fs.mkdirSync(directory);
// Keep native Git preparation inside this fixture instead of discovering the
// repository containing .agent-tasks through the workspace's parent folders.
assert.equal(spawnSync('git', ['init', '--quiet', workspace], { windowsHide: true }).status, 0);
assert.equal(
  spawnSync(
    'git',
    [
      '-C',
      workspace,
      '-c',
      'user.name=Canvas Fixture',
      '-c',
      'user.email=canvas-fixture@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'fixture',
    ],
    { windowsHide: true },
  ).status,
  0,
);
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'plugins/extensions/drawio/index.ts')],
  outfile: path.join(plugin, 'index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['openclaw/*'],
});
fs.copyFileSync(
  path.join(root, 'plugins/extensions/drawio/openclaw.plugin.json'),
  path.join(plugin, 'openclaw.plugin.json'),
);
fs.writeFileSync(
  path.join(plugin, 'package.json'),
  JSON.stringify({
    name: 'drawio',
    version: '1.0.0',
    openclaw: { extensions: ['./index.cjs'] },
  }),
);
fs.symlinkSync(
  path.join(root, 'plugins/extensions/drawio/assets'),
  path.join(plugin, 'assets'),
  process.platform === 'win32' ? 'junction' : 'dir',
);
fs.cpSync(path.join(root, 'plugins/extensions/drawio/skills'), path.join(plugin, 'skills'), {
  recursive: true,
});
const reservePort = async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
const port = await reservePort();
const sandboxPort = await reservePort();
const token = randomBytes(24).toString('hex');
let expected;
const modelErrors = [];
const requestedModels = [];
const model = http.createServer(async (request, response) => {
  try {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    requestedModels.push(input.model);
    const lastUser = input.messages.findLastIndex(
      message =>
        message.role === 'user' && JSON.stringify(message.content).includes(expected.prompt),
    );
    const tools = input.messages.slice(lastUser + 1).filter(message => message.role === 'tool');
    let call;
    if (!tools.length)
      call = {
        id: `read-${expected.runId}`,
        name: 'drawio_diagram',
        arguments: { action: 'read' },
      };
    else if (tools.length === 1) {
      const content =
        typeof tools[0].content === 'string' ? tools[0].content : JSON.stringify(tools[0].content);
      assert.ok(
        content.includes(expected.contentStamp),
        'new model reads the exact freshly prepared content',
      );
      call = {
        id: `update-${expected.runId}`,
        name: 'drawio_diagram',
        arguments: {
          action: 'update',
          diagramId: expected.diagramId,
          baseContentStamp: expected.contentStamp,
          xml: expected.xml,
          title: 'Model-switched diagram',
        },
      };
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      `data: ${JSON.stringify({
        id: 'fixture',
        object: 'chat.completion.chunk',
        model: input.model,
        choices: [
          {
            index: 0,
            delta: call
              ? {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                    },
                  ],
                }
              : { role: 'assistant', content: 'Updated the same canvas.' },
            finish_reason: call ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    modelErrors.push(String(error));
    response.writeHead(500).end('Synthetic model failed');
  }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const configPath = path.join(state, 'openclaw.json');
fs.writeFileSync(
  configPath,
  JSON.stringify({
    logging: { file: path.join(state, 'native.jsonl') },
    gateway: {
      mode: 'local',
      bind: 'loopback',
      port,
      auth: { mode: 'token', token },
      controlUi: { allowedOrigins: [`http://127.0.0.1:${port}`] },
    },
    update: { checkOnStart: false, auto: { enabled: false } },
    agents: {
      ownership: 'explicit',
      entries: { main: {} },
      defaults: {
        workspace: agentWorkspace,
        skipBootstrap: true,
        heartbeat: { every: '0m' },
        model: { primary: 'fixture/alpha' },
        models: {
          'fixture/alpha': { agentRuntime: { id: 'openclaw' } },
          'fixture/beta': { agentRuntime: { id: 'openclaw' } },
        },
        embeddedAgent: { cyberFailover: { mode: 'off' } },
      },
    },
    plugins: {
      allow: ['drawio'],
      load: { paths: [plugin] },
      slots: { memory: 'none' },
      entries: { drawio: { enabled: true } },
    },
    mcp: { apps: { enabled: true, sandboxPort } },
    tools: { toolSearch: false },
    models: {
      mode: 'replace',
      catalogRefresh: { enabled: false },
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture-only',
          agentRuntime: { id: 'openclaw' },
          request: { allowPrivateNetwork: true },
          models: ['alpha', 'beta'].map(id => ({
            id,
            name: id,
            input: ['text'],
            contextWindow: 200000,
            maxTokens: 2000,
          })),
        },
      },
    },
  }),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.toUpperCase().startsWith('OPENCLAW_') &&
      !['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(name.toUpperCase()),
  ),
);
Object.assign(env, {
  OPENCLAW_HOME: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtime, 'dist/extensions'),
  OPENCLAW_NO_RESPAWN: '1',
  OPENCLAW_DISABLE_BONJOUR: '1',
  OPENCLAW_SKIP_CHANNELS: '1',
  NODE_DISABLE_COMPILE_CACHE: '1',
});
for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
Object.assign(process.env, env);
const clientModule = fs.readdirSync(path.join(runtime, 'dist')).flatMap(name => {
  if (!/^client-.*\.mjs$/.test(name)) return [];
  const source = fs.readFileSync(path.join(runtime, 'dist', name), 'utf8');
  const alias = source.slice(source.lastIndexOf('\nexport {')).match(/\bGatewayClient as (\w+)\b/);
  return alias ? [{ name, alias: alias[1] }] : [];
});
assert.equal(clientModule.length, 1);
const GatewayClient = (
  await import(pathToFileURL(path.join(runtime, 'dist', clientModule[0].name)).href)
)[clientModule[0].alias];
const keys = generateKeyPairSync('ed25519');
const deviceIdentity = {
  deviceId: createHash('sha256')
    .update(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))
    .digest('hex'),
  publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
const clients = [];
const events = [];
const failures = [];
let canvas;
let child;
const connectClient = extra =>
  new Promise((resolve, reject) => {
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals'],
      requestTimeoutMs: 30_000,
      onHelloOk: () => resolve(client),
      onConnectError: reject,
      ...extra,
    });
    clients.push(client);
    client.start();
  });
const waitFor = async (read, timeout = 90_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    assert.equal(child.exitCode, null, 'isolated Gateway must stay alive');
    if (failures.length || modelErrors.length)
      throw new Error(JSON.stringify({ failures, modelErrors }));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Probe timed out. Evidence: ${path.join(state, 'gateway.log')}`);
};
const checks = [];
try {
  let log = '';
  child = spawn(
    executable,
    [
      path.join(runtime, 'gateway-bundle.mjs'),
      'gateway',
      'run',
      '--allow-unconfigured',
      '--port',
      String(port),
    ],
    {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const append = value => {
    log += value;
    fs.writeFileSync(path.join(state, 'gateway.log'), log.replaceAll(token, '<fixture-token>'));
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  await waitFor(async () => {
    try {
      return (
        await fetch(`http://127.0.0.1:${port}/readyz`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      return false;
    }
  }, 120_000);
  const browser = await connectClient({
    origin: `http://127.0.0.1:${port}`,
    clientName: 'openclaw-control-ui',
    clientBuildId: JSON.parse(fs.readFileSync(path.join(runtime, 'build-info.json'), 'utf8'))
      .buildId,
    mode: 'webchat',
    deviceIdentity,
    onEvent: event => {
      events.push(event);
      if (
        event.event !== 'plugin.drawio.canvas-changed' ||
        !canvas ||
        event.payload.viewId !== canvas.viewId
      )
        return;
      void (async () => {
        const { operation } = await browser.request('drawio.canvas', { ...canvas, action: 'next' });
        if (!operation) return;
        assert.equal(operation.diagramId, expected.diagramId);
        assert.equal(operation.xml, expected.xml);
        await browser.request('drawio.canvas', {
          ...canvas,
          action: 'ack',
          operationId: operation.operationId,
          result: {
            status: 'applied',
            snapshot: {
              diagramId: operation.diagramId,
              xml: operation.xml,
              title: operation.title,
              contentStamp: `applied-${expected.runId}`,
            },
          },
        });
      })().catch(error => failures.push(String(error)));
    },
  });
  const backend = await connectClient({
    clientName: 'gateway-client',
    mode: 'backend',
    deviceIdentity: null,
  });
  const created = await backend.request('sessions.create', {
    key: `agent:main:home-model-${randomUUID()}`,
    cwd: workspace,
    permissionMode: 'full',
  });
  const scope = { sessionKey: created.key, sessionId: created.sessionId, agentId: 'main' };
  const opened = await browser.request('mcp.app.launch', {
    sessionKey: scope.sessionKey,
    agentId: 'main',
    serverName: 'drawio',
    toolName: 'open_editor',
    entrypointType: 'global',
  });
  const view = await browser.request('mcp.app.view', { ...scope, viewId: opened.viewId });
  const diagramId = view.toolResult.structuredContent.diagramId;
  const source = {
    serverName: 'drawio',
    toolName: 'open_editor',
    uiResourceUri: 'ui://drawio/editor',
    originSessionKey: scope.sessionKey,
  };
  assert.deepEqual(
    await browser.request('drawio.canvas', {
      ...scope,
      viewId: opened.viewId,
      action: 'admit',
      source,
      diagramId,
    }),
    { admitted: true },
  );
  checks.push(
    'live editor provenance is admitted before its first model selection without storing XML',
  );
  const stable = await browser.request('drawio.app.current', {
    ...scope,
    viewId: opened.viewId,
    editorResource: true,
    diagramId,
  });
  assert.equal(typeof stable.editorResource.sandboxUrl, 'string');
  const assetBase = stable.editorResource.html.match(
    /window\.DIAGRAM_ASSET_BASE=("[^"\r\n]+")/,
  )?.[1];
  assert.ok(assetBase, 'service-owned resource has a concrete offline asset origin');
  const assertAssetsAlive = async () =>
    assert.equal(
      (
        await fetch(JSON.parse(assetBase) + 'editor/js/app.min.js', {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        })
      ).status,
      200,
    );
  await assertAssetsAlive();
  const legacyContext = () =>
    browser.request('mcp.app.updateModelContext', {
      ...scope,
      viewId: opened.viewId,
      content: [{ type: 'text', text: 'Legacy canvas context' }],
    });
  await legacyContext();
  // Reproduce the original regression even when explicit selection equals the default.
  await backend.request('sessions.patch', {
    key: scope.sessionKey,
    expectedSessionId: scope.sessionId,
    model: 'fixture/alpha',
  });
  await assert.rejects(legacyContext, /runtime selection changed/);
  checks.push(
    'negative control reproduces revoked native context after the first explicit model selection',
  );
  let xml = fs.readFileSync(path.join(root, 'plugins/extensions/drawio/tests/fixture.xml'), 'utf8');
  for (const selected of ['beta', 'alpha']) {
    await backend.request('sessions.patch', {
      key: scope.sessionKey,
      expectedSessionId: scope.sessionId,
      model: `fixture/${selected}`,
    });
    await assert.rejects(legacyContext, /runtime selection changed/);
    await assertAssetsAlive();
    const runId = randomUUID();
    expected = {
      runId,
      diagramId,
      contentStamp: `manual-${selected}`,
      prompt: `Edit the same admitted canvas with model ${selected}.`,
      xml: xml.replaceAll('提交申请', `已修改-${selected}`),
    };
    if (expected.xml === xml)
      expected.xml = xml.replace(
        '<root>',
        `<root><mxCell id="model-${selected}" value="${selected}" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="30" as="geometry"/></mxCell>`,
      );
    const prepared = await browser.request('drawio.canvas', {
      ...scope,
      viewId: opened.viewId,
      action: 'prepare',
      source,
      snapshot: {
        diagramId,
        xml,
        title: 'Current manual diagram',
        contentStamp: expected.contentStamp,
      },
      ...(canvas ? { retire: true } : {}),
    });
    canvas = { ...scope, viewId: opened.viewId, token: prepared.token };
    const ack = await browser.request('drawio.chat.send', {
      ...scope,
      canvases: [{ viewId: canvas.viewId, token: canvas.token, selected: true }],
      send: { ...scope, message: expected.prompt, idempotencyKey: runId, deliver: false },
    });
    assert.equal(ack.runId, runId);
    const terminal = await waitFor(() =>
      events.find(
        event =>
          event.event === 'agent' &&
          event.payload?.runId === runId &&
          event.payload?.stream === 'lifecycle' &&
          event.payload?.data?.executionSettled === true,
      ),
    );
    assert.equal(terminal.payload.data.phase, 'end');
    const current = await browser.request('drawio.app.current', {
      ...scope,
      viewId: opened.viewId,
    });
    assert.equal(current.diagram.diagramId, diagramId);
    assert.equal(current.diagram.xml, expected.xml);
    const { session } = await backend.request('sessions.describe', {
      key: scope.sessionKey,
      agentId: 'main',
    });
    assert.equal(session.modelProvider, 'fixture');
    assert.equal(session.model, selected, 'requested model remains selected after the canvas turn');
    xml = expected.xml;
    await browser.request('drawio.canvas', { ...canvas, action: 'detach', token: '' });
    await assertAssetsAlive();
    checks.push(
      `model ${selected} reads the fresh snapshot, updates the same canvas, records a real receipt and remains selected`,
    );
    // Terminal publication can precede delayed native usage/cleanup writes. Read
    // until the row is quiet before the next distinct user model mutation.
    let previous;
    let unchangedSince = Date.now();
    await waitFor(async () => {
      const { session } = await backend.request('sessions.describe', {
        key: scope.sessionKey,
        agentId: 'main',
      });
      const revision = JSON.stringify([session.updatedAt, session.modelProvider, session.model]);
      if (revision !== previous) {
        previous = revision;
        unchangedSince = Date.now();
      }
      return Date.now() - unchangedSince >= 1000;
    }, 10_000);
  }
  assert.deepEqual(modelErrors, []);
  assert.ok(requestedModels.includes('alpha') && requestedModels.includes('beta'));
  checks.push(
    'the original service-owned offline asset origin remains readable through both model changes and native turns',
  );
  const evidence = path.join(state, 'result.json');
  fs.writeFileSync(
    evidence,
    JSON.stringify(
      {
        ...identity,
        pluginBundleSha256: createHash('sha256')
          .update(fs.readFileSync(path.join(plugin, 'index.cjs')))
          .digest('hex'),
        passed: true,
        checks,
        requestedModels,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks, evidence }));
} finally {
  for (const client of clients) client.stop();
  if (child?.exitCode === null) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
}
