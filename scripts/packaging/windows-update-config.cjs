'use strict';

const { APP_UPDATE_CONFIG, resolveAppUpdateFeedUrl } = require('../../src/config/appUpdate.ts');

function readWindowsUpdateConfig(_env = process.env, configuration = APP_UPDATE_CONFIG) {
  // Deployment is explicit in the checked-in configuration. Inherited build
  // environment values cannot silently turn networking on for an offline build.
  const feedUrl = resolveAppUpdateFeedUrl(configuration.feedUrl);
  return feedUrl ? Object.freeze({ feedUrl }) : null;
}

const WINDOWS_UPDATE_CONFIG = readWindowsUpdateConfig();

module.exports = {
  readWindowsUpdateConfig,
  WINDOWS_UPDATE_CONFIG,
};
