'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { findFreePort } = require('./find-free-port.cjs');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const runtime = path.join(root, 'vendor', 'openclaw-runtime', 'current');
  if (!fs.existsSync(runtime))
    throw new Error('Prepare the host runtime with npm run openclaw:runtime:host first.');
  const userData =
    process.env.JUSTDO_DEV_USER_DATA_DIR || path.join(root, '.work', 'multi-agent-preview');
  const port = await findFreePort(require('../../package.json').devServer.port);
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    JUSTDO_DEV_USER_DATA_DIR: userData,
    JUSTDO_DEV_SERVER_PORT: String(port),
    ELECTRON_START_URL: 'http://localhost:' + port,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(userData, { recursive: true });
  const marker = path.join(root, 'dist-electron', '.electron-ready');
  fs.rmSync(marker, { force: true });
  console.log('[Isolated Dev] Data directory: ' + userData);
  console.log('[Isolated Dev] Renderer: ' + env.ELECTRON_START_URL);
  const vite = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: root, env, stdio: 'inherit', windowsHide: true },
  );
  let electron;
  let stopping = false;
  const stop = code => {
    if (stopping) return;
    stopping = true;
    electron?.kill();
    vite.kill();
    process.exit(code);
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  vite.on('error', error => {
    console.error(error.message);
    stop(1);
  });
  vite.on('exit', code => {
    if (!stopping) stop(code || 1);
  });
  const ready = () =>
    new Promise(resolve => {
      const req = http.get(env.ELECTRON_START_URL, response => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && (!fs.existsSync(marker) || !(await ready()))) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!fs.existsSync(marker) || !(await ready())) {
    console.error('Development build did not become ready.');
    stop(1);
    return;
  }
  electron = spawn(require('electron'), ['.'], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: false,
  });
  electron.on('error', error => {
    console.error(error.message);
    stop(1);
  });
  electron.on('exit', code => stop(code || 0));
}
main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
