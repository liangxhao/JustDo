import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveNativeSmokeTarget } from '../../../tests/openclaw/runtime/native-smoke-target.mjs';

// This starts only a disposable Gateway with its own config, state and identity.
// No user Gateway, user transcript, model provider or public network is used.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const developmentViewer = process.argv.includes('--development-viewer');
const verifyBrowser = process.argv.includes('--browser') || developmentViewer;
assert.ok(
  process.argv[2] && !process.argv[2].startsWith('--'),
  'Select the native runtime explicitly',
);
const { runtimeRoot: runtime, identity } = resolveNativeSmokeTarget(process.argv[2]);
const runtimePackage = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
assert.equal(runtimePackage.version, '2026.10.7', 'Use the locked prepared runtime');
await mkdir(path.join(root, 'build'), { recursive: true });
const fixture = await mkdtemp(path.join(root, 'build/widget-pinned-contract-'));
const state = path.join(fixture, 'state');
const workspace = path.join(fixture, 'project');
const token = randomBytes(24).toString('hex');
const sockets = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = body => createHash('sha256').update(body).digest('hex');
const redact = text =>
  String(text)
    .replaceAll(token, '<fixture-token>')
    .replace(/\/__openclaw__\/cap\/[^\s/"'<>]+/g, '/__openclaw__/cap/<fixture-capability>')
    .replace(/([?&](?:bt|oc_cap)=)[^\s&"'<>]+/g, '$1<fixture-ticket>');
let source = '<main id="pinned-contract">Synthetic pinned visualization</main>';
const adapterPath = '/__widget_kit__/image-loading.js';
const declared = { netOrigins: ['https://assets.widget-fixture.invalid'] };
let gateway;
let lifecycle;
let gatewayLog = '';
let assetFixture;

async function adjacentPorts() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const servers = [net.createServer(), net.createServer()];
    try {
      await new Promise((resolve, reject) => {
        servers[0].once('error', reject);
        servers[0].listen(0, '127.0.0.1', resolve);
      });
      const port = servers[0].address().port;
      if (port === 65535) continue;
      await new Promise((resolve, reject) => {
        servers[1].once('error', reject);
        servers[1].listen(port + 1, '127.0.0.1', resolve);
      });
      return port;
    } catch {
      // Pick another adjacent pair; never attach to an existing listener.
    } finally {
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    }
  }
  throw new Error('No isolated Gateway/sandbox port pair available');
}

async function startGateway(port, env) {
  gateway = spawn(
    process.execPath,
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
  for (const stream of [gateway.stdout, gateway.stderr])
    stream.on('data', chunk => {
      gatewayLog = (gatewayLog + chunk).slice(-30_000);
    });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert.equal(gateway.exitCode, null, 'Disposable Gateway must remain alive');
    try {
      if (
        (
          await fetch(`http://127.0.0.1:${port}/startupz`, {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      )
        return;
    } catch {
      /* Only wait for this fixture's listener. */
    }
    await delay(200);
  }
  throw new Error('Disposable Gateway startup timed out');
}

async function connect(port) {
  const { GatewayClient } = await import(
    pathToFileURL(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js')).href
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const events = [];
    let socket;
    try {
      const hello = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture handshake timed out')), 20_000);
        socket = new GatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          clientName: 'gateway-client',
          mode: 'backend',
          scopes: ['operator.admin', 'operator.read', 'operator.write'],
          caps: ['tool-events', 'inline-widgets'],
          requestTimeoutMs: 15_000,
          env: process.env,
          onEvent: event => events.push(event),
          onHelloOk: value => {
            clearTimeout(timer);
            resolve(value);
          },
          onConnectError: error => {
            clearTimeout(timer);
            reject(error);
          },
        });
        sockets.add(socket);
        socket.start();
      });
      assert.equal(hello.protocol, 4);
      const rpc = (method, params) => socket.request(method, params);
      await rpc('health', {});
      return { rpc, hello, events };
    } catch (error) {
      socket?.stop();
      if (!/gateway starting|startup-sidecars/.test(String(error))) throw error;
      await delay(200);
    }
  }
  throw new Error('Fixture Gateway did not become ready');
}

async function stopGateway() {
  const joins = [...sockets].map(socket => socket.stopAndWait());
  if (gateway && gateway.exitCode === null) {
    const child = gateway;
    joins.push(
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Fixture shutdown timed out'));
        }, 60_000);
        child.once('exit', code => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`Fixture Gateway exited ${code}`));
        });
        if (child.connected) child.send(lifecycle.OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
        else child.kill();
      }),
    );
  }
  const results = await Promise.allSettled(joins);
  sockets.clear();
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

