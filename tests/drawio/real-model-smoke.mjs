// Opt-in real provider test. Never invoked by npm test; uses only a new synthetic session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
fs.mkdirSync(path.join(root, '.agent-tasks/drawio'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, '.agent-tasks/drawio/real-model-'));
const state = path.join(output, 'state');
// Keep repository guidance and private project files out of model bootstrap.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-model-workspace-'));
fs.mkdirSync(state, { recursive: true });
const packageMetadata = require('../../package.json');
const appData =
  process.env.DIAGRAM_APP_DATA || path.join(process.env.APPDATA, packageMetadata.productName);
const sourcePath =
  process.env.DIAGRAM_MODEL_CONFIG || path.join(appData, 'openclaw/state/openclaw.json');
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const modelRef = process.env.DIAGRAM_MODEL || source.agents?.defaults?.model?.primary;
assert.equal(typeof modelRef, 'string', 'Select an explicitly configured model');
const slash = modelRef.indexOf('/');
const providerId = modelRef.slice(0, slash);
const modelId = modelRef.slice(slash + 1);
const provider = source.models?.providers?.[providerId];
const model = provider?.models?.find(item => item.id === modelId);
assert.ok(
  slash > 0 && model && provider.apiKey?.source === 'file',
  'Use an existing file SecretRef; never print/copy its credential',
);
const secretProvider = source.secrets?.providers?.[provider.apiKey.provider];
assert.ok(secretProvider?.source === 'file' && path.isAbsolute(secretProvider.path));
const runtimeSource = fs.realpathSync(
  process.env.DIAGRAM_RUNTIME_DIR || path.join(root, 'vendor/openclaw-runtime/current'),
);
// An explicitly supplied frozen artifact can be reused without another large
// snapshot. Default publication pointers are always snapshotted before launch.
const runtime = process.env.DIAGRAM_RUNTIME_DIR ? runtimeSource : path.join(output, 'runtime');
let sessionKey;
const prompt =
  process.env.DIAGRAM_TEST_PROMPT ||
  '帮我画一张请假审批流程图：员工提交申请，部门主管审批，不通过就退回修改，通过后人事登记，最后完成。';
const token = randomBytes(24).toString('hex');
const capability = randomBytes(24).toString('hex');
const pending = new Map();
const events = [];
const streams = new Set();
const downloads = [];
let gateway,
  socket,
  host,
  payload,
  previewUrl,
  counter = 0,
  closing = false;
