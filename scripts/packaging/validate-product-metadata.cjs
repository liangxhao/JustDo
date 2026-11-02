'use strict';

const metadata = require('../../package.json');
const {
  resolveBuilderProductMetadata,
  validatePackageVersions,
} = require('./electron-builder-product-metadata.cjs');
const config = resolveBuilderProductMetadata(metadata.productName);
const { appVersion, runtimeVersion } = validatePackageVersions(metadata);

console.log(`[validate-product-metadata] productName=${config.productName} appId=${config.appId} appVersion=${appVersion} runtimeVersion=${runtimeVersion}`);
