'use strict';

const { BROWSER_AUTHENTICATION_CONFIG } = require('../../src/config/browserAuthentication.ts');
const {
  resolveBrowserAuthenticationConfig,
} = require('../../src/shared/browser/browserAuthentication.ts');

module.exports = {
  BROWSER_AUTHENTICATION_EXECUTABLE: resolveBrowserAuthenticationConfig(
    BROWSER_AUTHENTICATION_CONFIG,
  ).executableName,
};
