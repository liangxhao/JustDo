// Run manually after the complete host runtime build; uses isolated state and makes no model requests.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
(async () => {
  const root = path.resolve(process.argv[2] || 'vendor/openclaw-runtime/current');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-gateway-smoke-'));
  const workspace = path.join(state, 'workspace');
  fs.mkdirSync(workspace);
  const token = randomBytes(24).toString('hex');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const ids = [
    'acpx',
    'ask-user-question',
    'automation-permission',
    'plan-mode',
    'runtime-services',
    'code-mode-quickjs',
    'github',
    'memory-core',
  ];
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    update: { checkOnStart: false, auto: { enabled: false } },
    agents: { entries: { main: {} }, defaults: { workspace, systemAgent: { agentId: 'main' } } },
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
    for (const method of ['progressCard.refresh', 'sessions.create', 'acpx.agent.doctor'])
      if (!methods.includes(method)) throw new Error('Missing method: ' + method);
    await client.request('health', {});
    const session = await client.request('sessions.create', {
      key: 'agent:main:justdo:smoke',
      cwd: workspace,
      permissionMode: 'read-only',
    });
    const card = await client.request('progressCard.get', {
      sessionKey: 'agent:main:justdo:smoke',
    });
    console.log(
      JSON.stringify({
        ok: true,
        protocol: hello.protocol,
        methodCount: methods.length,
        progressRefresh: true,
        acpxDoctor: true,
        sessionCreated: !!session,
        card: card.card ?? null,
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
    fs.writeFileSync(path.join(state, 'smoke.log'), output.replaceAll(token, '<test-token>'));
    console.log('Smoke log: ' + path.join(state, 'smoke.log'));
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
