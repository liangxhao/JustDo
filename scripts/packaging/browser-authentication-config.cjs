'use strict';

const path = require('node:path');
const { extractFile, listPackage } = require('@electron/asar');
const { BROWSER_AUTHENTICATION_CONFIG } = require('../../src/config/browserAuthentication.ts');
const {
  BROWSER_AUTHENTICATION_BUILD_FILE,
  resolveBrowserAuthenticationConfig,
} = require('../../src/shared/browser/browserAuthentication.ts');

const BROWSER_AUTHENTICATION_EXECUTABLE = resolveBrowserAuthenticationConfig(
  BROWSER_AUTHENTICATION_CONFIG,
).executableName;

function verifyPackagedBrowserAuthentication(appOutDir) {
  const appArchive = path.join(appOutDir, 'resources', 'app.asar');
  const configPath = path.join('dist-electron', BROWSER_AUTHENTICATION_BUILD_FILE);
  if (!listPackage(appArchive).includes(path.sep + configPath) ||
      extractFile(appArchive, configPath).toString('utf8') !== JSON.stringify(BROWSER_AUTHENTICATION_EXECUTABLE)) {
    throw new Error('Rebuild the Windows application with the current browser authentication executable configuration.');
  }
}

module.exports = {
  BROWSER_AUTHENTICATION_EXECUTABLE,
  BROWSER_AUTHENTICATION_BUILD_FILE,
  verifyPackagedBrowserAuthentication,
};
