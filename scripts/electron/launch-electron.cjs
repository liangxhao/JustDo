/** Launch Electron with Node mode cleared and an owned development IPC pipe. */
const { spawn } = require('child_process');
const path = require('path');
const { stopElectron, observeElectron } = require('./electron-shutdown.cjs');
const { devServer: { port: devServerPort } } = require('../../package.json');
const DEV_SERVER_URL_SWITCH = '--justdo-dev-server-url';

function launchElectron(options = {}) {
  const electronPath = require('electron');
  const env = { ...process.env, ...options.env };
  const port = env.JUSTDO_DEV_SERVER_PORT || devServerPort;
  delete env.ELECTRON_RUN_AS_NODE;
  env.NODE_ENV ||= 'development';
  env.ELECTRON_START_URL ||= `http://localhost:${port}`;
  console.log('[Electron Launcher] Starting Electron...');
  console.log('[Electron Launcher] Electron path:', electronPath);
  const args = ['.', `${DEV_SERVER_URL_SWITCH}=${env.ELECTRON_START_URL}`, ...(options.args || [])];
  const child = spawn(electronPath, args, {
    cwd: path.resolve(__dirname, '../..'),
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env,
    // SW_HIDE suppresses the first native ShowWindow call, including BrowserWindow.show().
    windowsHide: false,
  });
  observeElectron(child);
  return child;
}

if (require.main === module) {
  const child = launchElectron({ args: process.argv.slice(2) });
  let stopping;
  child.on('close', (code, signal) => {
    if (stopping) return; // The shared stop verdict also accounts for forced retirement.
    if (code === null) console.error(`Electron exited with signal ${signal}`);
    process.exit(code ?? 1);
  });
  child.on('error', error => {
    console.error('[Electron Launcher] Failed to start Electron:', error.message);
    process.exit(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
    process.on(signal, () => {
      stopping ||= stopElectron(child).then(() => process.exit(0), error => {
        console.error('[Electron Launcher] Application shutdown failed:', error.message);
        process.exit(1);
      });
    });
  }
}

module.exports = { launchElectron };
