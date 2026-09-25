'use strict';

const path = require('path');
const electron = require('electron');
const packageJson = require('../../package.json');
const { createMulticaAgentLauncher } = require('./create-multica-agent-launcher.cjs');

const appData = process.env.APPDATA;
if (!appData) throw new Error('APPDATA is required.');
const target = path.join(
  appData,
  packageJson.productName,
  'multica',
  'development',
  `${packageJson.productName}-agent.exe`,
);
createMulticaAgentLauncher(target, {
  productExecutablePath: electron,
  applicationPath: path.resolve(__dirname, '../..'),
});
console.log(target.replaceAll('\\', '/'));
