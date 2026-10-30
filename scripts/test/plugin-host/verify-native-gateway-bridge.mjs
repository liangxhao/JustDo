// Exercise public Native SDK registration through real Gateway processes and the
// application's real Main manager/request binding. No user state or model endpoint.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { APP_NATIVE_UNKNOWN_OUTCOME } from '../../../plugins/sdk/app-plugin-sdk/native-contract.ts';
import { buildAppPlugin } from '../../plugins/build-app-plugins.mjs';

const repo = path.resolve(import.meta.dirname, '../../..');
const runtime = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ??
  path.join(repo, 'vendor/openclaw-runtime/current'));
const bundled = process.argv.includes('--gateway-bundle');
const offline = process.argv.includes('--block-public-network');
const assistantConfigReload = process.argv.includes('--assistant-config-reload');
const work = await mkdtemp(path.join(tmpdir(), 'app-native-gateway-'));
const parentProcessId = process.pid;
const source = path.join(work, 'source');
const installed = path.join(work, 'installed');
const state = path.join(work, 'state');
const empty = path.join(work, 'empty-bundled');
const configPath = path.join(work, 'openclaw.json');
const id = 'app-native-probe';
const token = randomBytes(24).toString('hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const binding = ({ pluginId, registrationId, processId, gatewayMethods }) =>
  ({ pluginId, registrationId, processId, gatewayMethods });
const checks = [];
const check = name => { checks.push(name); console.log(JSON.stringify({ check: name, passed: true })); };
const clients = new Set();
const nativeListeners = new Set();
const savedEnv = new Map();
let child;
let childClosed;
let log = '';
let connected;
let generation = 0;
let manager;
let desired = true;
let selected;
let nativeClient;
let host;

async function waitUntil(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}

async function stopGateway() {
  connected = undefined;
  for (const client of clients) client.stop();
  clients.clear();
  if (!child) return;
  const stopping = child;
  const closed = childClosed;
  if (stopping.exitCode === null && stopping.signalCode === null) stopping.kill();
  await waitUntil(() => stopping.exitCode !== null || stopping.signalCode !== null,
    'Gateway process exits', 30_000).catch(() => stopping.kill('SIGKILL'));
  await closed;
  child = undefined;
  assert.equal(process.pid, parentProcessId);
}

try {
  for (const directory of [source, installed, state, empty]) await mkdir(directory, { recursive: true });
  assert.equal((await readFile(path.join(runtime, 'dist/plugin-sdk/plugin-runtime.js'), 'utf8'))
    .includes('capturePublishedGatewayPluginRuntime'), false, 'No feature Native patch API');
  assert.equal(existsSync(path.join(runtime, 'dist/native-support/app-plugin-runtime.mjs')), false);
  check('no-feature-native-patch-or-instrumentation');
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = {
    OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_BUNDLED_PLUGINS_DIR: empty, OPENCLAW_DISABLE_BUNDLED_PLUGINS: '0',
    OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1',
    OPENCLAW_TEST_MINIMAL_GATEWAY: '0', VITEST: 'true',
    NODE_COMPILE_CACHE: path.join(work, 'compile-cache'),
  };
  const offlineLog = path.join(work, 'offline-attempts.jsonl');
  if (offline) {
    await writeFile(offlineLog, '');
    const guard = path.join(import.meta.dirname, 'block-public-network.cjs');
    env.APP_PLUGIN_OFFLINE_ATTEMPT_LOG = offlineLog;
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require "${guard.replaceAll('\\', '/')}"`.trim();
  }
  for (const [key, value] of Object.entries(env)) {
    savedEnv.set(key, process.env[key]); process.env[key] = value;
  }
  if (offline) createRequire(import.meta.url)('./block-public-network.cjs');
  const { GatewayClient } = await import(pathToFileURL(
    path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js')).href);
  async function connect(scopes = ['operator.admin', 'operator.read', 'operator.write'], mode = 'backend', deviceIdentity = null, paired = false) {
    let client;
    try { await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gateway client connection timeout')), 15_000);
      client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token, deviceIdentity,
        instanceId: randomUUID(),
        sharedStateMode: 'read-only', clientName: deviceIdentity ? 'cli' : 'gateway-client', clientVersion: 'app-sdk-probe',
        role: 'operator', mode, scopes, requestTimeoutMs: 15_000,
        onHelloOk: () => { clearTimeout(timer); resolve(); },
        onConnectError: error => { clearTimeout(timer); reject(error); },
        onEvent: event => { if (client === connected) for (const listener of nativeListeners) listener(event); },
      });
      clients.add(client); client.start();
    }); } catch (error) {
      if (!deviceIdentity || paired || !connected || !/pair/i.test(error.message)) throw error;
      client.stop(); clients.delete(client);
      const inventory = await connected.request('device.pair.list', {});
      const pending = inventory.pending.find(item => item.deviceId === deviceIdentity.deviceId);
      assert.ok(pending, 'Native device pairing request exists');
      await connected.request('device.pair.approve', { requestId: pending.requestId });
      return connect(scopes, mode, deviceIdentity, true);
    }
    return client;
  }
  async function writeConfig() {
    await writeFile(configPath, JSON.stringify({
      gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token } },
      logging: { file: path.join(work, 'native.log'), level: 'debug', consoleLevel: 'info' },
      update: { checkOnStart: false, auto: { enabled: false } },
      discovery: { mdns: { mode: 'off' } },
      models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: {} },
      agents: { entries: { main: {} }, defaults: { workspace: path.join(work, 'workspace'),
        skipBootstrap: true, heartbeat: { every: '0m' } } },
      plugins: { slots: { memory: 'none' }, allow: [id], load: { paths: [installed] }, entries: { [id]: { enabled: desired } } },
    }));
  }
  async function startGateway() {
    await writeConfig();
    const entry = path.join(runtime, bundled ? 'gateway-launcher.cjs' :
      existsSync(path.join(runtime, 'openclaw.mjs')) ? 'openclaw.mjs' : 'dist/entry.js');
    assert.ok(existsSync(entry), `Gateway entry exists: ${entry}`);
    child = spawn(process.execPath, [entry, 'gateway', 'run', '--allow-unconfigured',
      '--port', String(port), '--bind', 'loopback'], {
      cwd: work, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ...env },
    });
    childClosed = new Promise(resolve => child.once('close', resolve));
    child.once('error', error => { log += error.message; });
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', bytes => { log = (log + bytes).slice(-18_000); });
    await waitUntil(async () => {
      if (child.exitCode !== null) throw new Error('Gateway exited before readiness');
      try { return (await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, 'Gateway becomes ready', 110_000);
    generation++;
    connected = await connect();
    nativeClient = host.bindPluginGatewayClient(connected);
  }
  async function prepareVersion(version) {
    await writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: id, version, type: 'module', openclaw: { extensions: ['./index.ts'] },
      app: { main: 'main.ts', browser: 'browser.ts' },
    }));
    await writeFile(path.join(source, 'app.plugin.json'), JSON.stringify({
      manifestVersion: 1, apiVersion: 1, id, nativePluginId: id, version,
      entries: { main: 'main.mjs', browser: 'browser.mjs' },
      capabilities: ['assistants.create'], commands: ['effect', 'create-assistant'], slots: [],
    }));
    await writeFile(path.join(source, 'openclaw.plugin.json'), JSON.stringify({
      id, activation: { onStartup: true }, configSchema: { type: 'object', properties: {} },
    }));
    await writeFile(path.join(source, 'main.ts'), `export function register(host) { return {
      commands: [{ id: 'effect', invoke: async label => ({ success: true,
        value: await host.requestGateway('appProbe.effect', { label }) }) },
        { id: 'create-assistant', invoke: input => host.createAssistant(input, input.name, () => {}) }
      ] }; }`);
    await writeFile(path.join(source, 'browser.ts'), 'export function register() {}');
    await writeFile(path.join(source, 'index.ts'), `
      import { existsSync, writeFileSync } from 'node:fs';
      import { setTimeout as delay } from 'node:timers/promises';
      export default { id: ${JSON.stringify(id)}, register(api) {
        let effects = 0, acceptedEffects = 0;
        const options = { scope: 'operator.admin', profileAccess: 'independent' };
        api.registerGatewayMethod('appProbe.identity', opts => opts.respond(true, {
          connectionId: opts.client?.connId, scopes: opts.client?.connect.scopes,
          mode: opts.client?.connect.client.mode, effects, acceptedEffects, version: ${JSON.stringify(version)},
          callerCurrent: opts.hasCurrentClientAuthority?.(),
          configSettled: opts.context.isConfigReloadSettled(), signalAborted: api.lifecycle.signal?.aborted,
        }), options);
        api.registerGatewayMethod('appProbe.effect', async opts => {
          try {
          if (opts.params.gate) {
            writeFileSync(opts.params.gate + '.entered', 'entered');
            while (!existsSync(opts.params.gate + '.release')) await delay(10);
          }
          try {
            if (!opts.hasCurrentClientAuthority?.()) throw new Error('Native caller authority revoked');
            opts.sessionMutationCommitGuard?.();
          }
          catch (error) { if (opts.params.gate) writeFileSync(opts.params.gate + '.denied', 'denied'); throw error; }
          effects++;
          if (opts.params.afterCommitDelay) await delay(opts.params.afterCommitDelay);
          if (opts.params.throwAfterCommit) throw new Error('Fixture post-commit transport loss');
          opts.respond(true, { effects, version: ${JSON.stringify(version)} });
          } finally { if (opts.params.gate) writeFileSync(opts.params.gate + '.settled', 'settled'); }
        }, options);
        api.registerGatewayMethod('appProbe.accepted', async opts => {
          opts.respond(true, { status: 'accepted' });
          writeFileSync(opts.params.gate + '.entered', JSON.stringify({ method: opts.req.method,
            hasCommitGuard: typeof opts.sessionMutationCommitGuard === 'function' }));
          try {
            while (!existsSync(opts.params.gate + '.release')) await delay(10);
            try {
              if (!opts.hasCurrentClientAuthority?.()) throw new Error('Native caller authority revoked');
              opts.sessionMutationCommitGuard?.();
            }
            catch (error) { writeFileSync(opts.params.gate + '.denied', 'denied'); throw error; }
            acceptedEffects++;
          } finally { writeFileSync(opts.params.gate + '.settled', 'settled'); }
        }, options);
        api.registerGatewayMethod('appProbe.session', opts => { effects++; opts.respond(true); }, {
          scope: 'operator.write', profileAccess: 'required',
          sessionAccess: { mode: 'write', requiredTool: 'read' },
        });
        api.registerGatewayMethod('appProbe.deny', opts => opts.respond(false, undefined, {
          code: 'INVALID_REQUEST', message: 'Fixture target denied',
          details: { nativeTarget: true }, retryable: false, retryAfterMs: 7,
        }), options);
      } };
    `);
    return buildAppPlugin(source, path.join(work, 'artifacts'));
  }
  await build({ stdin: { contents: `
    export {AppPluginManager} from './src/main/plugins/app/manager';
    export {bindPluginGatewayClient,runWithPluginRequestBinding} from './src/main/engine/gateway/pluginRequestBinding';
    export {NativeAssistantCreation} from './src/main/openclaw/config/agents/nativeAssistantCreation';
    export {isGatewayRequestOutcomeUnknown} from './src/shared/openclaw/gatewayRequestOutcome';`,
    resolveDir: repo, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
    outfile: path.join(work, 'host.cjs'), logLevel: 'silent' });
  host = createRequire(import.meta.url)(path.join(work, 'host.cjs'));
  selected = await prepareVersion('1.0.0');
  await cp(selected.packageRoot, installed, { recursive: true });
  await startGateway();
  // Only product metadata uses a fixture port. Native config, profiles, role files,
  // authenticated requests, public SDK and Main admission below are all real.
  const profiles = new Map(), records = new Map(), nativeCalls = [];
  const metadata = {
    transaction: operation => operation,
    prepare: sql => ({
      get: key => records.has(key) ? { value: records.get(key) } : undefined,
      run: (...args) => {
        if (sql.startsWith('INSERT')) records.set(args[0], args[1]);
        else if (sql.startsWith('UPDATE')) records.set(args[2], args[0]);
        else throw new Error('Unexpected fixture metadata write');
      },
    }),
  };
  let creationLane = Promise.resolve();
  const creation = new host.NativeAssistantCreation({
    getDatabase: () => metadata,
    getStore: () => ({ getAgent: key => profiles.get(key),
      listAgents: () => [...profiles.values()],
      saveAgentProfile: profile => profiles.set(profile.id, profile) }),
    getStateDir: () => state,
    exclusive: operation => {
      const next = creationLane.catch(() => {}).then(operation); creationLane = next; return next;
    },
    requestGateway: (method, params) => {
      nativeCalls.push({ method, params }); return nativeClient.request(method, params);
    },
    onChanged: () => {},
  });
  manager = new host.AppPluginManager({ retentionRoot: path.join(work, 'retained'),
    resources: { requestConnectedGateway: (...args) => nativeClient.request(...args),
      requestGateway: (...args) => nativeClient.request(...args), ensureReady: startGateway,
      createAssistant: (...args) => creation.create(...args),
      onNativeEvent: listener => { nativeListeners.add(listener); return () => nativeListeners.delete(listener); } },
    candidates: async () => [{ root: path.join(installed, 'app'), nativeRoot: installed, trusted: true }],
    readDesiredEnabled: () => desired, isGatewayConnected: () => !!connected,
    getGatewayProcessId: () => child?.pid ?? null, getGatewayProcessGeneration: () => generation,
    broadcast: () => {}, withStoppedGateway: async operation => { await stopGateway(); return operation(); },
  });
  await manager.prepare(); await manager.activate(); await manager.refresh();
  await waitUntil(() => manager.snapshot()[0].state === 'active',
    'Main automatically admits a settled Native registration');
  const raw = await connect();
  const handshakeMethod = `${id}.app.handshake`;
  const dispatchMethod = `${id}.app.dispatch`;
  async function receipt(client) {
    let value, stableSince = 0;
    try {
      await waitUntil(async () => {
        try {
          const next = await client.request(handshakeMethod, {});
          if (next.registrationId !== value?.registrationId || !stableSince) stableSince = Date.now();
          value = next;
          return Date.now() - stableSince >= 600;
        } catch { stableSince = 0; return false; }
      }, 'current Native registration handshake');
    } catch (error) {
      console.error(JSON.stringify({ publicIdentity: await client.request('appProbe.identity', {}).catch(() => null) }));
      throw error;
    }
    return value;
  }
  const inventory = await raw.request('plugins.list', {});
  assert.notEqual(inventory.plugins.find(plugin => plugin.id === id)?.origin, 'bundled');
  let first = await receipt(connected);
  assert.equal(first.processId, child.pid);
  assert.equal(realpathSync(first.nativeEntry), realpathSync(path.join(installed, 'index.js')));
  assert.equal(first.sourceSha256, sha(await readFile(path.join(installed, 'index.js'))));
  await manager.refresh();
  check('external-auto-bridge-handshake-pid-and-source-receipt');
  const bound = (method, params = {}, options) => host.runWithPluginRequestBinding(binding(first),
    () => {}, () => nativeClient.request(method, params, options));
  const identity = await raw.request('appProbe.identity', {});
  const canonicalIdentity = await connected.request('appProbe.identity', {});
  try {
    assert.equal((await bound('appProbe.identity')).connectionId, canonicalIdentity.connectionId);
  } catch (error) {
    console.error(JSON.stringify({ receipt: first, canonicalIdentity,
      currentReceipt: await connected.request(handshakeMethod, {}).catch(() => null) }));
    throw error;
  }
  assert.deepEqual((await bound('appProbe.identity')).scopes, identity.scopes);
  check('direct-alias-retains-authenticated-client');
  await waitUntil(async () => {
    try { first = await receipt(connected); return (await bound('health')).ok === true; }
    catch { return false; }
  }, 'read-only Core health recovers after config activation');
  await manager.refresh();
  check('core-rpc-still-uses-public-native-dispatcher');
  if (assistantConfigReload) {
    const before = manager.snapshot()[0];
    const processId = child.pid;
    const configEvents = [];
    const recordChange = event => { if (event.event === 'config.changed') configEvents.push(event); };
    nativeListeners.add(recordChange);
    const inputs = [1, 2, 3].map(number => ({ name: `Assistant ${number}`,
      description: 'Isolated configuration reload regression', instructions: `Role ${number}` }));
    const created = await Promise.all(inputs.map(input => manager.invoke({
      id, epoch: before.epoch, command: 'create-assistant', args: [input],
    })));
    assert.ok(created.every(result => result.status === 'created'),
      JSON.stringify(created.map(result => ({ status: result.status, error: result.error }))));
    await waitUntil(() => configEvents.length > 0, 'real assistant config hot reload published');
    await manager.refresh();
    assert.equal(manager.snapshot()[0].epoch, before.epoch, 'Unrelated config reload keeps Main owner');
    assert.equal(manager.snapshot()[0].state, 'active');
    assert.equal((await raw.request(handshakeMethod, {})).registrationId, first.registrationId);
    assert.equal(child.pid, processId, 'Assistant creation never restarts Gateway');
    assert.equal(generation, 1);
    assert.equal(nativeCalls.filter(call => call.method === 'agents.create').length, 3);
    assert.equal(nativeCalls.filter(call => call.method === 'agents.update').length, 3);
    assert.equal(nativeCalls.filter(call => call.method === 'agents.files.set').length, 3);
    assert.equal(profiles.size, 3);
    assert.ok([...profiles.values()].every(profile => profile.enabled));
    for (const [index, result] of created.entries()) {
      const file = await bound('agents.files.get', { agentId: result.agentId, name: 'AGENTS.md' });
      assert.equal(file.file.content, inputs[index].instructions);
    }
    nativeListeners.delete(recordChange);
    check('three-queued-assistant-creations-preserve-role-files-epoch-and-gateway-pid');
  } else {
  const nativeGuardPresence = [];
  for (const request of [(method, params) => raw.request(method, params), bound]) {
    first = await receipt(connected);
    const gate = path.join(work, 'accepted-' + checks.length + '-' + randomUUID());
    assert.equal((await request('appProbe.accepted', { gate })).status, 'accepted');
    await waitUntil(() => existsSync(gate + '.entered'), 'early ACK target entered');
    const entered = JSON.parse(await readFile(gate + '.entered', 'utf8'));
    assert.equal(entered.method, 'appProbe.accepted'); nativeGuardPresence.push(entered.hasCommitGuard);
    await writeFile(gate + '.release', 'release');
    await waitUntil(() => existsSync(gate + '.settled'), 'early ACK target retained full Native handler');
    assert.equal(existsSync(gate + '.denied'), false);
  }
  assert.equal(nativeGuardPresence[1], nativeGuardPresence[0], 'Alias preserves optional Native guard presence');
  assert.equal((await raw.request('appProbe.identity', {})).acceptedEffects, 2);
  check('raw-and-alias-early-ack-retain-post-await-native-authority');
  const invoke = () => manager.invoke({ id, epoch: manager.snapshot()[0].epoch,
    command: 'effect', args: ['one-effect'] });
  assert.deepEqual(await invoke(), { success: true, value: { effects: 1, version: '1.0.0' } });
  check('real-main-manager-and-native-mutation-once');
  for (const override of [{ registrationId: 'retired' }, { processId: first.processId + 1 }])
    await assert.rejects(raw.request(dispatchMethod, { registrationId: first.registrationId,
      processId: first.processId, method: 'appProbe.effect', ...override }));
  assert.equal((await raw.request('appProbe.identity', {})).effects, 1);
  check('forged-registration-and-process-rejected-without-effect');
  const readOnly = await connect(['operator.read']);
  await assert.rejects(readOnly.request(dispatchMethod, { registrationId: first.registrationId,
    processId: first.processId, method: 'appProbe.effect' }), /scope|permission|authoriz/i);
  await assert.rejects(bound('appProbe.deny'), error => {
    assert.equal(error.code ?? error.gatewayCode, 'INVALID_REQUEST');
    assert.deepEqual(error.details, { nativeTarget: true });
    assert.equal(error.retryable, false); assert.equal(error.retryAfterMs, 7);
    assert.equal(host.isGatewayRequestOutcomeUnknown(error), false); return true;
  });
  check('target-native-rejection-metadata-and-caller-permissions-preserved');
  for (const request of [(method, params) => raw.request(method, params), bound])
    await assert.rejects(request('appProbe.session', { sessionKey: 'missing-session' }));
  assert.equal((await raw.request('appProbe.identity', {})).effects, 1);
  check('alias-retains-actual-native-profile-and-session-admission');
  // Deliberately give the outer transport a longer deadline so this observes the
  // server's actual uncertainty marker, rather than an earlier socket timeout.
  let marked = false;
  const timeoutReceipt = await receipt(raw);
  const longerOuterDeadline = host.bindPluginGatewayClient({
    request: async (method, params, options) => {
      try { return await raw.request(method, params, { ...options, timeoutMs: 2000 }); }
      catch (error) { marked = error.details?.kind === APP_NATIVE_UNKNOWN_OUTCOME; throw error; }
    },
  });
  await assert.rejects(host.runWithPluginRequestBinding(binding(timeoutReceipt), () => {}, () =>
    longerOuterDeadline.request('appProbe.effect', { afterCommitDelay: 70, throwAfterCommit: true })),
    error => { assert.equal(host.isGatewayRequestOutcomeUnknown(error), true); return true; });
  assert.equal(marked, true, 'Actual Native error carries the unknown-outcome marker');
  await waitUntil(async () => (await raw.request('appProbe.identity', {})).effects === 2,
    'one committed effect despite unknown outcome');
  await delay(450);
  assert.equal((await raw.request('appProbe.identity', {})).effects, 2);
  check('committed-alias-throw-remains-unknown-without-retry');
  const keys = generateKeyPairSync('ed25519');
  const deviceIdentity = {
    deviceId: sha(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)),
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  const disconnected = await connect(undefined, 'backend', deviceIdentity);
  const disconnectedReceipt = await receipt(disconnected);
  const disconnectedBound = host.bindPluginGatewayClient(disconnected);
  const gate = path.join(work, 'disconnect-gate');
  const pending = host.runWithPluginRequestBinding(binding(disconnectedReceipt), () => {}, () =>
    disconnectedBound.request('appProbe.effect', { gate })).catch(error => error);
  await waitUntil(() => existsSync(gate + '.entered'), 'nested target entered before disconnect');
  await disconnected.stopAndWait({ timeoutMs: 2000 }); clients.delete(disconnected);
  await raw.request('device.token.revoke', { deviceId: deviceIdentity.deviceId, role: 'operator' });
  await writeFile(gate + '.release', 'release');
  assert.equal(host.isGatewayRequestOutcomeUnknown(await pending), true);
  await waitUntil(() => existsSync(gate + '.settled'), 'revoked target actually attempted its Native commit guard');
  assert.ok(existsSync(gate + '.denied'), 'Actual Native commit guard rejected revoked caller');
  assert.equal((await raw.request('appProbe.identity', {})).effects, 2);
  check('native-caller-authority-fences-disconnected-post-await-mutation');
  const acceptedDevice = await connect(undefined, 'backend', deviceIdentity);
  const acceptedReceipt = await receipt(acceptedDevice);
  const acceptedClient = host.bindPluginGatewayClient(acceptedDevice);
  const acceptedGate = path.join(work, 'accepted-revoked');
  assert.equal((await host.runWithPluginRequestBinding(binding(acceptedReceipt), () => {}, () =>
    acceptedClient.request('appProbe.accepted', { gate: acceptedGate }))).status, 'accepted');
  await waitUntil(() => existsSync(acceptedGate + '.entered'), 'accepted target waiting before revocation');
  await acceptedDevice.stopAndWait({ timeoutMs: 2000 }); clients.delete(acceptedDevice);
  await raw.request('device.token.revoke', { deviceId: deviceIdentity.deviceId, role: 'operator' });
  await writeFile(acceptedGate + '.release', 'release');
  await waitUntil(() => existsSync(acceptedGate + '.settled'), 'accepted revoked target attempted its commit guard');
  assert.equal(existsSync(acceptedGate + '.denied'), true);
  assert.equal((await raw.request('appProbe.identity', {})).acceptedEffects, 2);
  check('early-ack-does-not-bypass-actual-native-device-revocation');
  await writeFile(path.join(installed, 'index.js'),
    (await readFile(path.join(installed, 'index.js'), 'utf8')) + '\n// changed while live\n');
  assert.equal((await raw.request(handshakeMethod, {})).sourceSha256, first.sourceSha256);
  await manager.refresh(); assert.notEqual(manager.snapshot()[0].state, 'active');
  check('live-disk-edit-cannot-replace-registration-receipt-or-admit-main');
  await cp(path.join(selected.packageRoot, 'index.js'), path.join(installed, 'index.js'));
  await manager.refresh();
  const oldEpoch = manager.snapshot()[0].epoch;
  await manager.mutatePackage(async () => { desired = false; await writeConfig(); });
  assert.notEqual(manager.snapshot()[0].state, 'active');
  await assert.rejects(connected.request(handshakeMethod, {}));
  await manager.mutatePackage(async () => { desired = true; await writeConfig(); });
  assert.equal(manager.snapshot()[0].state, 'active');
  assert.equal((await manager.invoke({ id, epoch: oldEpoch, command: 'effect', args: [] })).success, false);
  check('disable-and-enable-restart-only-gateway-with-fresh-main-epoch');
  const replacement = await prepareVersion('2.0.0');
  await manager.mutatePackage(async () => {
    await cp(replacement.packageRoot, installed, { recursive: true }); selected = replacement;
  });
  assert.equal(manager.snapshot()[0].version, '2.0.0');
  assert.deepEqual(await invoke(), { success: true, value: { effects: 1, version: '2.0.0' } });
  await assert.rejects(host.runWithPluginRequestBinding(binding(first), () => {}, () =>
    nativeClient.request('appProbe.effect', {})));
  assert.equal((await connected.request('appProbe.identity', {})).effects, 1);
  assert.equal(process.pid, parentProcessId);
  check('plugin-version-replacement-and-old-lease-rejection-without-app-restart');
  }
  manager.dispose();
  await stopGateway();
  if (offline) {
    assert.equal(await readFile(offlineLog, 'utf8'), '', 'No public network operation was attempted');
    check('fresh-private-cache-and-public-network-blocked');
  }
  console.log(JSON.stringify({ passed: true, gatewayBundle: bundled, publicNetworkBlocked: offline,
    assistantConfigReload,
    runtime: { node: process.versions.node, electron: process.versions.electron ?? null }, checks,
    scope: 'Real isolated Native Gateway/public SDK/Main manager; fixture mutations, no model or installed-app UI acceptance.' }));
} catch (error) {
  if (assistantConfigReload && connected) console.error(JSON.stringify({
    admission: manager?.snapshot(),
    nativeIdentity: await connected.request('appProbe.identity', {}).catch(error => ({ error: error.message })),
    handshake: await connected.request(`${id}.app.handshake`, {}).catch(error => ({ error: error.message })),
  }));
  console.error(log); throw error;
} finally {
  manager?.dispose();
  await stopGateway();
  for (const [key, value] of savedEnv)
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  assert.equal(path.dirname(path.resolve(work)), path.resolve(tmpdir()));
  assert.match(path.basename(work), /^app-native-gateway-/u);
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
