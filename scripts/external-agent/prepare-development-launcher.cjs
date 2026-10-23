'use strict';

const path = require('path');
const { createHash } = require('crypto');
const packageJson = require('../../package.json');
const { getAgentCliCommandName } = require('../../src/shared/integrations/agentCli.ts');
const { createAgentCliLauncher } = require('./create-agent-cli-launcher.cjs');

function prepareDevelopmentLauncher(userDataPath = process.env.JUSTDO_DEV_USER_DATA_DIR) {
  if (process.platform !== 'win32') return null;
  const appData = process.env.APPDATA;
  if (!userDataPath && !appData) throw new Error('APPDATA is required.');
  const directory = path.resolve(userDataPath || path.join(appData, packageJson.productName));
  // Separate profiles must not overwrite launchers bound to different bridge metadata.
  const profile = createHash('sha256').update(directory).digest('hex').slice(0, 16);
  const target = path.join(
    path.resolve(__dirname, '../..'),
    '.agent-tasks',
    'external-agent',
    'development',
    profile,
    `${getAgentCliCommandName(packageJson.productName)}.exe`,
  );
  createAgentCliLauncher(target, { userDataPath: directory });
  return target;
}

if (require.main === module) {
  const target = prepareDevelopmentLauncher();
  if (target) console.log(target.replaceAll('\\', '/'));
}

module.exports = { prepareDevelopmentLauncher };
