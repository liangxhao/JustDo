'use strict';

const { APP_UPDATE_CONFIG } = require('../../src/config/appUpdate.ts');

const WINDOWS_UPDATE_CONFIG = Object.freeze({ feedUrl: APP_UPDATE_CONFIG.feedUrl });

function readWindowsUpdateConfig() {
  return WINDOWS_UPDATE_CONFIG;
}

module.exports = {
  readWindowsUpdateConfig,
  WINDOWS_UPDATE_CONFIG,
};
