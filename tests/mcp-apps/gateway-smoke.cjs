'use strict';

// Isolated real Gateway + synthetic stdio MCP server. Makes no model requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const runtime = path.join(root, 'vendor/openclaw-runtime/current');
  const historyRecovery = process.argv.includes('--history-recovery');
  const state = fs.mkdtempSync(path.join(root, '.agent-tasks/mcp-apps/gateway-'));
  const workspace = path.join(state, 'workspace');
  fs.mkdirSync(workspace);
  const receiptsPath = path.join(state, 'receipts.json');
  const drawio = process.argv.includes('--drawio');
  const firstSend = process.argv.includes('--first-send');
  assert.ok(!firstSend || drawio, '--first-send requires --drawio');
  const modelInputs = [];
  const model = firstSend
    ? require('node:http').createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        modelInputs.push(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(
          `data: ${JSON.stringify({
            id: 'first-send-fixture',
            object: 'chat.completion.chunk',
            model: 'fixture',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'Diagram received.' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
          })}\n\ndata: [DONE]\n\n`,
        );
      })
    : undefined;
  if (model) {
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
    model.unref();
  }
  const token = randomBytes(24).toString('hex');
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  const sandboxListener = net.createServer();
  await new Promise(resolve => sandboxListener.listen(0, '127.0.0.1', resolve));
  const sandboxPort = sandboxListener.address().port;
  await new Promise(resolve => listener.close(resolve));
  await new Promise(resolve => sandboxListener.close(resolve));
  const config = {
    logging: { file: path.join(state, 'native.jsonl') },
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    update: { checkOnStart: false, auto: { enabled: false } },
    agents: {
      entries: { main: {} },
      defaults: {
        workspace,
        model: { primary: 'openai/gpt-4o-mini' },
        models: { 'openai/gpt-4o-mini': { agentRuntime: { id: 'openclaw' } } },
        systemAgent: { agentId: 'main' },
      },
    },
    plugins: { enabled: historyRecovery, allow: [] },
    mcp: {
      apps: { enabled: true, sandboxPort },
      servers: drawio
        ? {
            drawio: {
              command: process.execPath,
              args: [path.join(root, 'openclaw-extensions/drawio/assets/server.cjs')],
            },
          }
        : {
            fixture: {
              command: process.execPath,
              args: [path.join(__dirname, 'server-fixture.mjs')],
              env: { MCP_FIXTURE_RECEIPTS: receiptsPath },
              codex: { defaultToolsApprovalMode: 'auto' },
              requestTimeoutMs: 600000,
            },
          },
    },
  };
  const configPath = path.join(state, 'openclaw.json');
  if (firstSend) {
    config.agents.defaults.model = { primary: 'fixture/fixture' };
    config.agents.defaults.models = { 'fixture/fixture': { agentRuntime: { id: 'openclaw' } } };
    config.agents.defaults.skipBootstrap = true;
    config.agents.defaults.heartbeat = { every: '0m' };
    config.models = {
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
    };
  }
  if (historyRecovery) {
    const fixture = path.join(state, 'history-probe');
    fs.mkdirSync(fixture);
    require('esbuild').buildSync({
      entryPoints: [path.join(__dirname, 'history-recovery-probe.ts')],
      outfile: path.join(fixture, 'index.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['openclaw/*'],
    });
    fs.writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({
        name: 'runtime-services',
        version: '1.0.0',
        openclaw: { extensions: ['./index.cjs'] },
      }),
    );
    fs.writeFileSync(
      path.join(fixture, 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'runtime-services',
        name: 'MCP history recovery probe',
        activation: { onStartup: true },
        contracts: { gatewayMethodDispatch: ['authenticated-request'] },
        configSchema: { type: 'object', properties: {} },
      }),
    );
    config.plugins.allow = ['runtime-services'];
    config.plugins.load = { paths: [fixture] };
  }
  fs.writeFileSync(configPath, JSON.stringify(config));
  Object.assign(process.env, {
    OPENCLAW_HOME: state,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: '1',
    NODE_DISABLE_COMPILE_CACHE: '1',
  });
  const entry = process.argv.includes('--source')
    ? path.join(runtime, 'dist/entry.js')
    : process.argv.includes('--bundle')
      ? path.join(runtime, 'gateway-bundle.mjs')
      : path.join(runtime, 'gateway-launcher.cjs');
  const child = spawn(
    process.execPath,
    [entry, 'gateway', 'run', '--allow-unconfigured', '--port', String(port)],
    { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  const recordOutput = chunk => {
    output += chunk;
    fs.writeFileSync(path.join(state, 'gateway.log'), output.replaceAll(token, '<fixture-token>'));
  };
  child.stdout.on('data', recordOutput);
  child.stderr.on('data', recordOutput);
  let client;
  const timeout = setTimeout(() => child.kill(), 900000);
  const until = async (operation, duration = 60000) => {
    const start = Date.now();
    while (Date.now() - start < duration) {
      if (child.exitCode !== null) throw new Error('Isolated Gateway exited: ' + child.exitCode);
      const value = await operation();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Isolated Gateway probe timed out');
  };
  const receipts = () =>
    fs.existsSync(receiptsPath)
      ? JSON.parse(fs.readFileSync(receiptsPath, 'utf8'))
      : { calls: {}, cancellations: 0 };
  const scope = { sessionKey: 'agent:main:mcp-app-smoke', agentId: 'main' };
  const fileEvents = [];
  const runEvents = [];
  let appWorkspaces;
  let appOwner;
  let appScope;
  let appBinding;
  try {
    await until(async () => {
      try {
        return (
          await fetch(`http://127.0.0.1:${port}/readyz`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(800),
          })
        ).ok;
      } catch {
        return false;
      }
    }, 360000);
    console.log('Isolated Gateway health ready');
    const dist = path.join(runtime, 'dist');
    const clientFile = fs
      .readdirSync(dist)
      .find(
        file =>
          /^client-.*\.mjs$/.test(file) &&
          fs.readFileSync(path.join(dist, file), 'utf8').includes('GatewayClient as t'),
      );
    const { t: GatewayClient } = await import(pathToFileURL(path.join(dist, clientFile)).href);
    const hello = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated Gateway hello timed out')), 90000);
      client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: 'gateway-client',
        mode: 'backend',
        deviceIdentity: null,
        caps: ['exec-approvals', 'plugin-approvals'],
        requestTimeoutMs: 180000,
        scopes: [
          'operator.admin',
          'operator.read',
          'operator.write',
          'operator.approvals',
          'operator.questions',
        ],
        onHelloOk: value => {
          clearTimeout(timer);
          resolve(value);
        },
        onEvent: event => {
          if (firstSend) runEvents.push(event);
          if (event.event === 'mcp.app.resourceUpdated') fileEvents.push(event.payload);
        },
        onConnectError: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      client.start();
    });
    console.log('Isolated Gateway hello ready');
    for (const method of ['mcp.app.cancel', 'mcp.app.release'])
      assert.ok(!hello.features.methods.includes(method));
    if (firstSend) {
      const serviceFile = path.join(state, 'workspace-sessions.cjs');
      require('esbuild').buildSync({
        entryPoints: [path.join(root, 'src/main/plugins/mcp/workspaceAppSession.ts')],
        outfile: serviceFile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
      });
      const { WorkspaceAppSessions } = require(serviceFile);
      appOwner = Object.assign(new (require('node:events').EventEmitter)(), {
        isDestroyed: () => false,
      });
      appScope = {
        requestId: require('node:crypto').randomUUID(),
        cwd: workspace,
        agentId: 'main',
      };
      appWorkspaces = new WorkspaceAppSessions({
        getStore: () => ({
          getConfig: () => ({ workingDirectory: workspace, permissionMode: 'auto' }),
          getAgent: () => ({ enabled: true }),
        }),
        request: (method, params) => client.request(method, params),
      });
      appBinding = await appWorkspaces.prepare(appOwner, appScope);
      scope.sessionKey = appBinding.sessionKey;
    } else await client.request('sessions.create', { key: scope.sessionKey, cwd: workspace });
    console.log('Isolated native session prepared');
    const catalog = await client.request('mcp.app.discover', scope);
    console.log('Native MCP App discovery returned');
    if (historyRecovery) {
      const created = await client.request('mcp.app.launch', {
        ...scope,
        serverName: 'fixture',
        toolName: 'show',
        entrypointType: 'global',
      });
      const seedView = await client.request('mcp.app.view', { ...scope, viewId: created.viewId });
      const viewId = 'mcp-app-archived';
      const descriptor = {
        viewId,
        serverName: 'fixture',
        toolName: 'show',
        uiResourceUri: 'ui://fixture/app',
        toolCallId: 'child',
        originSessionKey: scope.sessionKey,
      };
      const seeded = await client.request('historyProbe.seed', {
        sessionKey: scope.sessionKey,
        message: {
          role: 'custom',
          customType: 'openclaw.nested-tool.v1',
          display: true,
          excludeFromContext: true,
          content: '',
          timestamp: Date.now(),
          details: {
            runId: 'probe-run',
            scopeId: 'probe',
            afterEntryId: null,
            startOrder: 0,
            parentToolCallId: 'parent',
            toolCallId: 'child',
            toolName: 'fixture__show',
            input: {},
            isError: false,
            startedAt: Date.now(),
            timestamp: Date.now(),
            result: {
              content: seedView.toolResult.content,
              details: {
                mcpServer: 'fixture',
                mcpTool: 'show',
                structuredContent: seedView.toolResult.structuredContent,
                mcpAppPreview: { mcpApp: descriptor },
              },
            },
          },
        },
      });
      assert.equal(seeded.appended, true);
      await assert.rejects(client.request('mcp.app.view', { ...scope, viewId }), /expired/);
      const { session } = await client.request('sessions.describe', { key: scope.sessionKey });
      const restored = await client.request('runtimeServices.mcpAppHistoryView', {
        ...scope,
        sessionId: session.sessionId,
        viewId,
      });
      assert.match(restored.payload.html, /MCP App fixture/);
      assert.equal(restored.payload.messageSupported, false);
      assert.equal(restored.payload.updateModelContextSupported, false);
      const historical = {
        ...scope,
        sessionId: session.sessionId,
        viewId,
        toolName: 'show',
        arguments: { metric: 'retention' },
      };
      const recorded = await client.request('runtimeServices.mcpAppHistoryTool', historical);
      assert.deepEqual(recorded.content, seedView.toolResult.content);
      assert.deepEqual(recorded.structuredContent, seedView.toolResult.structuredContent);
      for (const changed of [
        { arguments: { metric: 'revenue' } },
        { toolName: 'echo' },
        { sessionId: 'stale' },
        { arguments: { metric: 'retention', extra: true } },
      ])
        await assert.rejects(
          client.request('runtimeServices.mcpAppHistoryTool', { ...historical, ...changed }),
        );
      assert.equal(
        receipts().calls.show,
        1,
        'Recovery must not execute the original business tool again',
      );
      await assert.rejects(
        client.request('mcp.app.callTool', {
          ...scope,
          viewId: restored.viewId,
          toolName: 'show',
          arguments: {},
        }),
      );
      await assert.rejects(
        client.request('runtimeServices.mcpAppHistoryView', { ...scope, sessionId: 'old', viewId }),
      );
      assert.equal(receipts().calls.show, 1);
      fs.writeFileSync(
        path.join(state, 'history-recovery-proof.json'),
        JSON.stringify(
          {
            nativeExpired: true,
            recoveredFromNativeHistory: true,
            originalToolCalls: 1,
            noBusinessReplay: true,
            noRestoredToolGrants: true,
            historicalToolReadWithDefaults: true,
            changedInputsRejected: true,
            staleIdentityRejected: true,
          },
          null,
          2,
        ),
      );
      console.log(
        'Native nested MCP App history recovered without tool replay or renewed tool grants.',
      );
      return;
    }

    if (drawio) {
      const server = catalog.servers.find(item => item.serverName === 'drawio');
      const entry = server?.entrypoints.find(
        item => item.toolName === 'open_editor' && item.entrypoint.type === 'global',
      );
      assert.ok(entry, 'The declared manual drawing entry must be discoverable');
      const launched = await client.request('mcp.app.launch', {
        ...scope,
        serverName: 'drawio',
        toolName: entry.toolName,
        entrypointType: 'global',
      });
      assert.ok(launched.viewId, 'Manual drawing must return an actual native view');
      const view = await client.request('mcp.app.view', { ...scope, viewId: launched.viewId });
      assert.match(view.toolResult.structuredContent.xml, /<mxGraphModel>/);
      assert.match(view.html, /DIAGRAM_ASSET_BASE/);
      const fileEntry = server?.entrypoints.find(
        item => item.toolName === 'open_file' && item.entrypoint.type === 'file',
      );
      assert.deepEqual(fileEntry?.entrypoint.extensions, ['.drawio']);
      const xml = fs.readFileSync(
        path.join(root, 'openclaw-extensions/drawio/tests/fixture.xml'),
        'utf8',
      );
      const filePath = path.join(workspace, '采购 图 #%.drawio');
      fs.writeFileSync(filePath, xml);
      const opened = await client.request('mcp.app.launch', {
        ...scope,
        serverName: 'drawio',
        toolName: fileEntry.toolName,
        entrypointType: 'file',
        filePath,
      });
      const fileTarget = { ...scope, viewId: opened.viewId };
      const fileView = await client.request('mcp.app.view', fileTarget);
      const file = fileView.toolInput.file;
      assert.equal(file.name, path.basename(filePath));
      assert.equal(fileView.fileResourcesSupported, true);
      assert.deepEqual(fileView.toolResult.structuredContent, { file });
      const contents = await client.request('mcp.app.readResource', {
        ...fileTarget,
        uri: file.resourceUri,
        _meta: { 'openai/resource': { representation: 'text' } },
      });
      assert.equal(contents.contents[0].text, xml);
      await assert.rejects(() =>
        client.request('mcp.app.readResource', {
          ...scope,
          viewId: launched.viewId,
          uri: file.resourceUri,
        }),
      );
      const outsideFile = path.join(state, 'outside.drawio');
      fs.writeFileSync(outsideFile, xml);
      await assert.rejects(() =>
        client.request('mcp.app.launch', {
          ...scope,
          serverName: 'drawio',
          toolName: fileEntry.toolName,
          entrypointType: 'file',
          filePath: outsideFile,
        }),
      );
      assert.equal(fs.readFileSync(filePath, 'utf8'), xml, 'Opening a diagram must not modify it');
      const history = await client.request('chat.history', {
        sessionKey: scope.sessionKey,
        limit: 10,
      });
      assert.equal(
        history.messages.length,
        0,
        'Opening the blank editor must not submit a model prompt',
      );
      if (firstSend) {
        const target = { ...scope, viewId: launched.viewId };
        const edited = xml.replace('<root>', '<root><!-- FIRST_SEND_UNSAVED_NODE_42 -->');
        await client.request('mcp.app.updateModelContext', {
          ...target,
          content: [{ type: 'text', text: `Current draw.io diagram:\n${edited}` }],
        });
        const adopted = await appWorkspaces.adopt(
          appOwner,
          appScope,
          id => ({ id }),
          () => true,
        );
        assert.equal(adopted.binding.sessionKey, appBinding.sessionKey);
        assert.ok(appBinding.sessionKey.endsWith(`:${adopted.value.id}`));
        await appWorkspaces.release(appOwner, appScope.requestId);
        appOwner.emit('destroyed');
        const stillLive = await client.request('sessions.describe', { key: scope.sessionKey });
        assert.equal(stillLive.session.sessionId, appBinding.gatewaySessionId);
        const sent = await client.request('chat.send', {
          sessionKey: scope.sessionKey,
          message: 'Summarize my current diagram.',
          idempotencyKey: require('node:crypto').randomUUID(),
        });
        const terminal = await until(
          () =>
            runEvents.find(
              event =>
                event.event === 'agent' &&
                event.payload?.runId === sent.runId &&
                event.payload?.stream === 'lifecycle' &&
                event.payload?.data?.executionSettled === true,
            ),
          90000,
        );
        assert.equal(terminal.payload.data.phase, 'end');
        assert.match(
          JSON.stringify(modelInputs),
          /FIRST_SEND_UNSAVED_NODE_42/,
          'The first model input must include the edited App XML',
        );
        assert.match(JSON.stringify(modelInputs), /MCP App context snapshots/);
        const retained = await client.request('mcp.app.view', target);
        assert.equal(retained.messageSupported, true);
        assert.equal(retained.updateModelContextSupported, true);
        assert.equal(
          (await client.request('sessions.describe', { key: scope.sessionKey })).session.sessionId,
          appBinding.gatewaySessionId,
        );
        fs.writeFileSync(
          path.join(state, 'first-send-proof.json'),
          JSON.stringify(
            {
              firstModelReceivedEditedDiagram: true,
              sameNativeSession: true,
              viewRemainsInteractive: true,
              adoptedSessionSurvivesWindowCleanup: true,
              executionSettled: true,
              modelRequests: modelInputs.length,
            },
            null,
            2,
          ),
        );
        console.log('First-send native App context adoption and model input passed.');
      }
      fs.writeFileSync(
        path.join(state, 'drawio-manual-proof.json'),
        JSON.stringify(
          {
            manualEntry: entry.toolName,
            fileEntry: fileEntry.toolName,
            fileContentsRead: true,
            foreignViewRejected: true,
            outsideWorkspaceRejected: true,
            nativeView: true,
            emptyConversation: true,
          },
          null,
          2,
        ),
      );
      console.log(
        firstSend
          ? 'Manual draw.io and first-send context checks passed with a local synthetic model.'
          : 'Manual draw.io discovery, file launch and native resource reads passed without a model request.',
      );
      return;
    }
    assert.ok(
      catalog.servers.some(
        server =>
          server.serverName === 'fixture' &&
          server.entrypoints.some(entry => entry.entrypoint.type === 'global'),
      ),
    );
    const launch = () =>
      client.request('mcp.app.launch', {
        ...scope,
        serverName: 'fixture',
        toolName: 'show',
        entrypointType: 'global',
      });
    const created = await launch();
    const target = { ...scope, viewId: created.viewId };
    const view = await client.request('mcp.app.view', target);
    assert.equal(view.appIdentity, undefined);
    assert.equal(view.hostLeaseId, undefined);
    assert.equal(typeof view.html, 'string');
    await assert.rejects(
      client.request('mcp.app.view', { ...target, sessionKey: 'agent:main:foreign' }),
    );
    assert.equal(receipts().calls.show, 1);
    const tools = await client.request('mcp.app.listTools', target);
    assert.ok(tools.tools.some(tool => tool.name === 'echo'));
    const resource = await client.request('mcp.app.readResource', {
      ...target,
      uri: 'fixture://data',
    });
    assert.equal(resource.contents[0].text, 'Fixture resource');
    const approved = async (operation, decision = 'allow-once') => {
      const pending = operation();
      const rejection = pending.catch(error => ({ error }));
      const approval = await until(async () =>
        (await client.request('plugin.approval.list')).find(
          item => item.request.pluginId === 'bundle-mcp',
        ),
      );
      await client.request('plugin.approval.resolve', { id: approval.id, decision });
      return rejection;
    };
    const echo = await approved(
      () =>
        client.request('mcp.app.callTool', {
          ...target,
          toolName: 'echo',
          arguments: { value: 'first' },
        }),
      'allow-always',
    );
    assert.equal(echo.content[0].text, 'echo:first');
    assert.equal(
      (
        await client.request('mcp.app.callTool', {
          ...target,
          toolName: 'echo',
          arguments: { value: 'second' },
        })
      ).content[0].text,
      'echo:second',
    );
    assert.equal(receipts().calls.echo, 2);
    await client.request('mcp.app.updateModelContext', {
      ...target,
      content: [{ type: 'text', text: 'selected fixture' }],
    });
    const context = await client.request('mcp.app.modelContext', target);
    assert.ok(context.state.updateId);
    await client.request('mcp.app.removeModelContext', {
      ...target,
      updateId: context.state.updateId,
    });
    const local = new AbortController();
    const slow = client.request(
      'mcp.app.callTool',
      { ...target, toolName: 'slow', arguments: {} },
      {
        timeoutMs: 90000,
        signal: local.signal,
      },
    );
    const cancelled = assert.rejects(slow);
    await until(() => receipts().calls.slow === 1);
    local.abort();
    await cancelled;
    // Local cancellation cannot stop the native WS operation. Verify completion
    // exactly once and no fabricated MCP cancellation notification.
    await until(() => receipts().slowCompleted === 1);
    assert.equal(receipts().cancellations, 0);
    const asking = client.request('mcp.app.callTool', {
      ...target,
      toolName: 'ask',
      arguments: {},
    });
    const question = await until(async () =>
      (await client.request('question.list', {})).questions.find(
        item => item.sessionKey === scope.sessionKey,
      ),
    );
    await client.request('question.resolve', {
      id: question.id,
      answers: { answers: { [question.questions[0].questionId]: ['fixture answer'] } },
    });
    assert.ok((await asking).content[0].text.includes('fixture answer'));
    const settings = await client.request('mcp.app.settings', {
      ...scope,
      serverName: 'fixture',
      action: 'read',
    });
    assert.equal(settings.values.enabled, true);
    await approved(() =>
      client.request('mcp.app.settings', {
        ...scope,
        serverName: 'fixture',
        action: 'update',
        arguments: { set: { enabled: false } },
      }),
    );
    assert.equal(
      (
        await client.request('mcp.app.settings', {
          ...scope,
          serverName: 'fixture',
          action: 'read',
        })
      ).values.enabled,
      false,
    );
    assert.equal(
      (
        await client.request('mcp.app.mention', {
          ...scope,
          serverName: 'fixture',
          query: 'fixture',
        })
      ).resources[0].uri,
      'fixture://data',
    );
    console.log(
      'Native tools, approval, native local-cancel semantics, question, settings and mentions passed',
    );
    const filePath = path.join(workspace, 'fixture.txt');
    fs.writeFileSync(filePath, 'original');
    const fileApp = await client.request('mcp.app.launch', {
      ...scope,
      serverName: 'fixture',
      toolName: 'show',
      entrypointType: 'file',
      filePath,
    });
    const fileTarget = { ...scope, viewId: fileApp.viewId };
    const fileView = await client.request('mcp.app.view', fileTarget);
    assert.equal(fileView.fileResourcesSupported, true);
    const uri = fileView.toolInput.file.resourceUri;
    const readFile = () =>
      client.request('mcp.app.readResource', {
        ...fileTarget,
        uri,
        _meta: { 'openai/resource': { representation: 'text' } },
      });
    const original = (await readFile()).contents[0];
    assert.equal(original.text, 'original');
    const originalEtag = original._meta['openai/resource'].etag;
    await client.request('mcp.app.subscribeResource', { ...fileTarget, uri });
    const write = await client.request('mcp.app.writeResource', {
      ...fileTarget,
      uri,
      text: 'from app',
      ifMatch: originalEtag,
    });
    assert.equal(write.outcome, 'saved');
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'from app');
    await until(() =>
      fileEvents.some(event => event.viewId === fileTarget.viewId && event.uri === uri),
    );
    fs.writeFileSync(filePath, 'external edit');
    const conflict = await client.request('mcp.app.writeResource', {
      ...fileTarget,
      uri,
      text: 'stale app edit',
      ifMatch: write.etag,
    });
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'external edit');
    assert.equal((await readFile()).contents[0].text, 'external edit');
    assert.equal(
      path.resolve(
        workspace,
        (await client.request('mcp.app.openFile', { ...fileTarget, path: filePath })).path,
      ),
      filePath,
    );
    await assert.rejects(
      client.request('mcp.app.openFile', {
        ...fileTarget,
        path: path.join(state, 'openclaw.json'),
      }),
    );
    await client.request('mcp.app.unsubscribeResource', { ...fileTarget, uri });
    const next = await launch();
    const nextTarget = { ...scope, viewId: next.viewId };
    await client.request('mcp.app.view', nextTarget);
    const denied = await approved(
      () =>
        client.request('mcp.app.callTool', {
          ...nextTarget,
          toolName: 'echo',
          arguments: { value: 'denied' },
        }),
      'deny',
    );
    assert.ok(denied.error);
    assert.equal(receipts().calls.echo, 2);
    fs.writeFileSync(
      path.join(state, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          discovery: true,
          launch: true,
          approvalScope: true,
          localCancellationWithNativeCompletion: true,
          nativeQuestion: true,
          settings: true,
          mention: true,
          context: true,
          fileWrite: true,
          fileConflict: true,
          fileSubscription: true,
          fileBoundary: true,
          nativeLifecycleWithoutPatch: true,
          sessionBoundary: true,
        },
        null,
        2,
      ),
    );
    console.log('MCP Apps real Gateway smoke passed. Artifacts: ' + state);
  } finally {
    model?.close();
    clearTimeout(timeout);
    if (client) await client.stopAndWait().catch(() => client.stop());
    child.kill();
    fs.writeFileSync(path.join(state, 'gateway.log'), output.replaceAll(token, '<fixture-token>'));
    console.log('Isolated probe log: ' + path.join(state, 'gateway.log'));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
