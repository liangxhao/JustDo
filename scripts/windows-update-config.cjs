'use strict';

const WINDOWS_UPDATE_CONFIG = Object.freeze({
  feedUrl: 'https://xxx.com/electron-app-update',
});

function readWindowsUpdateConfig() {
  return WINDOWS_UPDATE_CONFIG;
}

module.exports = {
  readWindowsUpdateConfig,
  WINDOWS_UPDATE_CONFIG,
};