let gatewayLog = '';
const catalogSizes = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rpc = (method, params = {}, id = `server-${++counter}`) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 25000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
async function close() {
  if (closing) return;
  closing = true;
  for (const stream of streams) stream.end();
  host?.close();
  socket?.terminate();
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error('Test closed'));
  }
  pending.clear();
  if (gateway && gateway.exitCode === null && gateway.signalCode === null)
    await new Promise(resolve => {
      gateway.once('exit', resolve);
      gateway.kill();
    });
  if (path.dirname(workspace) !== path.resolve(os.tmpdir()))
    throw new Error('Invalid test workspace');
  fs.rmSync(workspace, { recursive: true, force: true });
}
async function adjacentPort() {
  for (;;) {
    const servers = [http.createServer(), http.createServer(), http.createServer()];
    try {
      await new Promise((resolve, reject) => {
        servers[0].once('error', reject);
        servers[0].listen(0, '127.0.0.1', resolve);
      });
      const port = servers[0].address().port;
      for (let i = 1; i < 3; i++)
        await new Promise((resolve, reject) => {
          servers[i].once('error', reject);
          servers[i].listen(port + i, '127.0.0.1', resolve);
        });
      return port;
    } catch {
      /* Try a fresh adjacent range. */
    } finally {
      for (const server of servers) if (server.listening) server.close();
    }
  }
}
try {
  require('../../plugins/extensions/drawio/scripts/prepare.cjs').verifyDrawioAssets();
  const assetProof = JSON.parse(
    fs.readFileSync(path.join(root, 'plugins/extensions/drawio/assets/integrity.json'), 'utf8'),
  );
  // Published runtime files are immutable. A separate hardlinked tree isolates
  // this live test from later atomic runtime replacements; no file is patched.
  const links = [];
  const snapshot = (from, to) => {
    const info = fs.lstatSync(from);
    if (info.isSymbolicLink()) {
      const target = fs.realpathSync(from);
      const relative = path.relative(runtimeSource, target);
      assert.ok(
        !relative.startsWith('..') && !path.isAbsolute(relative),
        'Runtime link stays within its frozen artifact',
      );
      links.push({
        to,
        target: path.join(runtime, relative),
        directory: fs.statSync(from).isDirectory(),
      });
    } else if (info.isDirectory()) {
      fs.mkdirSync(to);
      for (const name of fs.readdirSync(from)) snapshot(path.join(from, name), path.join(to, name));
    } else fs.linkSync(from, to);
  };
  if (runtime !== runtimeSource) snapshot(runtimeSource, runtime);
  for (const link of links)
    fs.symlinkSync(link.target, link.to, link.directory ? 'junction' : 'file');
  require('../../scripts/openclaw/verify-openclaw-runtime-patches.cjs').verifyFrozenOpenClawRuntime(
    runtime,
    { expectedVersion: 'v2026.10.4', requireBundle: true },
  );
  // Retain the complete frozen plugin set. Only this plugin is replaced with
  // current sources; never replace the bundled directory with a draw.io-only set.
  const plugins = path.join(output, 'plugins');
  fs.mkdirSync(plugins);
  const cloneTree = (from, to) => {
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      fs.symlinkSync(
        fs.realpathSync(from),
        to,
        fs.statSync(from).isDirectory() ? 'junction' : 'file',
      );
    } else if (stat.isDirectory()) {
      fs.mkdirSync(to);
      for (const name of fs.readdirSync(from))
        cloneTree(path.join(from, name), path.join(to, name));
    } else fs.linkSync(from, to);
  };
  fs.symlinkSync(path.join(runtime, 'node_modules'), path.join(output, 'node_modules'), 'junction');
  for (const name of fs.readdirSync(path.join(runtime, 'dist/extensions'))) {
    if (name === 'drawio') continue;
    const target = path.join(runtime, 'dist/extensions', name);
    cloneTree(target, path.join(plugins, name));
  }
  const diagramPlugin = path.join(plugins, 'drawio');
  fs.cpSync(path.join(root, 'plugins/extensions/drawio'), diagramPlugin, {
    recursive: true,
    filter: file => !['assets', 'node_modules', 'tests'].includes(path.basename(file)),
  });
  cloneTree(
    path.join(root, 'plugins/extensions/drawio/assets'),
    path.join(diagramPlugin, 'assets'),
  );
  const availablePlugins = new Set(
    fs.readdirSync(plugins).flatMap(name => {
      const manifest = path.join(plugins, name, 'openclaw.plugin.json');
      return fs.existsSync(manifest) ? [JSON.parse(fs.readFileSync(manifest, 'utf8')).id] : [];
    }),
  );
  await build({
    stdin: {
      contents: `export * from './src/renderer/libs/openclaw-chat/pipeline/native-mcp-app'; export * from './src/shared/plugins/mcpAppDownload'; export * from './src/shared/plugins/mcpApps'; export * from './src/shared/cowork/sessionKey'; export * from './src/shared/network/proxy'; export * from './src/main/core/network/gatewayNetworkEnvironment'; export * from './src/main/core/network/trustedCertificates';`,
      resolveDir: root,
    },
    outfile: path.join(output, 'contracts.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@shared': path.join(root, 'src/shared') },
  });
  const contracts = await import(pathToFileURL(path.join(output, 'contracts.mjs')).href);
  sessionKey = contracts.buildCoworkSessionKey(randomUUID());
  // Reuse configured transport without copying credentials or changing app settings.
  const db = new DatabaseSync(path.join(appData, 'justdo.sqlite'), { readOnly: true });
  let networkSettings;
  try {
    networkSettings = JSON.parse(
      db.prepare('SELECT value FROM kv WHERE key = ?').get('app_config').value,
    );
  } finally {
    db.close();
  }
  const proxyMode =
    networkSettings.useSystemProxy === true ? 'system' : networkSettings.proxy?.mode || 'direct';
  assert.notEqual(
    proxyMode,
    'system',
    'System proxy requires the app host resolver; select an explicit transport for this CLI test',
  );
  const proxyUrl =
    proxyMode === 'custom'
      ? contracts.buildCustomProxyUrl(
          contracts.normalizeProxySettings(networkSettings.proxy).custom,
        )
      : null;
  assert.ok(proxyMode !== 'custom' || proxyUrl, 'Configured custom proxy must be valid');
  const caBundlePath = path.join(appData, 'outbound-header-proxy/certs/trusted-ca-bundle.pem');
  const childEnvironment = contracts.buildGatewayNetworkEnvironment(
    process.env,
    proxyUrl ? { proxyUrl, caBundlePath: fs.existsSync(caBundlePath) ? caBundlePath : null } : null,
  );
  contracts.applyTrustedCertificateEnv(
    childEnvironment,
    fs.existsSync(caBundlePath) ? caBundlePath : null,
  );
  console.log(JSON.stringify({ transport: proxyMode, credential: 'existing-file-reference' }));
  const allowed = new Set(Object.values(contracts.McpAppMethod));
  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  host = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${host.address().port}`;
    if (req.headers.host !== new URL(origin).host || !req.url.startsWith(`/${capability}/`))
      return json(res, {}, 403);
    const route = req.url.slice(capability.length + 2);
    if (req.method === 'GET' && route === 'payload') return json(res, payload);
    if (req.method === 'GET' && route === 'downloads') return json(res, downloads);
    if (req.method === 'GET' && route === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(': connected\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'GET' && ['host.js', 'product.css'].includes(route)) {
      res.writeHead(200, {
        'Content-Type': route.endsWith('.js') ? 'text/javascript' : 'text/css',
      });
      return res.end(fs.readFileSync(path.join(output, route)));
    }
    if (req.method === 'GET' && route === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<!doctype html><html lang="zh" data-theme="classic-light"><head><link rel="stylesheet" href="product.css"><style>html{background:var(--justdo-background);color:var(--justdo-text-primary)}body{max-width:1040px;margin:28px auto;font:14px system-ui}</style></head><body><script type="module" src="host.js"></script></body></html>',
      );
    }
    if (
      req.method !== 'POST' ||
      req.headers.origin !== origin ||
      req.headers['content-type'] !== 'application/json'
    )
      return json(res, {}, 403);
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 36 * 1024 * 1024) throw new Error('Bound test request');
      }
      const input = JSON.parse(body);
      if (route === 'rpc') {
        assert.ok(
          allowed.has(input.method) &&
            input.params?.sessionKey === sessionKey &&
            /^ui-[a-f0-9-]{36}$/.test(input.id),
        );
        return json(res, { ok: true, value: await rpc(input.method, input.params, input.id) });
      }
      if (route === 'download') {
        assert.ok(
          contracts.validMcpAppDownloadName(input.fileName, input.mimeType) &&
            contracts.validMcpAppDownloadBase64(input.dataBase64),
        );
        const bytes = Buffer.from(input.dataBase64, 'base64');
        assert.ok(bytes.length <= contracts.MCP_APP_DOWNLOAD_MAX_BYTES);
        if (input.mimeType === 'image/png') assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
        else if (input.mimeType === 'image/svg+xml') assert.match(bytes.toString(), /<svg/);
        else assert.match(bytes.toString(), /mxfile|mxGraphModel/);
        fs.writeFileSync(path.join(output, input.fileName), bytes);
        downloads.push({ fileName: input.fileName, mimeType: input.mimeType, bytes: bytes.length });
        return json(res, { success: true, value: { canceled: false } });
      }
      if (route === 'close') {
        json(res, { ok: true });
        void close();
        return;
      }
      json(res, {}, 404);
    } catch {
      json(res, { ok: false }, 400);
    }
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${host.address().port}/${capability}/`;
  previewUrl = url;
  await build({
    entryPoints: [path.join(root, 'tests/drawio/real-model-host.ts')],
    outfile: path.join(output, 'host.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome140',
    alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
    plugins: [
      {
        name: 'inline-chat-styles',
        setup(builder) {
          builder.onResolve({ filter: /\.css\?inline$/ }, args => ({
            path: require.resolve(
              args.path
                .replace(/\?inline$/, '')
                .replace(/^@\//, path.join(root, 'src/renderer') + '/'),
              { paths: [args.resolveDir] },
            ),
            namespace: 'inline-style',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'inline-style' }, args => ({
            contents: fs
              .readFileSync(args.path, 'utf8')
              .replace(/url\(([^)]+)\)/g, (_match, relative) => {
                if (/^["']?(data:|https?:|#)/.test(relative)) return _match;
                const font = path.resolve(path.dirname(args.path), relative.replace(/["']/g, ''));
                return `url(data:font/${path.extname(font).slice(1)};base64,${fs.readFileSync(font).toString('base64')})`;
              }),
            loader: 'text',
          }));
        },
      },
    ],
  });
  const css = fs
    .readdirSync(path.join(root, 'dist/assets'))
    .find(file => /^main-.*\.css$/.test(file));
  fs.copyFileSync(path.join(root, 'dist/assets', css), path.join(output, 'product.css'));
  const port = await adjacentPort();
  const config = {
    gateway: {
      mode: 'local',
      bind: 'loopback',
      port,
      auth: { mode: 'token', token },
      controlUi: { allowedOrigins: [new URL(url).origin] },
    },
    update: { checkOnStart: false, auto: { enabled: false } },
    logging: { level: 'debug', consoleLevel: 'debug' },
    browser: { enabled: false },
    agents: {
      ownership: 'explicit',
      entries: { main: {} },
      defaults: {
        workspace,
        skipBootstrap: source.agents?.defaults?.skipBootstrap === true,
        heartbeat: { every: '0m' },
        model: { primary: modelRef, fallbacks: [] },
        thinkingDefault: source.agents?.defaults?.thinkingDefault,
        timeoutSeconds: source.agents?.defaults?.timeoutSeconds ?? 0,
      },
    },
    models: { mode: 'replace', providers: { [providerId]: { ...provider, models: [model] } } },
    secrets: { providers: { [provider.apiKey.provider]: secretProvider } },
    // Keep the application's normal tool policy, including ordinary file/shell,
    // browser and skill tools. No drawing-only allowlist or forced tool choice.
    tools: structuredClone(source.tools ?? {}),
    plugins: {
      enabled: source.plugins?.enabled !== false,
      allow: source.plugins?.allow?.filter(id => availablePlugins.has(id)),
      deny: source.plugins?.deny?.filter(id => availablePlugins.has(id)),
      // Do not copy plugin config paths, stores or user data into the fixture.
      entries: Object.fromEntries(
        Object.entries(source.plugins?.entries ?? {})
          .filter(([id]) => availablePlugins.has(id))
          .map(([id, entry]) => [id, { enabled: entry.enabled !== false }]),
      ),
    },
    mcp: { apps: { enabled: true } },
  };
  const configPath = path.join(output, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  async function startGateway() {
    const started = Date.now();
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
        '--verbose',
      ],
      {
        cwd: output,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...childEnvironment,
          OPENCLAW_HOME: output,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_BUNDLED_PLUGINS_DIR: plugins,
          OPENCLAW_BUNDLED_SKILLS_DIR: path.join(runtime, 'skills'),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1',
          OPENCLAW_NO_RESPAWN: '1',
          OPENCLAW_SKIP_CHANNELS: '1',
          OPENCLAW_SKIP_CRON: '1',
          VITEST: 'true',
        },
      },
    );
    for (const pipe of [gateway.stdout, gateway.stderr])
      pipe.on('data', chunk => {
        gatewayLog = (gatewayLog + chunk).slice(-60000);
        for (const match of chunk.toString().matchAll(/cataloged (\d+) tools/g)) {
          catalogSizes.push(Number(match[1]));
          console.log(`Native tool catalog: ${match[1]} tools.`);
        }
      });
    let ready = false;
    while (Date.now() - started < 180000) {
      if (gateway.exitCode !== null || gateway.signalCode !== null)
        throw new Error('Isolated Gateway failed to start');
      try {
        if (
          (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) })).ok
        ) {
          ready = true;
          break;
        }
      } catch {
        /* Await only this test listener. */
      }
      await delay(200);
    }
    assert.ok(ready, 'Isolated Gateway must become ready before connecting');
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.type === 'event') {
        events.push(packet);
        if (packet.event.startsWith('mcp.app.'))
          for (const stream of streams) stream.write(`data: ${JSON.stringify(packet)}\n\n`);
      }
      if (packet.type !== 'res') return;
      const item = pending.get(packet.id);
      if (!item) return;
      pending.delete(packet.id);
      clearTimeout(item.timer);
      packet.ok
        ? item.resolve(packet.payload)
        : item.reject(new Error(`RPC rejected: ${packet.error?.code ?? 'unknown'} (${packet.id})`));
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await rpc('connect', {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: 'cli',
        version: 'diagram-real-model-test',
        platform: process.platform,
        mode: 'cli',
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      auth: { token },
      caps: ['tool-events', 'inline-widgets'],
    });
  }
  await startGateway();
  const session = await rpc('sessions.create', {
    key: sessionKey,
    cwd: workspace,
    permissionMode: 'workspace',
  });
  const skillStatus = await rpc('skills.status', { agentId: 'main' });
  const drawingSkill = skillStatus.skills?.find(skill => skill.name === 'drawio-diagrams');
  assert.ok(
    drawingSkill && drawingSkill.eligible && !drawingSkill.disabled,
    'Native skills must expose the enabled plugin drawing guide',
  );
  const receipt = await rpc('chat.send', {
    sessionKey,
    idempotencyKey: randomBytes(12).toString('hex'),
    message: prompt,
  });
  console.log('Real model request accepted; waiting for exact settled lifecycle.');
  const runStart = Date.now();
  let terminal;
  while (Date.now() - runStart < 600000) {
    terminal = events.find(
      event =>
        event.event === 'agent' &&
        event.payload?.runId === receipt.runId &&
        event.payload?.sessionKey === sessionKey &&
        event.payload.stream === 'lifecycle' &&
        ['end', 'error'].includes(event.payload.data?.phase) &&
        event.payload.data.executionSettled === true,
    );
    if (terminal) break;
    await delay(200);
  }
  assert.ok(terminal, 'Require exact whole-run executionSettled terminal');
  const history = await rpc('chat.history', { sessionKey, limit: 80 });
  assert.equal(history.sessionKey, sessionKey);
  assert.equal(history.sessionId, session.sessionId);
  fs.writeFileSync(
    path.join(output, 'run-terminal.json'),
    JSON.stringify(
      {
        runId: receipt.runId,
        terminal: terminal.payload.data,
        errors: (history.messages ?? [])
          .map(entry => entry.message ?? entry)
          .filter(message => message.errorMessage)
          .map(message => ({
            provider: message.provider,
            model: message.model,
            stopReason: message.stopReason,
            errorMessage: message.errorMessage,
          })),
      },
      null,
      2,
    ),
  );
  assert.equal(terminal.payload.data.phase, 'end', 'Real model run must succeed');
  let selected;
  for (const entry of history.messages ?? []) {
    const message = entry.message ?? entry;
    const preview = contracts.decodeNativeMcpAppHistoryResult(
      message,
      message.toolName,
      message.toolCallId,
    );
    if (preview?.descriptor.serverName === 'drawio') selected = { message };
    for (const child of Array.isArray(message.content) ? message.content : []) {
      const nested = contracts.decodeNativeNestedMcpAppHistoryResult(message, child);
      if (nested?.descriptor.serverName === 'drawio') selected = { message, nested: child };
    }
  }
  assert.ok(selected, 'Real model must invoke draw.io through normal native tooling');
  assert.ok(
    catalogSizes.some(size => size >= 50),
    'Normal broad tool catalog must remain enabled',
  );
  payload = {
    ...selected,
    gatewayUrl: `ws://127.0.0.1:${port}`,
    sessionKey,
    sessionId: session.sessionId,
    token,
  };
  const models = (history.messages ?? [])
    .map(entry => entry.message ?? entry)
    .filter(message => message.role === 'assistant')
    .map(message => ({ provider: message.provider, model: message.model, usage: message.usage }));
  assert.ok(
    models.some(item => item.provider === providerId && item.model === modelId),
    'History must confirm the actual selected model',
  );
  fs.writeFileSync(
    path.join(output, 'model-proof.json'),
    JSON.stringify(
      {
        modelRef,
        assets: { commit: assetProof.commit, sourceHash: assetProof.sourceHash },
        models,
        sessionId: session.sessionId,
        runId: receipt.runId,
        terminal: terminal.payload.data,
        prompt,
        tools: {
          policy: {
            allow: config.tools.allow,
            alsoAllow: config.tools.alsoAllow,
            deny: config.tools.deny,
            toolSearch: config.tools.toolSearch,
          },
          catalogSizes,
          drawingOnly: false,
        },
        skill: { name: drawingSkill.name, eligible: drawingSkill.eligible },
        calledTools: [
          ...new Set(
            (history.messages ?? []).flatMap(entry => {
              const message = entry.message ?? entry;
              return Array.isArray(message.content)
                ? message.content.filter(item => item.type === 'toolCall').map(item => item.name)
                : [];
            }),
          ),
        ],
        toolCallId: selected.nested?.toolCallId ?? selected.message.toolCallId,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(output, 'preview.json'),
    JSON.stringify({ url, output, modelRef, ui: 'pending' }, null, 2),
  );
  const child = spawn(require('electron'), [path.join(root, 'tests/drawio/real-model-ui.cjs')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DIAGRAM_TEST_URL: url, DIAGRAM_TEST_OUTPUT: output },
  });
  let uiLog = '';
  for (const pipe of [child.stdout, child.stderr])
    pipe.on('data', data => {
      uiLog = (uiLog + data).slice(-12000);
    });
  const uiExit = await new Promise(resolve => child.once('exit', resolve));
  fs.writeFileSync(path.join(output, 'ui-diagnostics.log'), uiLog);
  assert.equal(uiExit, 0, 'Real native UI probe must succeed');
  assert.deepEqual(
    downloads.map(item => item.mimeType),
    ['application/vnd.jgraph.mxfile', 'image/png', 'image/svg+xml'],
  );
  const editedSource = downloads.find(item => item.mimeType === 'application/vnd.jgraph.mxfile');
  assert.ok(
    fs
      .readFileSync(path.join(output, editedSource.fileName), 'utf8')
      .includes('人事登记（已编辑）'),
    'Exported source must retain the actual inline edit',
  );
  const uiProofPath = path.join(output, 'ui-proof.json');
  fs.writeFileSync(
    uiProofPath,
    JSON.stringify(
      {
        ...JSON.parse(fs.readFileSync(uiProofPath, 'utf8')),
        sourceRunId: receipt.runId,
        sourceSessionId: session.sessionId,
        sourceToolCallId: selected.nested?.toolCallId ?? selected.message.toolCallId,
        assets: { commit: assetProof.commit, sourceHash: assetProof.sourceHash },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(output, 'preview.json'),
    JSON.stringify({ url, output, modelRef, downloads }, null, 2),
  );
  console.log(
    JSON.stringify({
      modelRef,
      output,
      ui: 'passed',
      exports: downloads.map(item => item.mimeType),
    }),
  );
  // Cold restart the same native state. No model call or business-tool replay.
  socket.terminate();
  await new Promise(resolve => {
    gateway.once('exit', resolve);
    gateway.kill();
  });
  await startGateway();
  const restoredHistory = await rpc('chat.history', { sessionKey, limit: 80 });
  assert.equal(restoredHistory.sessionId, session.sessionId);
  downloads.length = 0;
  const restartOutput = path.join(output, 'restart');
  fs.mkdirSync(restartOutput);
  const restartedUi = spawn(
    require('electron'),
    [path.join(root, 'tests/drawio/real-model-ui.cjs')],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DIAGRAM_TEST_URL: url, DIAGRAM_TEST_OUTPUT: restartOutput },
    },
  );
  let restartLog = '';
  for (const pipe of [restartedUi.stdout, restartedUi.stderr])
    pipe.on('data', chunk => {
      restartLog = (restartLog + chunk).slice(-12000);
    });
  const restartExit = await new Promise(resolve => restartedUi.once('exit', resolve));
  fs.writeFileSync(path.join(restartOutput, 'ui-diagnostics.log'), restartLog);
  assert.equal(
    restartExit,
    0,
    'The same historical diagram must render, edit and export after a Gateway restart',
  );
  assert.equal(downloads.length, 3, 'All exports must work on the restored historical view');
  console.log(JSON.stringify({ restart: 'passed', output: restartOutput }));
  if (process.argv.includes('--serve')) {
    const timer = setTimeout(
      () => {
        void close();
      },
      30 * 60 * 1000,
    );
    timer.unref();
  } else await close();
} catch (error) {
  // These are synthetic session diagnostics only, never existing native transcripts.
  fs.writeFileSync(
    path.join(output, 'gateway-diagnostics.log'),
    gatewayLog.replaceAll(token, '<test-token>'),
  );
  console.error(JSON.stringify({ error: error.message, output }));
  if (process.argv.includes('--serve') && payload && host?.listening) {
    fs.writeFileSync(
      path.join(output, 'preview.json'),
      JSON.stringify({ url: previewUrl, output, modelRef, ui: 'failed' }, null, 2),
    );
    setTimeout(
      () => {
        void close();
      },
      30 * 60 * 1000,
    ).unref();
  } else await close();
  process.exitCode = 1;
}
