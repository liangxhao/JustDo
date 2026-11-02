'use strict';

const { parseStableVersion } = require('../../src/shared/app/startup/version.ts');

function normalizeStableVersion(value, field = 'package.json.version') {
  if (!parseStableVersion(value)) {
    throw new Error(
      `${field} must be a stable numeric version such as "2026.11.2" or "v2026.11.2" ` +
        `(received ${JSON.stringify(value)}). Numeric components must not have leading zeros; ` +
        'prerelease/build suffixes and whitespace are not supported.',
    );
  }
  return value.replace(/^v/, '');
}

function validatePackageVersions(metadata) {
  return {
    appVersion: normalizeStableVersion(metadata?.version),
    runtimeVersion: normalizeStableVersion(metadata?.openclaw?.version, 'package.json.openclaw.version'),
  };
}

function resolveBuilderProductMetadata(productName) {
  if (
    typeof productName !== 'string' ||
    !/^[A-Za-z]{1,64}$/.test(productName) ||
    /^(con|prn|aux|nul)$/i.test(productName)
  ) {
    throw new Error(
      'package.json productName must be a non-reserved English word containing 1-64 ASCII letters only.',
    );
  }

  return {
    productName,
    appId: `com.${productName.toLocaleLowerCase('en-US')}.app`,
  };
}

module.exports = { normalizeStableVersion, validatePackageVersions, resolveBuilderProductMetadata };
