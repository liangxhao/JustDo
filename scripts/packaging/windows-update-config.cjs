'use strict';

const { APP_UPDATE_CONFIG } = require('../../src/config/appUpdate.ts');

function readWindowsUpdateConfig(_env = process.env, configuration = APP_UPDATE_CONFIG) {
  // Deployment is explicit in the checked-in configuration. Inherited build
  // environment values cannot silently turn networking on for an offline build.
  const feedUrl = configuration.feedUrl.trim();
  return feedUrl ? Object.freeze({ feedUrl }) : null;
}

const WINDOWS_UPDATE_CONFIG = readWindowsUpdateConfig();

module.exports = {
  readWindowsUpdateConfig,
  WINDOWS_UPDATE_CONFIG,
};
