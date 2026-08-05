'use strict';

const baseConfig = require('./electron-builder.json');
const packageJson = require('./package.json');
const {
  resolveBuilderProductMetadata,
} = require('./scripts/electron-builder-product-metadata.cjs');
const { readWindowsUpdateConfig } = require('./scripts/windows-update-config.cjs');

const { appId, productName } = resolveBuilderProductMetadata(packageJson.productName);
const windowsUpdateConfig = readWindowsUpdateConfig();

module.exports = {
  ...baseConfig,
  // beforePack rebuilds native modules for the exact target. Disabling the
  // automatic rebuild still lets electron-builder collect production modules.
  npmRebuild: false,
  appId,
  productName,
  executableName: productName,
  publish: [
    {
      provider: 'generic',
      url: windowsUpdateConfig.feedUrl,
      publishAutoUpdate: false,
    },
  ],
  protocols: [
    {
      name: productName,
      // This is a stable internal protocol identifier and must not be rebranded.
      schemes: ['justdo'],
    },
  ],
  mac: {
    ...baseConfig.mac,
    extendInfo: {
      ...baseConfig.mac.extendInfo,
      NSCalendarsUsageDescription: `${productName} 需要访问您的日历来帮助您查看和管理日程安排，例如查找事件、创建会议等。`,
      NSRemindersUsageDescription: `${productName} 需要访问您的提醒事项来帮助您管理待办事项。`,
      NSAppleEventsUsageDescription: `${productName} 需要使用 Apple Events 来控制 Calendar 应用执行自动化操作。`,
    },
  },
  win: {
    ...baseConfig.win,
    verifyUpdateCodeSignature: false,
  },
  linux: {
    ...baseConfig.linux,
    desktop: {
      ...baseConfig.linux.desktop,
      entry: {
        ...baseConfig.linux.desktop.entry,
        Name: productName,
      },
    },
  },
};