function widget(snapshot, name) {
  const value = snapshot.widgets.find(candidate => candidate.name === name);
  assert.ok(value, 'Native snapshot must contain the requested widget');
  return value;
}

function directive(csp, name) {
  return csp
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${name} `));
}

try {
  await Promise.all([mkdir(state), mkdir(workspace)]);
  if (verifyBrowser) {
    const { startPinnedAssetFixture } = await import('./pinned-network-assets.mjs');
    assetFixture = await startPinnedAssetFixture(fixture);
    source = assetFixture.html;
    declared.netOrigins = assetFixture.declaredOrigins;
  }
  const lifecycleFile = path.join(fixture, 'host-lifecycle.cjs');
  require('esbuild').buildSync({
    entryPoints: [path.join(root, 'src/main/openclaw/runtime/launch/openclawLauncher.ts')],
    outfile: lifecycleFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  lifecycle = require(lifecycleFile);
  const pluginRoot = path.join(fixture, 'runtime/dist/extensions/widget-kit');
  await cp(path.join(root, 'plugins/extensions/widget-kit'), pluginRoot, { recursive: true });
  const {
    precompileOpenClawExtensions,
  } = require('../../openclaw/precompile-openclaw-extensions.cjs');
  await precompileOpenClawExtensions(path.join(fixture, 'runtime'), { required: true });
  const port = await adjacentPorts();
  const gatewayOrigin = `http://127.0.0.1:${port}`;
  const configPath = path.join(fixture, 'openclaw.json');
  await writeFile(
    configPath,
    JSON.stringify({
      gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token } },
      update: { checkOnStart: false, auto: { enabled: false } },
      agents: {
        ownership: 'explicit',
        entries: { main: {} },
        defaults: {
          workspace,
          skipBootstrap: true,
          heartbeat: { every: '0m' },
          embeddedAgent: { cyberFailover: { mode: 'off' } },
        },
      },
      models: { catalogRefresh: { enabled: false } },
      tools: { allow: ['show_widget'], codeMode: false, toolSearch: false },
      plugins: { allow: ['widget-kit'], entries: { 'widget-kit': { enabled: true } } },
    }),
  );
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
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1',
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_SKIP_CHANNELS: '1',
    OPENCLAW_SKIP_CRON: '1',
    VITEST: 'true',
  });
  // GatewayClient persists its device only in this fixture, never the user profile.
  for (const key of Object.keys(process.env))
    if (key.toUpperCase().startsWith('OPENCLAW_')) delete process.env[key];
  Object.assign(process.env, env);
  await startGateway(port, env);
  const client = await connect(port);
  const catalog = await client.rpc('plugins.list', {});
  assert.equal(
    catalog.plugins.find(plugin => plugin.id === 'widget-kit')?.runtime?.state,
    'active',
  );
  const surface = client.hello.pluginSurfaceUrls?.['widget-html'];
  assert.ok(surface, 'Real registerHttpRoute must mint a connection-scoped HTML adapter surface');
  assert.equal(new URL(surface).origin, gatewayOrigin);
  assert.match(new URL(surface).pathname, /^\/__openclaw__\/cap\/[^/]+$/);
  const adapterUrl = surface + adapterPath;
  const adapterResponse = await fetch(adapterUrl, { credentials: 'omit', redirect: 'error' });
  assert.equal(adapterResponse.status, 200, 'Native capability serves the exact HTML adapter');
  assert.equal(adapterResponse.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(adapterResponse.headers.get('x-content-type-options'), 'nosniff');
  const adapterBytes = new Uint8Array(await adapterResponse.arrayBuffer());
  assert.ok(adapterBytes.length > 0);
  const candidatePlugin = (await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href))
    .default;
  const definitions = [];
  candidatePlugin.register({
    on: (event, _handler, options) => {
      assert.equal(event, 'before_tool_call');
      assert.deepEqual(options.matcher, ['show_widget']);
    },
    registerBoardWidgetContentKind: definition => definitions.push(definition),
    registerHttpRoute() {},
  });
  const htmlPage = definitions.find(definition => definition.kind === 'html-page');
  const expectedAdapter = await htmlPage.resources.readPublicResource(adapterPath);
  assert.equal(sha256(adapterBytes), sha256(expectedAdapter.body));
  const head = await fetch(adapterUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(adapterUrl, { method: 'POST' })).status, 405);
  assert.equal((await fetch(adapterUrl + '?unexpected=1')).status, 404);
  assert.ok([401, 404].includes((await fetch(gatewayOrigin + adapterPath)).status));
  assert.notEqual(
    (await fetch(surface + '/__widget_kit__/libraries/three-0.186.1.js')).status,
    200,
  );

  const key = 'agent:main:widget-pinned:contract';
  await client.rpc('sessions.create', { key, cwd: workspace, permissionMode: 'guarded' });
  const before = (await client.rpc('sessions.describe', { key, agentId: 'main' })).session;
  assert.ok(before?.sessionId && before.lifecycleRevision, 'Describe exposes physical incarnation');
  assert.equal(before.key, key);
  assert.equal(before.agentId, 'main');
  const pinResult = await client.rpc('tools.invoke', {
    name: 'show_widget',
    sessionKey: key,
    args: {
      name: 'tool-contract',
      title: 'Synthetic native pin',
      pin: true,
      kind: 'html-page',
      widget_code: source,
      capabilities: declared,
    },
  });
  assert.equal(pinResult.ok, true, 'Invoke the actual native show_widget factory');
  assert.equal(pinResult.source, 'core');
  const pinDescriptor = pinResult.output.details;
  assert.equal(pinDescriptor.kind, 'canvas');
  assert.equal(pinDescriptor.capabilityState, 'pending');
  assert.equal(pinDescriptor.view.boardWidgetName, 'tool-contract');
  assert.match(pinDescriptor.view.id, /^cv_[A-Za-z0-9_-]+$/);
  assert.equal(pinDescriptor.presentation.target, 'assistant_message');
  assert.deepEqual(JSON.parse(pinResult.output.content[0].text), pinDescriptor);
  const name = 'html-contract';
  const putParams = {
    sessionKey: key,
    agentId: 'main',
    name,
    title: 'Synthetic pinned contract',
    declared,
    content: { kind: 'registered', contentKind: 'html-page', source },
  };
  const put = await client.rpc('board.widget.put', putParams);
  const pending = widget(put, name);
  assert.equal(pending.grantState, 'pending');
  assert.ok(pending.instanceId);
  const pendingView = widget(
    await client.rpc('board.get', { sessionKey: key, agentId: 'main' }),
    name,
  );
  assert.equal(
    pendingView.frameUrl,
    undefined,
    'Pending is a state entry, not executable admission',
  );
  assert.equal(pendingView.viewGeneration, undefined);
  await assert.rejects(
    client.rpc('board.widget.grant', {
      sessionKey: key,
      agentId: 'main',
      name,
      revision: pending.revision,
      instanceId: `${pending.instanceId}-stale`,
      decision: 'granted',
    }),
    /instance changed|conflict/i,
  );
  await client.rpc('board.widget.grant', {
    sessionKey: key,
    agentId: 'main',
    name,
    revision: pending.revision,
    instanceId: pending.instanceId,
    decision: 'granted',
  });
  const approved = widget(
    await client.rpc('board.get', { sessionKey: key, agentId: 'main' }),
    name,
  );
  assert.equal(approved.grantState, 'granted');
  assert.equal(
    approved.revision,
    pending.revision,
    'Grant changes board revision, not source revision',
  );
  assert.equal(
    approved.instanceId,
    pending.instanceId,
    'Grant preserves the exact widget instance',
  );
  assert.equal(approved.registeredContentKind, 'html-page');
  assert.equal(approved.contentOwner, 'registered');
  assert.ok(approved.viewGeneration && approved.viewTicket && approved.sandboxUrl);
  assert.equal(approved.viewTicketTtlMs, 20 * 60_000);
  const frame = new URL(approved.frameUrl, gatewayOrigin);
  assert.equal(frame.pathname, `/__openclaw__/board/${encodeURIComponent(key)}/${name}/index.html`);
  assert.equal(frame.searchParams.get('bt'), approved.viewTicket);
  assert.equal([...frame.searchParams].length, 1);
  const response = await fetch(frame, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  const outerCsp = response.headers.get('content-security-policy');
  assert.ok(directive(outerCsp, 'connect-src')?.includes(declared.netOrigins[0]));
  const html = await response.text();
  assert.ok(html.includes('Synthetic pinned visualization'));
  assert.ok(html.includes('openclaw:widget-bridge-port-offer'));
  assert.ok(!html.includes(approved.viewTicket), 'Host ticket is absent from authored HTML');
  assert.ok(html.includes('img-src data:'));
  assert.ok(html.includes(`connect-src ${declared.netOrigins[0]}`));
  const scriptUrls = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  const adapterUrls = scriptUrls.filter(url => url === adapterUrl);
  assert.equal(adapterUrls.length, 1, 'The plugin loads its single HTML adapter');
  assert.equal((await fetch(frame, { method: 'HEAD' })).status, 200);
  const noTicket = new URL(frame);
  noTicket.search = '';
  assert.equal((await fetch(noTicket)).status, 401);
  const wrongRoute = new URL(frame);
  wrongRoute.pathname = wrongRoute.pathname.replace(name, 'other-name');
  assert.equal((await fetch(wrongRoute)).status, 401);
  await assert.rejects(
    client.rpc('board.widget.grant', {
      sessionKey: key,
      agentId: 'main',
      name,
      revision: approved.revision,
      instanceId: approved.instanceId,
      decision: 'rejected',
    }),
    /not pending/i,
    'Native grant does not revoke an already granted document',
  );

  let browser;
  if (assetFixture) {
    const inputPath = path.join(fixture, 'browser-input.json');
    const sandboxUrl = new URL(
      approved.sandboxUrl,
      approved.sandboxOrigin ?? `http://127.0.0.1:${approved.sandboxPort}`,
    ).href;
    await writeFile(
      inputPath,
      JSON.stringify({
        ...assetFixture.browser,
        developmentViewer,
        html,
        sandboxUrl,
        gatewayOrigin,
        resourceUrls: adapterUrls,
        mountId: randomUUID(),
        binding: {
          connectionGeneration: 1,
          agentId: 'main',
          sessionKey: key,
          sessionId: before.sessionId,
          lifecycleRevision: before.lifecycleRevision,
          name,
          revision: approved.revision,
          instanceId: approved.instanceId,
          viewGeneration: approved.viewGeneration,
          grantState: 'granted',
          netOrigins: declared.netOrigins,
        },
      }),
      { mode: 0o600 },
    );
    await new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.ELECTRON_RUN_AS_NODE;
      const child = spawn(
        require('electron'),
        [path.join(root, 'scripts/test/widget-kit/verify-pinned-browser.cjs'), inputPath],
        {
          cwd: root,
          env: childEnv,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', chunk => {
          output = (output + chunk).slice(-12_000);
        });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Pinned Electron fixture timed out'));
      }, 90_000);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Pinned Electron fixture failed (${code}): ${redact(output)}`));
      });
    });
    browser = {
      ...JSON.parse(await readFile(path.join(fixture, 'browser-result.json'), 'utf8')),
      ...assetFixture.verifyAudit(),
    };
  }

  const freshSurface = await client.rpc('plugin.surface.refresh', {
    surface: 'widget-html',
    observedUrl: surface,
  });
  const refreshedUrl = freshSurface.pluginSurfaceUrls['widget-html'];
  assert.notEqual(refreshedUrl, surface);
  assert.ok(freshSurface.expiresAtMs > Date.now());
  assert.ok(
    freshSurface.expiresAtMs <= Date.now() + 10 * 60_000 + 5_000,
    `Independent native surface lifetime: ${freshSurface.expiresAtMs - Date.now()}ms`,
  );
  assert.notEqual(
    (await fetch(scriptUrls[0])).status,
    200,
    'Rotation retires the old resource capability',
  );
  const renewed = widget(await client.rpc('board.get', { sessionKey: key, agentId: 'main' }), name);
  for (const field of ['revision', 'instanceId', 'viewGeneration', 'grantState'])
    assert.equal(
      renewed[field],
      approved[field],
      'Credential refresh does not change document identity',
    );
  assert.notEqual(renewed.viewTicket, approved.viewTicket);
  const renewedHtml = await (await fetch(new URL(renewed.frameUrl, gatewayOrigin))).text();
  assert.ok(renewedHtml.includes(refreshedUrl));

  await client.rpc('sessions.reset', { key, agentId: 'main', expectedSessionId: before.sessionId });
  const after = (await client.rpc('sessions.describe', { key, agentId: 'main' })).session;
  assert.equal(
    after.sessionId,
    before.sessionId,
    'Native reset can preserve the physical session ID',
  );
  assert.notEqual(
    after.lifecycleRevision,
    before.lifecycleRevision,
    'Lifecycle revision detects reset',
  );
  const afterReset = widget(
    await client.rpc('board.get', { sessionKey: key, agentId: 'main' }),
    name,
  );
  for (const field of ['revision', 'instanceId', 'viewGeneration', 'grantState'])
    assert.equal(
      afterReset[field],
      approved[field],
      'Board identity alone cannot detect session reset',
    );

  await client.rpc('board.widget.put', {
    ...putParams,
    content: { ...putParams.content, source: source.replace('visualization', 'replacement') },
  });
  assert.equal(
    (await fetch(new URL(renewed.frameUrl, gatewayOrigin))).status,
    401,
    'Updating native source invalidates the old ticket',
  );
  const replacement = widget(
    await client.rpc('board.get', { sessionKey: key, agentId: 'main' }),
    name,
  );
  assert.equal(replacement.grantState, 'pending', 'Changed source requires new native approval');
  assert.notEqual(replacement.instanceId, approved.instanceId);
  await delay(100);
  assert.ok(
    client.events.some(
      event =>
        event.event === 'board.changed' &&
        event.payload?.sessionKey === key &&
        event.payload.widget === name,
    ),
    'Native scoped change event emitted',
  );
  console.log(
    JSON.stringify({
      ok: true,
      runtime: runtimePackage.version,
      runtimeIdentity: identity,
      candidatePluginOverlay: true,
      nativeShowWidgetPin: true,
      boardReferenceField: 'details.view.boardWidgetName',
      nativePluginRoutes: 1,
      scopedResourceAuthorization: true,
      pendingAndGrant: true,
      authenticatedBoardHttp: true,
      nativeDoubleCspMetadata: true,
      onlyDeclaredLibrary: true,
      independentSurfaceRefresh: true,
      describeLifecycleRevision: true,
      resetPreservesBoard: true,
      staleTicketRejected: true,
      boardChangedScope: true,
      ...(browser ? { browser } : {}),
    }),
  );
} catch (error) {
  console.error(redact(error.stack ?? error));
  console.error(redact(gatewayLog).slice(-6000));
  process.exitCode = 1;
} finally {
  await stopGateway();
  await assetFixture?.close();
  for (const [prefix, name] of [
    ['openclaw-agent-db-lifecycle-', 'closeOpenClawAgentDatabasesAsync'],
    ['openclaw-state-db-cache-', 'closeOpenClawStateDatabaseAsync'],
  ]) {
    const owners = [];
    for (const file of await readdir(path.join(runtime, 'dist'))) {
      if (!file.startsWith(prefix) || !file.endsWith('.mjs')) continue;
      const source = await readFile(path.join(runtime, 'dist', file), 'utf8');
      if (source.includes(`function ${name}(`) || source.includes(`const ${name} =`))
        owners.push(file);
    }
    assert.equal(owners.length, 1, 'One locked native cleanup owner');
    const module = await import(pathToFileURL(path.join(runtime, 'dist', owners[0])).href);
    const cleanup = Object.values(module).find(
      value => typeof value === 'function' && value.name === name,
    );
    assert.ok(cleanup);
    await cleanup();
  }
  assert.equal(path.dirname(fixture), path.join(root, 'build'));
  assert.ok(path.basename(fixture).startsWith('widget-pinned-contract-'));
  await rm(fixture, { recursive: true, force: true });
}
