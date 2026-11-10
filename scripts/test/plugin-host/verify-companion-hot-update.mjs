// Opt-in Windows proof: official Native operations plus real Main/UI loading in Electron.
// <runtime>/node-runtime/node.exe this-file <prepared-runtime>
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { buildAppPlugin } from '../../plugins/build-app-plugins.mjs';

const repo = path.resolve(import.meta.dirname, '../../..'), require = createRequire(import.meta.url);
const execute = promisify(execFile), runtime = fs.realpathSync(path.resolve(process.argv[2]));
const { verifyFrozenOpenClawRuntime } = require('../../openclaw/verify-openclaw-runtime-patches.cjs');
const { buildInfo, manifest } = verifyFrozenOpenClawRuntime(runtime, { requireBundle: true,
  expectedVersion: require(path.join(repo, 'package.json')).openclaw.version, expectedTarget: 'win-x64' });
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(runtime, 'node-runtime/node.exe')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const workRoot = path.join(repo, 'build', 'plugin-probes'); fs.mkdirSync(workRoot, { recursive: true });
const work = fs.mkdtempSync(path.join(workRoot, 'companion-hot-'));
const source = path.join(work, 'source'), state = path.join(work, 'state'), empty = path.join(work, 'empty');
for (const directory of [source, state, empty, path.join(work, 'workspace')]) fs.mkdirSync(directory);
fs.writeFileSync(path.join(empty, 'catalog.json'), '[]');
const id = 'companion-hot-probe', installed = path.join(state, 'extensions', id), configPath = path.join(state, 'openclaw.json');
const token = randomBytes(24).toString('hex'), inherited = { ...process.env };
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:OPENCLAW_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/iu.test(key) && key.toUpperCase().replaceAll('-', '_') !== 'NPM_CONFIG_OFFLINE'));
Object.assign(env, { OPENCLAW_HOME: work, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_SDK_ROOT: path.join(runtime, 'dist/plugin-sdk'), OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1',
  OPENCLAW_DISABLE_BONJOUR: '1', NPM_CONFIG_UPDATE_NOTIFIER: 'false', npm_config_update_notifier: 'false' });
const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
let gateway, electron, client, closeState, hostIdentity, output = '', hello = 0, admissionWaits = 0,
  finished = false, forcedTeardown = false;
const messages = [], steps = [], nativeWrites = [];
const wait = async (predicate, label, timeout = 150000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 100)); }
};
const nextMessage = async kind => {
  await wait(() => { if (electron?.exitCode != null) throw new Error(`Electron exited before ${kind}`);
    return messages.some(item => item.kind === kind || item.kind === 'failed'); }, kind);
  const result = messages.splice(messages.findIndex(item => item.kind === kind || item.kind === 'failed'), 1)[0];
  if (result.kind === 'failed') throw new Error(result.error); return result;
};
const tree = root => fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
  .map(item => path.relative(root, path.join(item.parentPath, item.name))).sort();
