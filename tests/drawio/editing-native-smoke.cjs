'use strict';

// Real locked Gateway, plugin SDK and native model/tool history. The model and
// editor ACK are synthetic; offline-smoke --editing covers the real iframe.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const runtime = fs.realpathSync(
    process.env.DIAGRAM_RUNTIME_DIR || path.join(root, 'vendor/openclaw-runtime/current'),
  );
  assert.equal(require(path.join(runtime, 'package.json')).version.replace(/^v/, ''), '2026.10.4');
  const output = path.join(root, '.agent-tasks/drawio');
  fs.mkdirSync(output, { recursive: true });
  const state = fs.mkdtempSync(path.join(output, 'editing-native-'));
  const workspace = path.join(state, 'workspace');
  fs.mkdirSync(workspace);
  const plugin = path.join(state, 'plugin');
  fs.mkdirSync(plugin);
  buildSync({
    entryPoints: [path.join(root, 'openclaw-extensions/drawio/index.ts')],
    outfile: path.join(plugin, 'index.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['openclaw/*'],
  });
  const manifest = require('../../openclaw-extensions/drawio/openclaw.plugin.json');
  fs.writeFileSync(path.join(plugin, 'openclaw.plugin.json'), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(plugin, 'package.json'),
    JSON.stringify({ name: 'drawio', version: '1.0.0', openclaw: { extensions: ['./index.cjs'] } }),
  );
  fs.symlinkSync(
    path.join(root, 'openclaw-extensions/drawio/assets'),
    path.join(plugin, 'assets'),
    'junction',
  );
  const reservePort = async () => {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
  };
  const port = await reservePort(),
    sandboxPort = await reservePort();
  const token = randomBytes(24).toString('hex');
  let modelCalls = 0;
  let expected;
  const modelErrors = [];
  const model = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      modelCalls++;
      fs.writeFileSync(
        path.join(state, 'model-tools.json'),
        JSON.stringify(input.tools?.map(tool => tool.function?.name)),
      );
      const lastUser = input.messages.findLastIndex(message => message.role === 'user');
      const tools = input.messages.slice(lastUser + 1).filter(message => message.role === 'tool');
      let call;
      if (expected.creating && tools.length === 0) {
        const nativeTool = input.tools.find(tool => tool.function?.name.includes('create_diagram'));
        assert.ok(nativeTool, 'Actual MCP creator is in the synthetic provider catalog');
        call = {
          id: 'create-' + expected.runId,
          name: nativeTool.function.name,
          arguments: { xml: expected.xml, title: 'Chat-created diagram' },
        };
      } else if (expected.creating) {
        /* Finish the actual native creation turn. */
      } else if (tools.length === 0)
        call = {
          id: 'read-' + expected.runId,
          name: 'drawio_diagram',
          arguments: { action: 'read' },
        };
      else if (tools.length === 1) {
        const raw = tools[0].content;
        const text = typeof raw === 'string' ? raw : raw.map(part => part.text || '').join('');
        assert.match(text, new RegExp(expected.diagramId));
        // Native formatting may wrap text blocks; the stable stamp is supplied
        // by the prepared synthetic editor, never inferred from a prompt marker.
        assert.match(text, /prepared-stamp/);
        call = {
          id: 'update-' + expected.runId,
          name: 'drawio_diagram',
          arguments: {
            action: 'update',
            diagramId: expected.diagramId,
            baseContentStamp: 'prepared-stamp',
            xml: expected.xml,
            title: 'Confirmed update',
          },
        };
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = call
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
        : { role: 'assistant', content: 'Updated.' };
      response.end(
        `data: ${JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          model: 'fixture',
          choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })}\n\ndata: [DONE]\n\n`,
      );
    } catch (error) {
      modelErrors.push(String(error));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({
          id: 'fixture-error',
          object: 'chat.completion.chunk',
          model: 'fixture',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Fixture failed.' },
              finish_reason: 'stop',
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
      );
    }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const config = {
    logging: { file: path.join(state, 'native.jsonl') },
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    update: { checkOnStart: false, auto: { enabled: false } },
    agents: {
      entries: { main: {} },
      defaults: {
        workspace,
        skipBootstrap: true,
        heartbeat: { every: '0m' },
        model: { primary: 'fixture/fixture' },
        models: { 'fixture/fixture': { agentRuntime: { id: 'openclaw' } } },
        systemAgent: { agentId: 'main' },
      },
    },
    plugins: {
      enabled: true,
      allow: ['drawio'],
      load: { paths: [plugin] },
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
          models: [
            {
              id: 'fixture',
              name: 'Fixture',
              input: ['text'],
              contextWindow: 200000,
              maxTokens: 2000,
            },
          ],
        },
      },
    },
  };
  const configPath = path.join(state, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const env = {
    ...process.env,
    OPENCLAW_HOME: state,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: '1',
    NODE_DISABLE_COMPILE_CACHE: '1',
  };
  const clientFile = fs
    .readdirSync(path.join(runtime, 'dist'))
    .find(
      file =>
        /^client-.*\.mjs$/.test(file) &&
        fs.readFileSync(path.join(runtime, 'dist', file), 'utf8').includes('GatewayClient as t'),
    );
  const { t: GatewayClient } = await import(
    pathToFileURL(path.join(runtime, 'dist', clientFile)).href
  );
  let child, client;
  const events = [],
    failures = [],
    restored = [];
  let canvas;
  const until = async (operation, timeout = 90_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await operation();
      if (value) return value;
      if (child?.exitCode !== null) throw new Error('Gateway exited');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Probe timed out: ' + JSON.stringify({ failures, modelErrors, modelCalls }));
  };
  async function connect() {
    let log = '';
    child = spawn(
      process.execPath,
      [
        path.join(runtime, 'openclaw.mjs'),
        'gateway',
        'run',
        '--allow-unconfigured',
        '--port',
        String(port),
      ],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const append = chunk => {
      log += chunk;
      fs.writeFileSync(path.join(state, 'gateway.log'), log.replaceAll(token, '<fixture-token>'));
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    await until(async () => {
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
    }, 360_000);
    await new Promise((resolve, reject) => {
      client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: 'gateway-client',
        mode: 'backend',
        deviceIdentity: null,
        caps: ['exec-approvals', 'plugin-approvals'],
        requestTimeoutMs: 120_000,
        scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals'],
        onHelloOk: resolve,
        onConnectError: reject,
        onEvent: event => {
          events.push(event);
          if (
            event.event === 'plugin.drawio.canvas-changed' &&
            canvas &&
            event.payload.viewId === canvas.viewId
          ) {
            void (async () => {
              const result = await client.request('drawio.canvas', { ...canvas, action: 'next' });
              if (!result.operation) return;
              const operation = result.operation;
              assert.equal(operation.diagramId, expected.diagramId);
              await client.request('drawio.canvas', {
                ...canvas,
                action: 'ack',
                operationId: operation.operationId,
                result: {
                  status: 'applied',
                  snapshot: {
                    diagramId: expected.diagramId,
                    xml: operation.xml,
                    title: operation.title,
                    contentStamp: 'applied-stamp',
                  },
                },
              });
            })().catch(error => failures.push(String(error)));
          }
        },
      });
      client.start();
    });
  }
  async function stop() {
    client?.stop();
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    child = undefined;
    client = undefined;
  }
  try {
    await connect();
    console.log('Locked Gateway and edited plugin ready');
    const xml = fs.readFileSync(
      path.join(root, 'openclaw-extensions/drawio/tests/fixture.xml'),
      'utf8',
    );
    for (const entry of ['open_editor', 'open_file', 'create_diagram']) {
      const sessionKey = `agent:main:editing-${entry}`;
      await client.request('sessions.create', { key: sessionKey, cwd: workspace });
      const { session } = await client.request('sessions.describe', { key: sessionKey });
      const scope = { sessionKey, sessionId: session.sessionId, agentId: 'main' };
      const filePath = path.join(workspace, 'input.drawio');
      fs.writeFileSync(filePath, xml);
      let launch;
      if (entry === 'create_diagram') {
        const createRunId = randomUUID();
        expected = { creating: true, runId: createRunId, xml };
        await client.request('chat.send', {
          ...scope,
          message: 'Create a diagram.',
          idempotencyKey: createRunId,
          deliver: false,
        });
        const created = await until(() =>
          events.find(
            event =>
              event.event === 'agent' &&
              event.payload?.runId === createRunId &&
              event.payload?.stream === 'lifecycle' &&
              event.payload?.data?.executionSettled === true,
          ),
        );
        assert.equal(created.payload.data.phase, 'end');
        const history = await client.request('chat.history', { sessionKey, limit: 100 });
        const original = history.messages.find(
          message => message.details?.mcpAppPreview?.mcpApp?.serverName === 'drawio',
        );
        assert.ok(original, 'Actual model-created MCP preview is in native history');
        launch = { viewId: original.details.mcpAppPreview.mcpApp.viewId };
      } else
        launch = await client.request('mcp.app.launch', {
          sessionKey,
          agentId: 'main',
          serverName: 'drawio',
          toolName: entry,
          ...(entry === 'open_file'
            ? { entrypointType: 'file', filePath }
            : { entrypointType: 'global' }),
        });
      const viewId = launch.viewId;
      const view = await client.request('mcp.app.view', { sessionKey, agentId: 'main', viewId });
      const diagramId = view.toolResult.structuredContent.diagramId;
      const prepared = await client.request('drawio.canvas', {
        ...scope,
        viewId,
        action: 'prepare',
        source: {
          serverName: 'drawio',
          toolName: entry,
          uiResourceUri: 'ui://drawio/editor',
          originSessionKey: sessionKey,
        },
        snapshot: { diagramId, xml, title: 'Prepared', contentStamp: 'prepared-stamp' },
      });
      canvas = { ...scope, viewId, token: prepared.token };
      const runId = randomUUID();
      expected = { runId, diagramId, xml: xml.replaceAll('提交申请', '已确认修改') };
      const ack = await client.request('drawio.chat.send', {
        ...scope,
        canvases: [{ token: prepared.token, viewId, selected: true }],
        send: {
          ...scope,
          message: 'Edit the currently prepared diagram.',
          deliver: false,
          justdoUserInitiated: true,
          idempotencyKey: runId,
        },
      });
      assert.equal(ack.runId, runId);
      const terminal = await until(() =>
        events.find(
          event =>
            event.event === 'agent' &&
            event.payload?.runId === runId &&
            event.payload?.stream === 'lifecycle' &&
            event.payload?.data?.executionSettled === true,
        ),
      );
      assert.equal(terminal.payload.data.phase, 'end');
      assert.deepEqual(failures, []);
      assert.deepEqual(modelErrors, []);
      const history = await client.request('chat.history', { sessionKey, limit: 100 });
      fs.writeFileSync(
        path.join(state, 'synthetic-history.json'),
        JSON.stringify(history, null, 2),
      );
      const current = await client.request('drawio.app.current', { ...scope, viewId });
      assert.ok(current.diagram, 'Confirmed update missing; inspect the synthetic native history');
      assert.equal(current.diagram.xml, expected.xml);
      assert.equal(current.diagram.diagramId, diagramId);
      await assert.rejects(
        client.request('drawio.chat.send', {
          ...scope,
          canvases: [{ token: prepared.token, viewId, selected: true }],
          send: { ...scope, message: 'No replay', idempotencyKey: runId },
        }),
      );
      restored.push({ ...scope, viewId, diagramId, xml: expected.xml, entry });
      console.log(`Native ${entry} -> exact run -> applied tool result persisted`);
      canvas = undefined;
    }
    await stop();
    await connect();
    for (const item of restored) {
      const result = await client.request('drawio.app.restore', item);
      assert.equal(result.payload.toolResult.structuredContent.xml, item.xml);
      assert.equal(result.payload.toolResult.structuredContent.diagramId, item.diagramId);
      assert.equal(result.payload.messageSupported, false);
      assert.equal(result.payload.updateModelContextSupported, false);
      await assert.rejects(
        client.request('mcp.app.callTool', {
          sessionKey: item.sessionKey,
          agentId: item.agentId,
          viewId: result.viewId,
          toolName: 'create_diagram',
          arguments: { xml: item.xml },
        }),
      );
      console.log(`Restart recovery of ${item.entry} confirmed; old native grants remain revoked`);
    }
    fs.writeFileSync(
      path.join(state, 'result.json'),
      JSON.stringify(
        { passed: true, modelCalls, entries: restored.map(item => item.entry) },
        null,
        2,
      ),
    );
    console.log('Native diagram editing smoke passed: ' + state);
  } finally {
    await stop();
    model.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
