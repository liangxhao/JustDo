'use strict';

const path = require('path');
const packageJson = require('../../package.json');
const { createMulticaAgentLauncher } = require('./create-multica-agent-launcher.cjs');

function prepareMulticaDevAgent(userDataPath = process.env.JUSTDO_DEV_USER_DATA_DIR) {
  if (process.platform !== 'win32') return null;
  const appData = process.env.APPDATA;
  if (!userDataPath && !appData) throw new Error('APPDATA is required.');
  const directory = path.resolve(userDataPath || path.join(appData, packageJson.productName));
  const target = path.join(
    directory,
    'multica',
    'development',
    `${packageJson.productName}-agent.exe`,
  );
  createMulticaAgentLauncher(target, { userDataPath: directory });
  return target;
}

if (require.main === module) {
  const target = prepareMulticaDevAgent();
  if (target) console.log(target.replaceAll('\\', '/'));
}

module.exports = { prepareMulticaDevAgent };
