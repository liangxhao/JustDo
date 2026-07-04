const { spawn } = require('child_process');
const path = require('path');
const {
  devServer: { port },
} = require('../package.json');

const commands = [
  `vite --port ${port}`,
  `wait-on -v -t 120000 -d 20000 http://localhost:${port} dist-electron/.electron-ready && npm run start:electron`,
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
  env: process.env,
  stdio: 'inherit',
});

child.on('error', error => {
  console.error('[Electron Dev] Failed to start development processes:', error);
  process.exit(1);
});

child.on('close', code => {
  process.exit(code ?? 1);
});
