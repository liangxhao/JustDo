// Real Electron Main, preload, Vite transformation, UI, SQLite and Gateway.
// No model request, user configuration, test bridge or replacement app registry.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

import { prepareDevelopmentAppPlugins } from '../../plugins/prepare-development-app-plugins.mjs';
import { appPluginAssetsPlugin } from '../../plugins/vite-app-plugin-assets.mjs';
import { DEVELOPMENT_APPLICATION_BODY_COMPLETE, prepareDevelopmentProjectBaseline, projectDevelopmentRuntime,
  waitForDevelopmentApplication } from './project-development-runtime.mjs';

const repo = path.resolve(import.meta.dirname, '../../..');
assert.equal(
  process.platform,
  'win32',
  'This probe currently validates Windows Gateway process ownership',
);
const require = createRequire(import.meta.url);
const electronShutdown = require('../../electron/electron-shutdown.cjs');
const args = process.argv.slice(2);
assert.ok(args.length === 0 ||
  (args.length === 2 && args[0] === '--runtime' && args[1]), 'Use --runtime <prepared-runtime>');
await mkdir(path.join(repo, '.work'), { recursive: true });
const root = await mkdtemp(path.join(repo, '.work', 'app-plugin-hot-'));
const profile = path.join(root, 'profile');
const resultFile = path.join(root, 'result.json');
const profileStore = path.join(root, 'profile-store.cjs');
const marker = path.join(repo, 'dist-electron/.electron-ready');
const net = createNetServer();
await new Promise(resolve => net.listen(0, '127.0.0.1', resolve));
const port = net.address().port;
const gatewayReservation = createNetServer();
await new Promise(resolve => gatewayReservation.listen(0, '127.0.0.1', resolve));
const gatewayPort = gatewayReservation.address().port;
await new Promise(resolve => net.close(resolve));
const runtimeProjection = args.length
  ? await projectDevelopmentRuntime({ repo, root, runtime: args[1] }) : undefined;
const appRoot = runtimeProjection?.appRoot ?? repo;
if (!runtimeProjection) prepareDevelopmentAppPlugins();
await mkdir(path.join(profile, 'openclaw/state'), { recursive: true });
await mkdir(path.join(profile, 'project'), { recursive: true });
const projectBaseline = await prepareDevelopmentProjectBaseline({ repo, root });
// Seed a real current-generation store in Electron before Main classifies startup.
// A hand-made kv-only database is correctly rejected by the history admission gate.
await build({
  stdin: {
    contents: `export { SqliteStore } from './src/main/data/sqliteStore';
      export { classifyInstallation } from './src/main/startup/routing/classifyInstallation';`,
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'better-sqlite3'],
  outfile: profileStore,
});
await writeFile(
  path.join(profile, 'openclaw/state/openclaw.json'),
  JSON.stringify({
    update: { checkOnStart: false, auto: { enabled: false } },
    discovery: { mdns: { mode: 'off' } },
    models: { catalogRefresh: { enabled: false } },
    gateway: { mode: 'local', bind: 'loopback', port: gatewayPort },
    plugins: { entries: { 'agent-team': { enabled: true }, 'swarm-workflow': { enabled: true } } },
  }),
);
// This is the existing Main setting used by the normal Gateway port controls.
await writeFile(path.join(profile, 'openclaw/state/gateway-port.json'),
  JSON.stringify({ port: gatewayPort, updatedAt: Date.now() }));
const origin = `http://localhost:${port}`;
const context = path.join(root, 'context.json');
await writeFile(context, JSON.stringify({ repo, root, appRoot, profile, origin, gatewayPort, resultFile, profileStore,
  projectBaseline,
  bodyCompleteSignal: DEVELOPMENT_APPLICATION_BODY_COMPLETE,
  ...(runtimeProjection ? { runtimeProjection } : {}) }));
const guard = path.join(import.meta.dirname, 'block-public-network.cjs');
Object.assign(process.env, {
  NODE_ENV: 'development',
  JUSTDO_DEV_SERVER_PORT: String(port),
  JUSTDO_DEV_USER_DATA_DIR: profile,
  ELECTRON_START_URL: origin,
  ELECTRON_RUN_AS_NODE: '1',
  OPENCLAW_SKIP_CHANNELS: '1',
  OPENCLAW_SKIP_CRON: '1',
  OPENCLAW_HOME: path.join(profile, 'home'),
  OPENCLAW_STATE_DIR: path.join(profile, 'openclaw/state'),
  OPENCLAW_CONFIG_PATH: path.join(profile, 'openclaw/state/openclaw.json'),
  OPENCLAW_PROFILE: 'default',
  NODE_COMPILE_CACHE: path.join(root, 'compile-cache'),
  APP_PLUGIN_OFFLINE_ATTEMPT_LOG: path.join(root, 'offline-attempts.jsonl'),
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(guard.replaceAll('\\', '/'))}`,
  APP_PLUGIN_TEST_CONTEXT: context,
});
await rm(marker, { force: true });
const { createServer } = await import('vite');
let server;
let child;
const output = fs.createWriteStream(path.join(root, 'console.log'));
try {
  server = await createServer({
    configFile: path.join(repo, 'vite.config.mts'),
    // Use the production asset proxy against the private Main descriptor before
    // the unchanged repository Vite plugin sees the request.
    plugins: runtimeProjection ? [{ ...appPluginAssetsPlugin(appRoot),
      name: 'probe-private-app-assets', enforce: 'pre' }] : [],
    server: { port, strictPort: true },
  });
  await server.listen();
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await delay(100);
  assert.ok(fs.existsSync(marker), 'Fresh development Main bundle is ready before launch');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise(resolve => gatewayReservation.close(resolve));
  child = spawn(
    require('electron'),
    [
      path.join(import.meta.dirname, 'fixtures/development-application.cjs'),
      `--justdo-dev-server-url=${origin}`,
    ],
    { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  electronShutdown.observeElectron(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => output.write(data));
  child.on('message', message => {
    if (message?.type === 'app-plugin-test-check') console.log(JSON.stringify(message));
  });
  const code = await waitForDevelopmentApplication(child, {
    bodyTimeoutMs: 5 * 60_000,
    finishShutdown: owned => electronShutdown.stopElectron(owned),
  });
  assert.ok(fs.existsSync(resultFile), `Application exited without a result; see ${root}`);
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.success, true, JSON.stringify(result));
  console.log(JSON.stringify({ ...result, evidence: root }));
} finally {
  try {
    if (child?.exitCode === null && child.signalCode === null)
      await electronShutdown.stopElectron(child);
  } finally {
    if (gatewayReservation.listening)
      await new Promise(resolve => gatewayReservation.close(resolve));
    await Promise.race([server?.close(), delay(5000)]);
    output.end();
  }
}
// vite-plugin-electron can retain build watchers after its server has closed.
process.exit(0);
