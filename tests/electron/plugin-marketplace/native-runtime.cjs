'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repository = path.resolve(__dirname, '../../..');
const taskArtifacts = path.join(repository, '.agent-tasks');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

function serializeError(error) {
  return Object.fromEntries(
    [
      'message',
      'code',
      'gatewayCode',
      'requestSent',
      'details',
      'retryable',
      'retryAfterMs',
    ].flatMap(key => {
      const value = error?.[key];
      if (value === undefined) return [];
      try {
        return [[key, JSON.parse(JSON.stringify(value))]];
      } catch {
        return [];
      }
    }),
  );
}

function isolatedEnvironment(directory, runtimeRoot, port, token) {
  // Deliberately do not inherit provider credentials, application state, proxy
  // settings, native client paths, or caller-controlled Node preloads.
  const allowed =
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LC_ALL|TZ)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  const home = path.join(directory, 'home');
  const temporary = path.join(directory, 'temporary');
  const state = path.join(directory, 'state');
  for (const target of [
    home,
    temporary,
    state,
    path.join(directory, 'appdata'),
    path.join(directory, 'local-appdata'),
  ])
    fs.mkdirSync(target, { recursive: true });
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(directory, 'appdata'),
    LOCALAPPDATA: path.join(directory, 'local-appdata'),
    TMP: temporary,
    TEMP: temporary,
    NODE_ENV: 'production',
    NODE_DISABLE_COMPILE_CACHE: '1',
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_NO_RESPAWN: '1',
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(runtimeRoot, 'windows-runtime-preload.cjs'))}`,
  });
  if (process.env.PLUGIN_COPY_OBSERVER_PATH) {
    env.PLUGIN_COPY_OBSERVER_PATH = resolveRenameObserver(process.env.PLUGIN_COPY_OBSERVER_PATH);
    env.PLUGIN_COPY_OBSERVER_RUN = directory;
  }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function resolveRenameObserver(candidate) {
  const observer = fs.realpathSync(candidate);
  assert.ok(
    isWithin(fs.realpathSync(path.join(repository, 'build')), observer) &&
      path.extname(observer) === '.cjs' && fs.statSync(observer).isFile(),
    'Explicit rename observation must use a build-only CJS file inside this worktree',
  );
  return observer;
}

async function reservePort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

function prepareSupport(directory) {
  const { buildSync } = require('esbuild');
  const output = path.join(directory, 'host-support.cjs');
  buildSync({
    stdin: {
      contents: [
        `export { ensureGatewayShutdownPreload, OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE } from ${JSON.stringify(path.join(repository, 'src/main/openclaw/runtime/launch/openclawLauncher.ts'))};`,
        `export { GatewayConfigReloadMonitor } from ${JSON.stringify(path.join(repository, 'src/main/openclaw/runtime/gatewayConfigReloadMonitor.ts'))};`,
        `export { buildGatewayLaunchEnvironment } from ${JSON.stringify(path.join(repository, 'src/main/openclaw/runtime/launch/gatewayLaunchArgs.ts'))};`,
      ].join('\n'),
      resolveDir: repository,
      sourcefile: 'native-marketplace-fixture.ts',
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  });
  return require(output);
}

function verifySnapshotPatchArtifacts(root) {
  require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs')
    .assertRuntimePackageLifecycleComplete(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime-patch-manifest.json'), 'utf8'));
  const runtimeRoot = fs.realpathSync(root);
  for (const entry of manifest.patchDependencyArtifacts ?? []) {
    assert.ok(typeof entry.path === 'string' && entry.path !== '' && !path.isAbsolute(entry.path));
    const artifact = fs.realpathSync(path.join(runtimeRoot, entry.path));
    assert.ok(isWithin(runtimeRoot, artifact), 'A declared patch artifact must stay inside the runtime');
    const content = fs.readFileSync(artifact);
    assert.ok(fs.statSync(artifact).isFile(), 'A declared patch artifact must be a regular file');
    assert.equal(content.length, entry.size, `Changed native patch artifact size: ${entry.path}`);
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256,
      `Changed native patch artifact content: ${entry.path}`);
  }
}

function prepareRuntime(source, dependenciesRoot) {
  const dependencySource = dependenciesRoot ? fs.realpathSync(dependenciesRoot) : source;
  const sourcePackage = fs.readFileSync(path.join(source, 'package.json'));
  const nativeVersion = JSON.parse(sourcePackage).version.replace(/^v/, '');
  const lockedVersion = require(path.join(repository, 'package.json')).openclaw.version.replace(
    /^v/,
    '',
  );
  assert.equal(
    nativeVersion,
    lockedVersion,
    'The probe must use the repository locked native version',
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dependencySource, 'package.json'), 'utf8')),
    JSON.parse(sourcePackage),
    'The explicit dependency tree must belong to the exact same native package',
  );
  for (const name of ['typebox', '@openclaw/fs-safe'])
    assert.ok(
      fs.existsSync(path.join(dependencySource, 'node_modules', name, 'package.json')),
      'This prepared runtime pruned CLI/client dependencies; pass its complete same-version --runtime-dependencies directory',
    );
  const buildRoot = path.join(repository, 'build', 'plugin-marketplace');
  fs.mkdirSync(buildRoot, { recursive: true });
  assert.ok(
    isWithin(fs.realpathSync(repository), fs.realpathSync(buildRoot)),
    'Runtime output must stay in this worktree',
  );
  const executableInputs = [
    'package.json',
    'npm-shrinkwrap.json',
    'openclaw.mjs',
    'gateway-launcher.cjs',
    'gateway-bundle.mjs',
    'windows-runtime-preload.cjs',
    'runtime-build-info.json',
    'runtime-patch-manifest.json',
    'dist/plugin-sdk/gateway-runtime.js',
  ];
  const snapshotDigests = root => {
    // The pinned manifest also covers patched CLI dependencies and support
    // modules outside the Gateway bundle. Never trust a cached bundle alone.
    verifySnapshotPatchArtifacts(root);
    return Object.fromEntries(
      executableInputs.map(name => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(root, name)))
          .digest('hex'),
      ]),
    );
  };
  // An explicitly supplied probe snapshot is already isolated. It can remain
  // usable while another checkout rebuilds its prepared runtime; never fall back
  // to it implicitly when an input directory disappears.
  const sourceMarker = path.join(source, 'fixture-runtime-ready.json');
  if (
    isWithin(fs.realpathSync(buildRoot), fs.realpathSync(source)) &&
    fs.existsSync(sourceMarker)
  ) {
    const marker = JSON.parse(fs.readFileSync(sourceMarker, 'utf8'));
    assert.match(marker.identity, /^[a-f0-9]{16}$/);
    assert.equal(path.basename(source), `native-runtime-${marker.identity}`);
    assert.equal(
      dependencySource,
      source,
      'An explicit probe snapshot must use its own complete dependencies',
    );
    assert.deepEqual(
      snapshotDigests(source),
      marker.digests,
      'The explicit native snapshot changed after verification',
    );
    return { runtime: source, dependencySource };
  }
  const bundleStat = fs.statSync(path.join(source, 'gateway-bundle.mjs'));
  const identity = createHash('sha256')
    .update(source)
    .update(dependencySource)
    .update(sourcePackage)
    .update(String(bundleStat.size))
    .update(String(bundleStat.mtimeMs))
    .update(fs.readFileSync(path.join(dependencySource, 'npm-shrinkwrap.json')))
    .digest('hex')
    .slice(0, 16);
  const target = path.join(buildRoot, `native-runtime-${identity}`);
  const verifySnapshot = () => {
    assert.ok(
      isWithin(fs.realpathSync(buildRoot), fs.realpathSync(target)),
      'Runtime cache must stay under build/',
    );
    const marker = JSON.parse(
      fs.readFileSync(path.join(target, 'fixture-runtime-ready.json'), 'utf8'),
    );
    assert.equal(marker.identity, identity);
    assert.equal(marker.source, source);
    assert.equal(marker.dependencySource, dependencySource);
    // The cache key is an index, not proof. Verify the executable and native
    // build/patch receipts as well, so changed CLI/SDK inputs cannot reuse stale code.
    const digests = snapshotDigests(target);
    assert.deepEqual(
      digests,
      snapshotDigests(source),
      'Stale native fixture cache; rebuild this build/ cache',
    );
    fs.writeFileSync(
      path.join(target, 'fixture-runtime-ready.json'),
      JSON.stringify({ ...marker, digests }),
    );
    return { runtime: target, dependencySource };
  };
  if (fs.existsSync(path.join(target, 'fixture-runtime-ready.json'))) return verifySnapshot();
  const preparing = `${target}-preparing-${process.pid}-${Date.now()}`;
  fs.mkdirSync(preparing);
  assert.ok(isWithin(fs.realpathSync(buildRoot), fs.realpathSync(preparing)));
  // Copy rather than link: native package capture and cleanup must never gain a
  // writable path to either the prepared runtime or its dependency source.
  for (const name of ['dist', 'skills', 'custodian-skills']) {
    const candidate = path.join(source, name);
    if (fs.existsSync(candidate))
      fs.cpSync(candidate, path.join(preparing, name), { recursive: true, dereference: true });
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'gateway.asar') continue;
    fs.copyFileSync(path.join(source, entry.name), path.join(preparing, entry.name));
  }
  fs.cpSync(path.join(dependencySource, 'node_modules'), path.join(preparing, 'node_modules'), {
    recursive: true,
    dereference: true,
  });
  fs.writeFileSync(
    path.join(preparing, 'fixture-runtime-ready.json'),
    JSON.stringify({ source, dependencySource, identity }),
  );
  assert.equal(path.dirname(path.resolve(target)), path.resolve(buildRoot));
  fs.renameSync(preparing, target);
  return verifySnapshot();
}

async function createNativeRuntimeFixture({
  runtimeRoot,
  fixtureRoot,
  nativeDependenciesRoot,
  nodeExecutable = process.execPath,
}) {
  assert.ok(
    runtimeRoot && path.isAbsolute(runtimeRoot),
    'Pass an explicit absolute prepared runtime directory',
  );
  assert.ok(
    fixtureRoot && path.isAbsolute(fixtureRoot),
    'Pass an explicit absolute fixture directory',
  );
  const runtimeSource = fs.realpathSync(runtimeRoot);
  const directory = path.resolve(fixtureRoot);
  assert.ok(
    isWithin(taskArtifacts, directory),
    'Fixture state must stay under this worktree .agent-tasks directory',
  );
  fs.mkdirSync(directory, { recursive: true });
  assert.ok(
    isWithin(fs.realpathSync(taskArtifacts), fs.realpathSync(directory)),
    'Fixture directory cannot escape through a junction',
  );
  for (const name of [
    'gateway-launcher.cjs',
    'gateway-bundle.mjs',
    'windows-runtime-preload.cjs',
    'openclaw.mjs',
    'dist/plugin-sdk/gateway-runtime.js',
  ])
    assert.ok(fs.existsSync(path.join(runtimeSource, name)), `Prepared runtime is missing ${name}`);

  const { runtime, dependencySource } = prepareRuntime(runtimeSource, nativeDependenciesRoot);
  const intermediates = path.join(
    repository,
    'build',
    'plugin-marketplace',
    `${path.basename(directory)}-${process.pid}`,
  );
  fs.mkdirSync(intermediates, { recursive: true });

  const port = await reservePort();
  const token = randomBytes(24).toString('hex');
  const env = isolatedEnvironment(directory, runtime, port, token);
  const configPath = env.OPENCLAW_CONFIG_PATH;
  assert.ok(
    !fs.existsSync(configPath),
    'Use a fresh fixture directory; never reuse a configuration',
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        logging: {
          file: path.join(directory, 'native-gateway.log'),
          level: 'debug',
          consoleLevel: 'info',
        },
        gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
        update: { checkOnStart: false, auto: { enabled: false } },
        discovery: { mdns: { mode: 'off' } },
        agents: {
          ownership: 'explicit',
          entries: { main: {} },
          defaults: {
            workspace: path.join(directory, 'workspace'),
            skipBootstrap: true,
            heartbeat: { every: '0m' },
          },
        },
        models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: {} },
        plugins: { slots: { memory: 'none' }, allow: [], entries: {} },
        skills: { entries: { 'fixture-market-skill': { enabled: false } } },
        mcp: { servers: {} },
      },
      null,
      2,
    ),
  );
  fs.mkdirSync(path.join(directory, 'workspace'), { recursive: true });
  const support = prepareSupport(intermediates);
  const monitor = new support.GatewayConfigReloadMonitor();
  let status = { phase: 'starting' };
  let gatewayProcessGeneration = 0;
  const evidence = {
    runtime,
    version: JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8')).version,
    runtimeSource,
    dependencySource,
    directory,
    port,
    gatewayPid: null,
    brokerPid: null,
    started: false,
    cleanShutdown: false,
    requests: [],
  };
  if (!/electron(?:\.exe)?$/i.test(nodeExecutable)) delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(nodeExecutable, [__filename, '--broker', runtime, directory, intermediates], {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  evidence.brokerPid = child.pid;
  let nextRequest = 0;
  const requests = new Map();
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimer = setTimeout(
    () => rejectReady(new Error('Isolated native Gateway did not start within 5 minutes')),
    300_000,
  );
  const appendLog = data =>
    fs.appendFileSync(
      path.join(directory, 'gateway-console.log'),
      String(data).replaceAll(token, '<fixture-token>'),
    );
  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);
  child.on('message', message => {
    if (message?.type === 'line') {
      monitor.observeLine(message.line);
      return;
    }
    if (message?.type === 'status') {
      if (message.status.phase === 'running' && (status.phase !== 'running' || message.pid !== evidence.gatewayPid))
        gatewayProcessGeneration += 1;
      status = message.status;
      evidence.gatewayPid = message.pid ?? null;
      evidence.launchEnvironment = message.launch;
      if (status.phase === 'stopped') monitor.observeGatewayExit();
      return;
    }
    if (message?.type === 'ready') {
      evidence.started = true;
      resolveReady();
      return;
    }
    if (message?.type === 'fatal') {
      rejectReady(Object.assign(new Error(message.error.message), message.error));
      return;
    }
    if (message?.type !== 'response') return;
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    request.cleanup();
    if (message.error)
      request.reject(Object.assign(new Error(message.error.message), message.error));
    else request.resolve(message.value);
  });
  child.once('error', rejectReady);
  child.once('exit', (code, signal) => {
    const error = new Error(`Isolated native broker exited (${code ?? signal})`);
    rejectReady(error);
    for (const request of requests.values()) {
      request.cleanup();
      request.reject(error);
    }
    requests.clear();
  });
  const send = (command, params = {}, options = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextRequest;
      const abort = () => {
        requests.delete(id);
        cleanup();
        reject(
          Object.assign(new Error('Isolated Gateway request aborted'), {
            code: 'CLIENT_ABORTED',
            requestSent: true,
          }),
        );
      };
      const timer = setTimeout(
        () => {
          requests.delete(id);
          cleanup();
          reject(
            Object.assign(new Error('Isolated Gateway request timed out'), {
              code: 'CLIENT_TIMEOUT',
              requestSent: true,
            }),
          );
        },
        (options.timeoutMs ?? 120_000) + 5000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      requests.set(id, { resolve, reject, cleanup });
      child.send({ id, command, params, timeoutMs: options.timeoutMs }, error => {
        if (error && requests.delete(id)) {
          cleanup();
          reject(error);
        }
      });
    });
  try {
    await ready;
  } catch (error) {
    if (child.connected) child.send({ id: ++nextRequest, command: 'close' });
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }

  const requestGateway = (method, params, options) => {
    evidence.requests.push(method);
    return send('request', { method, params }, options);
  };
  const lifecycle = command => send(command, {}, { timeoutMs: 300_000 });
  const manager = {
    getStatus: () => ({ ...status }),
    getGatewayProcessId: () => evidence.gatewayPid,
    getGatewayProcessGeneration: () => gatewayProcessGeneration,
    getBaseDir: () => env.OPENCLAW_HOME,
    getStateDir: () => env.OPENCLAW_STATE_DIR,
    getConfigPath: () => configPath,
    getRuntimeRoot: () => runtime,
    getGatewayConfigReloadGeneration: () => monitor.getGeneration(),
    waitForGatewayConfigReload: (generation, timeoutMs) =>
      monitor.waitForReloadAfter(generation, timeoutMs),
    buildCliEnvironment: async () => ({
      runtimeRoot: runtime,
      env: { ...env },
      openclawEntry: path.join(runtime, 'openclaw.mjs'),
    }),
    startGateway: () => lifecycle('start'),
    stopGateway: () => lifecycle('stop'),
    restartGateway: () => lifecycle('restart'),
  };
  let closing;
  return {
    manager,
    gateway: { requestGateway },
    connectedGateway: { request: requestGateway },
    requestGateway,
    applyConfigPatch: (patch, options = {}) =>
      send('applyConfigPatch', { patch, replacePaths: options.replacePaths }),
    evidence,
    close: () =>
      (closing ??= send('close', {}, { timeoutMs: 40_000 }).then(async value => {
        evidence.cleanShutdown = value.clean;
        if (child.exitCode === null && child.signalCode === null)
          await new Promise(resolve => child.once('exit', resolve));
        assert.equal(child.exitCode, 0, 'The native fixture broker must exit successfully');
        evidence.brokerExited = true;
        return value;
      })),
  };
}

async function runBroker(runtime, directory, intermediates) {
  const support = require(path.join(intermediates, 'host-support.cjs'));
  const shutdownPreload = support.ensureGatewayShutdownPreload(intermediates);
  const gatewayEnvironment = support.buildGatewayLaunchEnvironment(process.env, {
    appStartedAtMs: Date.now(),
  });
  if (process.env.PLUGIN_COPY_OBSERVER_PATH) {
    const observer = resolveRenameObserver(process.env.PLUGIN_COPY_OBSERVER_PATH);
    gatewayEnvironment.NODE_OPTIONS = [
      gatewayEnvironment.NODE_OPTIONS,
      `--require=${JSON.stringify(observer)}`,
    ].filter(Boolean).join(' ');
    gatewayEnvironment.PLUGIN_COPY_OBSERVER_RUN = directory;
  }
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  const port = Number(process.env.OPENCLAW_GATEWAY_PORT);
  const { GatewayClient } = await import(
    pathToFileURL(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js')).href
  );
  let gateway;
  let client;
  let stopping = false;
  const send = message => {
    if (process.connected) process.send(message);
  };
  const reportStatus = phase => send({
    type: 'status', status: { phase }, pid: gateway?.pid,
    launch: {
      windowsPolling: gatewayEnvironment.CHOKIDAR_USEPOLLING ?? null,
      pollingInterval: gatewayEnvironment.CHOKIDAR_INTERVAL ?? null,
    },
  });
  async function start() {
    if (gateway && gateway.exitCode === null && client) return { phase: 'running' };
    reportStatus('starting');
    gateway = spawn(
      process.execPath,
      [
        '--require',
        shutdownPreload,
        path.join(runtime, 'gateway-launcher.cjs'),
        'gateway',
        'run',
        '--allow-unconfigured',
        '--port',
        String(port),
      ],
      {
        cwd: directory,
        env: gatewayEnvironment,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    gateway.once('exit', () => reportStatus('stopped'));
    for (const stream of [gateway.stdout, gateway.stderr]) {
      let buffered = '';
      stream.on('data', data => {
        const text = String(data).replaceAll(token, '<fixture-token>');
        process.stderr.write(text);
        buffered += text;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop();
        // ANSI escape codes are stripped before matching native lifecycle logs.
        // eslint-disable-next-line no-control-regex
        for (const line of lines) send({ type: 'line', line: line.replace(/\x1b\[[0-9;]*m/g, '') });
      });
    }
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (gateway.exitCode !== null || gateway.signalCode !== null)
        throw new Error('Fixture Gateway exited before becoming healthy; inspect its isolated log');
      try {
        if (
          (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }))
            .ok
        )
          break;
      } catch {
        /* Wait for this isolated listener only. */
      }
      await delay(100);
    }
    assert.ok(Date.now() < deadline, 'Isolated Gateway health deadline exceeded');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Isolated native Gateway client handshake timed out')),
        90_000,
      );
      client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: 'gateway-client',
        mode: 'backend',
        scopes: ['operator.admin'],
        requestTimeoutMs: 120_000,
        onHelloOk: () => {
          clearTimeout(timer);
          resolve();
        },
        onConnectError: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      client.start();
    });
    gateway.send('justdo:gateway:ready');
    reportStatus('running');
    return { phase: 'running' };
  }
  async function stop() {
    await client?.stop();
    client = undefined;
    if (!gateway) return { phase: 'stopped', clean: true };
    const child = gateway;
    if (child.exitCode !== null || child.signalCode !== null) {
      reportStatus('stopped');
      gateway = undefined;
      return { phase: 'stopped', clean: child.exitCode === 0 && child.signalCode === null };
    }
    let forced = false;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.send(support.OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
    const timeout = setTimeout(() => {
      forced = true;
      child.kill();
    }, 30_000);
    await exited;
    clearTimeout(timeout);
    reportStatus('stopped');
    gateway = undefined;
    return {
      phase: 'stopped',
      clean: !forced && child.exitCode === 0 && child.signalCode === null,
    };
  }
  async function applyConfigPatch(patch, replacePaths) {
    const before = await client.request('config.get', {});
    assert.equal(before.valid, true, 'Fixture native config must be valid');
    assert.equal(typeof before.hash, 'string', 'Native config revision is required');
    const result = await client.request('config.patch', {
      baseHash: before.hash,
      raw: JSON.stringify(patch),
      ...(replacePaths?.length ? { replacePaths } : {}),
    });
    assert.equal(result.ok, true, 'Native config.patch did not acknowledge application');
    const after = await client.request('config.get', {});
    assert.equal(after.valid, true);
    if (result.hash)
      assert.equal(after.hash, result.hash, 'Native revision changed before confirmation');
    return {
      success: true,
      changed: result.noop !== true,
      hash: after.hash,
      changedPaths: result.changedPaths ?? [],
    };
  }
  let lifecycleTail = Promise.resolve();
  process.on('message', message => {
    if (!message?.id || stopping) return;
    const execute = async () => {
      if (message.command === 'request')
        return client.request(message.params.method, message.params.params, {
          timeoutMs: message.timeoutMs,
        });
      if (message.command === 'applyConfigPatch')
        return applyConfigPatch(message.params.patch, message.params.replacePaths);
      if (message.command === 'start') return start();
      if (message.command === 'stop') return stop();
      if (message.command === 'restart') {
        const stopped = await stop();
        assert.equal(stopped.clean, true, 'Refusing restart after an unclean fixture shutdown');
        return start();
      }
      if (message.command === 'close') {
        stopping = true;
        return stop();
      }
      throw new Error('Unknown isolated native fixture command');
    };
    const pending = ['start', 'stop', 'restart', 'close'].includes(message.command)
      ? lifecycleTail.then(execute)
      : execute();
    if (['start', 'stop', 'restart', 'close'].includes(message.command))
      lifecycleTail = pending.catch(() => undefined);
    pending.then(
      value => {
        if (message.command === 'close') {
          process.send({ type: 'response', id: message.id, value }, () =>
            process.exit(value.clean ? 0 : 1),
          );
        } else send({ type: 'response', id: message.id, value });
      },
      error => send({ type: 'response', id: message.id, error: serializeError(error) }),
    );
  });
  process.once('disconnect', () => {
    stopping = true;
    void stop().finally(() => process.exit(0));
  });
  try {
    await start();
    send({ type: 'ready' });
  } catch (error) {
    send({ type: 'fatal', error: serializeError(error) });
    await stop();
    process.exitCode = 1;
    process.disconnect();
  }
}

module.exports = { createNativeRuntimeFixture, prepareRuntime, verifySnapshotPatchArtifacts };
if (require.main === module && process.argv[2] === '--broker') {
  runBroker(process.argv[3], process.argv[4], process.argv[5]).catch(error => {
    if (process.connected) process.send({ type: 'fatal', error: serializeError(error) });
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}
