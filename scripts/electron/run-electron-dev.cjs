const { spawn } = require('child_process');
const path = require('path');
const {
  devServer: { port },
} = require('../../package.json');
const { findFreePort } = require('./find-free-port.cjs');
const {
  prepareBrowserExtensionDevHost,
} = require('../browser/prepare-browser-extension-dev-host.cjs');
const { prepareMulticaDevAgent } = require('../multica/create-multica-dev-agent.cjs');
const { launchElectron } = require('./launch-electron.cjs');
const { stopElectron } = require('./electron-shutdown.cjs');
const waitOn = require('wait-on');

const start = async () => {
  try {
    prepareMulticaDevAgent();
  } catch (error) {
    console.warn(`[Electron Dev] Multica launcher preparation failed: ${error.message}`);
  }
  const devServerPort = await findFreePort(port);
  const devServerUrl = `http://localhost:${devServerPort}`;
  const nativeHost = prepareBrowserExtensionDevHost();
  if (nativeHost) {
    console.log(`[Electron Dev] Registered browser native host: ${nativeHost.manifestPath}`);
    console.log(
      '[Electron Dev] Browser extension discovery only; start the app from this terminal.',
    );
  }
  const env = {
    ...process.env,
    JUSTDO_DEV_SERVER_PORT: String(devServerPort),
    VITE_DEBUG_CHAT_TIMELINE: process.env.JUSTDO_DEBUG_CHAT_TIMELINE === 'true' ? 'true' : 'false',
  };
  console.log(`[Electron Dev] Using development server port ${devServerPort}.`);

  let electron;
  let stopping = false;
  let cancelStartup;
  const cancelled = new Promise(resolve => { cancelStartup = resolve; });
  const stop = async code => {
    if (stopping) return;
    stopping = true;
    cancelStartup(false);
    await stopElectron(electron);
    try { vite.kill(); } catch { /* Already exited. */ }
    process.exit(code);
  };
  // Own children directly. concurrently's Windows process-tree termination can
  // kill Gateway before Electron completes its native database lease cleanup.
  const root = path.resolve(__dirname, '../..');
  const viteEntry = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const vite = spawn(process.execPath, [viteEntry, '--port', String(devServerPort), '--strictPort'], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });

  vite.on('error', error => {
    console.error('[Electron Dev] Failed to start Vite:', error.message);
    void stop(1);
  });
  vite.on('close', code => {
    if (!stopping) void stop(code || 1);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop(0));
  try {
    const ready = await Promise.race([
      waitOn({
        resources: [devServerUrl, path.join(root, 'dist-electron/.electron-ready')],
        timeout: 300_000, simultaneous: 1,
      }).then(() => true),
      cancelled,
    ]);
    if (!ready || stopping) return;
    electron = launchElectron({ env });
    electron.on('error', error => {
      console.error('[Electron Dev] Failed to start Electron:', error.message);
      void stop(1);
    });
    electron.on('close', code => {
      // A successful single-instance handoff also exits this child. Keep Vite
      // serving the adopted window until the terminal ends, as before.
      if (!stopping && code !== 0) void stop(code || 1);
    });
  } catch (error) {
    console.error('[Electron Dev] Startup readiness failed:', error.message);
    await stop(1);
  }
};

start().catch(error => {
  console.error('[Electron Dev] Failed to start development processes:', error);
  process.exit(1);
});
