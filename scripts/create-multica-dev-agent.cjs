'use strict';

const fs = require('fs');
const path = require('path');

const packageJson = require('../package.json');
const { resolveBuilderProductMetadata } = require('./electron-builder-product-metadata.cjs');
const { createMulticaAgentLauncher } = require('./create-multica-agent-launcher.cjs');

if (process.platform !== 'win32') {
  throw new Error('The temporary Multica development Agent build currently supports Windows only.');
}

const { productName } = resolveBuilderProductMetadata(packageJson.productName);
const appPath = path.resolve(__dirname, '..');
const sourcePath = path.join(appPath, 'node_modules', 'electron', 'dist', 'electron.exe');
const targetPath = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  productName,
  'multica',
  'development',
  `${productName}-agent.exe`,
);

if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
  throw new Error(`Packaged executable not found: ${sourcePath}`);
}

createMulticaAgentLauncher(targetPath, {
  productExecutablePath: sourcePath,
  applicationPath: appPath,
});

console.log(`[create-multica-dev-agent] created ${targetPath}`);
