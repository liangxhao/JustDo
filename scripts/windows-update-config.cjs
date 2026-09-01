'use strict';

const updateConfig = require('../src/shared/appUpdateConfig.json');

const WINDOWS_UPDATE_CONFIG = Object.freeze({ feedUrl: updateConfig.feedUrl });

function readWindowsUpdateConfig() {
  return WINDOWS_UPDATE_CONFIG;
}

module.exports = {
  readWindowsUpdateConfig,
  WINDOWS_UPDATE_CONFIG,
};