try {
  for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('OPENCLAW_')) delete process.env[key];
  Object.assign(process.env, env);
  const packages = [];
  for (const [index, label] of ['A', 'B'].entries()) {
    const version = `1.0.${index}`;
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: id, version, type: 'module',
      openclaw: { extensions: ['./index.ts'] }, app: { main: 'main.ts', browser: 'browser.ts' } }));
    fs.writeFileSync(path.join(source, 'app.plugin.json'), JSON.stringify({ manifestVersion: 1, apiVersion: 1,
      id, nativePluginId: id, version, entries: { main: 'main.mjs', browser: 'browser.mjs' },
      commands: ['read'], slots: ['workspace.tab'], capabilities: [], data: { directory: 'managed-v1' } }));
    fs.writeFileSync(path.join(source, 'openclaw.plugin.json'), JSON.stringify({ id, activation: { onStartup: true },
      configSchema: { type: 'object', properties: { label: { type: 'string' } } } }));
    fs.writeFileSync(path.join(source, 'index.ts'), `export default {id:${JSON.stringify(id)},register(api){api.registerGatewayMethod('companionProbe.identity',({respond,client})=>respond(true,{label:${JSON.stringify(label)},connectionId:client?.connId}));}};`);
    fs.writeFileSync(path.join(source, 'main.ts'), `export function register(){return {commands:[{id:'read',invoke:()=>({success:true,value:${JSON.stringify(label)}})}]};}`);
    fs.writeFileSync(path.join(source, 'browser.ts'), `export function register(host){host.registerView({id:'view',slot:'workspace.tab',labelKey:'fixture',component:()=>${JSON.stringify(label)}});}`);
    const item = await buildAppPlugin(source, path.join(work, 'artifacts'));
    const { ZipFile } = require('yazl'); const zip = new ZipFile();
    for (const name of tree(item.packageRoot)) zip.addFile(path.join(item.packageRoot, name), `package/${name.replaceAll('\\', '/')}`);
    const archive = path.join(work, `${label}.zip`), writing = pipeline(zip.outputStream, fs.createWriteStream(archive)); zip.end(); await writing;
    packages.push({ ...item, label, version, archive });
  }
  const hostFile = path.join(work, 'host.cjs');
  await build({ stdin: { resolveDir: repo, loader: 'ts', contents: `
    export {AppPluginManager,discoverAppCandidates} from './src/main/plugins/app/manager';
    export {AppApprovalStore} from './src/main/plugins/app/approvalStore';
    export {readAppAsset} from './src/main/plugins/app/assets';
    export {ExtensionPackageLifecycleMode} from './src/main/plugins/extensions/extensionPackageLifecycle';
    export {bindPluginGatewayClient} from './src/main/engine/gateway/pluginRequestBinding';
    export {ensureGatewayShutdownPreload,OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE} from './src/main/openclaw/runtime/launch/openclawLauncher';
    export {runExtensionCommand} from './src/main/plugins/extensions/extensionCommand';
    export {requestNativePluginMutation} from './src/main/plugins/extensions/nativePluginMutation';` },
    outfile: hostFile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
  hostIdentity = { repo, bundleSha256: sha(fs.readFileSync(hostFile)), files: Object.fromEntries(
    ['src/main/plugins/app/manager.ts', 'src/main/plugins/app/registry.ts'].map(file => [file, sha(fs.readFileSync(path.join(repo, file)))])) };
  fs.writeFileSync(path.join(work, 'host-identity.json'), JSON.stringify(hostIdentity));
  const harness = path.join(work, 'harness.mjs');
  await build({ stdin: { resolveDir: repo, loader: 'ts', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {AppBrowserRegistry} from './src/renderer/features/plugins/app/browserRegistry';
    const registry=new AppBrowserRegistry({snapshot:async()=>[],onChanged:()=>()=>{},onEvent:()=>()=>{},invoke:async()=>({success:false})},
      {t:key=>key,translations:()=>()=>{},components:{},renderHistory:()=>null});
    const root=createRoot(document.getElementById('root'));
    window.renderCompanion=async()=>{await registry.update(await(await fetch('/snapshot')).json());
      const views=registry.getViews().map(view=>React.createElement(view.component,{key:view.epoch}));
      flushSync(()=>root.render(React.createElement(React.Fragment,null,...views)));
      return {text:document.body.textContent,nodeUnavailable:typeof window.require==='undefined'};};` },
    outfile: harness, bundle: true, platform: 'browser', format: 'esm', loader: { '.md': 'text' }, logLevel: 'silent' });
  const host = require(hostFile);
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: 'local', port, auth: { mode: 'token', token } },
    logging: { file: path.join(work, 'gateway.log') }, update: { checkOnStart: false, auto: { enabled: false } },
    discovery: { mdns: { mode: 'off' } }, models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: {} },
    agents: { entries: { main: {} }, defaults: { workspace: path.join(work, 'workspace'), skipBootstrap: true, heartbeat: { every: '0m' } } },
    plugins: { slots: { memory: 'none' }, allow: [id], entries: { acpx: { enabled: false } } } }));
  const { buildOpenClawCompileCacheEnvironment, GATEWAY_READY_MESSAGE } = require(path.join(repo, 'src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs'));
  async function startGateway() {
    assert.equal(gateway, undefined, 'Only one Gateway process may start');
    gateway = spawn(process.execPath, ['--require', host.ensureGatewayShutdownPreload(work), path.join(runtime, 'gateway-launcher.cjs'),
      'gateway', 'run', '--allow-unconfigured', '--port', String(port)], { cwd: work,
      env: buildOpenClawCompileCacheEnvironment(env, path.join(work, 'compile-cache')), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-24000); });
    await wait(async () => { if (gateway.exitCode !== null) throw new Error('Gateway exited before ready');
      try { return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 'Gateway ready');
    let GatewayClient;
    for (const file of fs.readdirSync(path.join(runtime, 'dist')).filter(name => /^client-.*\.mjs$/.test(name))) {
      const text = fs.readFileSync(path.join(runtime, 'dist', file), 'utf8');
      const match = text.slice(text.lastIndexOf('\nexport {')).match(/\bGatewayClient(?: as (\w+))?\s*[,}]/);
      if (match) { GatewayClient = (await import(pathToFileURL(path.join(runtime, 'dist', file)).href))[match[1] ?? 'GatewayClient']; break; }
    }
    client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token, env, clientName: 'gateway-client', mode: 'backend',
      scopes: ['operator.admin'], onHelloOk: () => { hello++; }, onEvent: value => electron?.connected && electron.send({ kind: 'event', value }) });
    client.start(); await wait(() => hello === 1, 'authenticated connection', 30000); gateway.send(GATEWAY_READY_MESSAGE);
    for (const file of fs.readdirSync(path.join(runtime, 'dist')).filter(name => /^openclaw-state-db-cache-.*\.mjs$/.test(name))) {
      closeState = Object.values(await import(pathToFileURL(path.join(runtime, 'dist', file)).href)).find(value =>
        typeof value === 'function' && value.name === 'closeOpenClawStateDatabaseAsync'); if (closeState) break;
    }
  }
  const fixtureFile = path.join(work, 'fixture.json'); fs.writeFileSync(fixtureFile, JSON.stringify({ work, host: hostFile,
    state, empty, installed, id, configPath, harness }));
  electron = spawn(require('electron'), [path.join(import.meta.dirname, 'fixtures/companion-hot-update.cjs'), fixtureFile],
    { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const stream of [electron.stdout, electron.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-24000); });
  electron.on('message', async message => {
    if (message.kind !== 'native') { messages.push(message); return; }
    try {
      let value;
      if (message.method === 'probe.install') {
        const result = await host.runExtensionCommand(process.execPath, [path.join(runtime, 'openclaw.mjs'), 'plugins', 'install', message.params.archive,
          '--force', '--no-enable', '--accept-capabilities'], { cwd: runtime, env, successPattern: new RegExp(`Installed plugin: ${id}`) });
        assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.nativeReceiptObserved, true);
        nativeWrites.push('offline-install'); value = { ok: true };
      } else {
        assert.equal(gateway.exitCode, null);
        const mutation = ['plugins.install', 'plugins.setEnabled', 'plugins.uninstall'].includes(message.method);
        if (mutation) nativeWrites.push(message.method);
        const capturedClient = client, pid = gateway.pid;
        value = mutation ? await host.requestNativePluginMutation(
          options => capturedClient.request(message.method, message.params, options), { timeoutMs: 90000 },
          () => client === capturedClient && gateway.pid === pid && gateway.exitCode === null && hello === 1,
          { onAdmissionWait: () => { admissionWaits++; } },
        ) : await client.request(message.method, message.params, { timeoutMs: 90000 });
      }
      if (electron.connected) electron.send({ kind: 'native-result', id: message.id, value });
    } catch (error) { if (electron.connected) electron.send({ kind: 'native-result', id: message.id, error: error.message }); }
  });
  const action = async (name, label, item) => {
    electron.send({ kind: 'action', action: name, label, item }); const result = await nextMessage('action-done');
    if (gateway) { assert.equal(gateway.exitCode, null); assert.equal(hello, 1); }
    steps.push({ action: name, label, hash: result.snapshot?.hash, state: result.snapshot?.state,
      epoch: result.snapshot?.epoch, pid: gateway?.pid, browser: result.browser, writes: result.writes, electron: result.electron });
    console.log('COMPANION_LIFECYCLE_STEP=' + JSON.stringify(steps.at(-1))); return result;
  };
  await nextMessage('ready'); await action('install', '', packages[0]);
  const config = JSON.parse(fs.readFileSync(configPath));
  config.plugins.entries[id] = { ...config.plugins.entries[id], enabled: false, config: { label: 'preserved' } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  await startGateway(); electron.send({ kind: 'connected', gateway: { pid: gateway.pid, generation: 1, connected: true } }); await nextMessage('connected');
  await action('enable', 'A'); const identityA = await client.request('companionProbe.identity', {}); assert.equal(identityA.label, 'A');
  const receiptA = await client.request(`${id}.app.handshake`, {});
  const sessionKey = 'agent:main:companion-hot-probe';
  await client.request('sessions.create', { key: sessionKey, cwd: path.join(work, 'workspace'), permissionMode: 'read-only' });
  const session = await client.request('sessions.describe', { key: sessionKey }); const sessionId = session.session?.sessionId ?? session.sessionId; assert.ok(sessionId);
  const history = path.join(state, 'plugin-data', id, 'history-sentinel.json'); fs.writeFileSync(history, '{"history":"preserved"}');
  const saved = JSON.parse(fs.readFileSync(configPath));
  await action('update', 'B', packages[1]);
  const identityB = await client.request('companionProbe.identity', {}); assert.equal(identityB.label, 'B'); assert.equal(identityB.connectionId, identityA.connectionId);
  const receiptB = await client.request(`${id}.app.handshake`, {}); assert.notEqual(receiptA.sourceSha256, receiptB.sourceSha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)).plugins.entries, saved.plugins.entries);
  await action('disable', ''); assert.equal(JSON.parse(fs.readFileSync(configPath)).plugins.entries[id].enabled, false);
  await action('enable', 'B'); assert.equal((await client.request('companionProbe.identity', {})).connectionId, identityA.connectionId);
  await action('uninstall', ''); assert.equal(fs.existsSync(installed), false);
  const after = JSON.parse(fs.readFileSync(configPath));
  assert.deepEqual(after.plugins.entries[id] ?? { enabled: false }, { enabled: false });
  assert.deepEqual(after.plugins.entries.acpx, saved.plugins.entries.acpx);
  for (const key of ['agents', 'models', 'update']) assert.deepEqual(after[key], saved[key]);
  assert.equal(fs.readFileSync(history, 'utf8'), '{"history":"preserved"}');
  const retained = await client.request('sessions.describe', { key: sessionKey }); assert.equal(retained.session?.sessionId ?? retained.sessionId, sessionId);
  assert.deepEqual(nativeWrites, ['offline-install', 'plugins.setEnabled', 'plugins.install', 'plugins.setEnabled', 'plugins.setEnabled', 'plugins.uninstall']);
  finished = true;
} finally {
  if (electron?.connected) { electron.send({ kind: 'finish' }); await wait(() => electron.exitCode !== null, 'Electron exit', 15000).catch(() => electron.kill()); }
  if (client) await client.stopAndWait().catch(() => client.stop());
  if (gateway?.exitCode === null) {
    gateway.send(require(path.join(work, 'host.cjs')).OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
    await wait(() => gateway.exitCode !== null, 'private Gateway exit', 30000).catch(async () => {
      forcedTeardown = true; await execute('taskkill', ['/pid', String(gateway.pid), '/T', '/F'], { windowsHide: true });
      await wait(() => gateway.exitCode !== null, 'owned Gateway exit', 10000);
    });
  }
  await closeState?.();
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify({ finished, forcedTeardown, steps, nativeWrites, admissionWaits,
    runtime: { root: runtime, verification: 'frozen-artifact', version: buildInfo.openclawVersion,
      recipe: buildInfo.buildRecipeSha256, bundle: manifest.gatewayBundle.sha256 }, host: hostIdentity,
    gatewayExit: { pid: gateway?.pid, code: gateway?.exitCode, signal: gateway?.signalCode }, electronExit: electron?.exitCode }, null, 2));
  fs.writeFileSync(path.join(work, 'probe.log'), output.replaceAll(token, '<fixture-token>'));
  for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key]; Object.assign(process.env, inherited);
  console.log('COMPANION_LIFECYCLE_RESULT=' + path.join(work, 'result.json'));
}
assert.equal(finished, true);
