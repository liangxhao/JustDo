const { spawn } = require('child_process');
const path = require('path');
const {
  devServer: { port },
} = require('../package.json');
const { findFreePort } = require('./find-free-port.cjs');
const {
  acquireRuntimeDevLease,
  resolveRuntimeDevLeaseDir,
} = require('./openclaw-runtime-dev-lease.cjs');

const start = async () => {
  const rootDir = path.resolve(__dirname, '..');
  const releaseRuntimeLease = acquireRuntimeDevLease(resolveRuntimeDevLeaseDir(rootDir));
  process.once('exit', releaseRuntimeLease);
  const devServerPort = await findFreePort(port);
  const env = { ...process.env, JUSTDO_DEV_SERVER_PORT: String(devServerPort) };
  console.log(`[Electron Dev] Using development server port ${devServerPort}.`);

  const commands = [
    `vite --port ${devServerPort}`,
    `wait-on -t 120000 -d 20000 --simultaneous 1 http://localhost:${devServerPort} dist-electron/.electron-ready && npm run start:electron`,
  ];
  const concurrentlyPackagePath = require.resolve('concurrently/package.json');
  const concurrentlyPackage = require(concurrentlyPackagePath);
  const concurrentlyBin =
    typeof concurrentlyPackage.bin === 'string'
      ? concurrentlyPackage.bin
      : concurrentlyPackage.bin?.concurrently;

  if (!concurrentlyBin) {
    console.error('[Electron Dev] The concurrently package does not expose a CLI binary.');
    process.exit(1);
  }

  const concurrentlyPath = path.resolve(path.dirname(concurrentlyPackagePath), concurrentlyBin);
  const child = spawn(process.execPath, [concurrentlyPath, ...commands], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });

  child.on('error', error => {
    releaseRuntimeLease();
    console.error('[Electron Dev] Failed to start development processes:', error);
    process.exit(1);
  });

  child.on('close', code => {
    releaseRuntimeLease();
    process.exit(code ?? 1);
  });
};

start().catch(error => {
  console.error('[Electron Dev] Failed to start development processes:', error);
  process.exit(1);
});
