// Run after the complete packaged runtime build. Only local Gateway discovery RPCs are used; no model is invoked.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
(async () => {
  const root = path.resolve(process.argv[2] || 'vendor/openclaw-runtime/current');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-video-smoke-'));
  const workspace = path.join(state, 'workspace');
  fs.mkdirSync(workspace);
  const token = randomBytes(24).toString('hex');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const ids = ['kie', 'zai', 'novita'];
  const selections = ['kie/kling-2.6/text-to-video', 'zai/cogvideox-3', 'novita/wan2.6-t2v'];
  const secretPath = path.join(state, 'extension-secrets.json');
  fs.writeFileSync(
    secretPath,
    JSON.stringify(Object.fromEntries(ids.map(id => [id, 'offline-smoke-placeholder']))),
    { mode: 0o600 },
  );
  if (process.platform === 'win32') {
    const systemDirectory = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const options = { windowsHide: true, timeout: 5000, encoding: 'utf8' };
    const identity = execFileSync(
      path.join(systemDirectory, 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      options,
    );
    const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('Cannot identify synthetic credential owner.');
    execFileSync(
      path.join(systemDirectory, 'icacls.exe'),
      [secretPath, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F'],
      options,
    );
  }
  // Fail locally if an implementation unexpectedly tries to contact a model provider.
  let providerRequests = 0;
  const trap = require('node:http').createServer((_request, response) => {
    providerRequests++;
    response.writeHead(503).end('Model requests are forbidden in this smoke test.');
  });
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
  const providerBaseUrl = 'http://127.0.0.1:' + trap.address().port;
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    tools: { alsoAllow: ['video_generate'] },
    update: { checkOnStart: false, auto: { enabled: false } },
    agents: {
      entries: { main: {} },
      defaults: {
        workspace,
        systemAgent: { agentId: 'main' },
        mediaModels: { video: { primary: selections[0], fallbacks: selections.slice(1) } },
      },
    },
    secrets: {
      providers: { 'justdo-extension-secrets': { source: 'file', path: secretPath, mode: 'json' } },
    },
    models: {
      providers: Object.fromEntries(
        ids.map(id => [
          id,
          {
            api: 'openai-completions',
            models: [],
            baseUrl: providerBaseUrl,
            apiKey: { source: 'file', provider: 'justdo-extension-secrets', id: '/' + id },
          },
        ]),
      ),
    },
    plugins: { allow: ids, entries: Object.fromEntries(ids.map(id => [id, { enabled: true }])) },
  };
  fs.writeFileSync(path.join(state, 'openclaw.json'), JSON.stringify(config));
  process.env.OPENCLAW_HOME = state;
  process.env.OPENCLAW_STATE_DIR = state;
  process.env.OPENCLAW_CONFIG_PATH = path.join(state, 'openclaw.json');
  process.env.OPENCLAW_NO_RESPAWN = '1';
  const child = spawn(
    process.execPath,
    [
      path.join(root, 'gateway-launcher.cjs'),
      'gateway',
      'run',
      '--allow-unconfigured',
      '--port',
      String(port),
    ],
    { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', b => {
    output += b;
  });
  child.stderr.on('data', b => {
    output += b;
  });
  let client;
  const deadline = setTimeout(() => {
    child.kill();
  }, 90_000);
  try {
    const started = Date.now();
    while (Date.now() - started < 60000) {
      if (child.exitCode !== null) throw new Error('Gateway exited: ' + child.exitCode);
      try {
        if (
          (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) })).ok
        )
          break;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    const file = fs
      .readdirSync(path.join(root, 'dist'))
      .find(
        f =>
          /^client-.*\.mjs$/.test(f) &&
          fs.readFileSync(path.join(root, 'dist', f), 'utf8').includes('GatewayClient as t'),
      );
    const { t: GatewayClient } = await import(pathToFileURL(path.join(root, 'dist', file)).href);
    const hello = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gateway handshake timed out')), 20000);
      client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: 'gateway-client',
        mode: 'backend',
        scopes: ['operator.admin'],
        onHelloOk: data => {
          clearTimeout(timer);
          resolve(data);
        },
        onConnectError: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      client.start();
    });
    const methods = hello.features?.methods ?? [];
    for (const method of ['plugins.list', 'tools.catalog', 'config.get'])
      if (!methods.includes(method)) throw new Error('Missing method: ' + method);
    const snapshot = await client.request('config.get', {});
    if (snapshot.valid !== true)
      throw new Error('Packaged Gateway rejected native video/SecretRef configuration.');
    const inventory = await client.request('plugins.list', {});
    const plugins = ids.map(id => {
      const plugin = inventory.plugins?.find(entry => entry.id === id);
      if (plugin?.runtime?.state !== 'active')
        throw new Error(
          'Provider plugin not active: ' + id + ' ' + JSON.stringify(plugin?.runtime),
        );
      return { id, state: plugin.runtime.state };
    });
    const catalog = await client.request('tools.catalog', {
      agentId: 'main',
      includePlugins: true,
    });
    const tools = (catalog.groups ?? []).flatMap(group => group.tools ?? []);
    if (!tools.some(tool => tool.id === 'video_generate'))
      throw new Error('Missing native video_generate tool catalog entry.');
    // The native list action enumerates registered providers and credential readiness locally.
    const discoveryResponse = await fetch('http://127.0.0.1:' + port + '/tools/invoke', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'video_generate', args: { action: 'list' } }),
      signal: AbortSignal.timeout(30000),
    });
    const discovery = await discoveryResponse.json();
    if (!discoveryResponse.ok || discovery.ok !== true)
      throw new Error('Native video discovery failed: ' + JSON.stringify(discovery));
    const registered = discovery.result?.details?.providers ?? [];
    for (const id of ids) {
      const provider = registered.find(entry => entry.id === id);
      if (!provider?.configured || !provider.models?.length)
        throw new Error('Video provider missing credentials/models: ' + id);
    }
    if (providerRequests !== 0) throw new Error('Discovery unexpectedly invoked a model provider.');
    console.log(
      JSON.stringify({
        ok: true,
        protocol: hello.protocol,
        configValid: true,
        plugins,
        videoToolCatalog: true,
        registeredProviders: ids,
        providerRequests,
        state,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    if (client) await client.stopAndWait().catch(() => client.stop());
    child.kill();
    await new Promise(resolve => trap.close(resolve));
    fs.writeFileSync(path.join(state, 'smoke.log'), output.replaceAll(token, '<test-token>'));
    console.log('Smoke log: ' + path.join(state, 'smoke.log'));
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
