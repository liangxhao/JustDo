'use strict';

// The locked electron-builder 26.15.3 creates NSIS application archives with a modern
// 7za, but extracts them at install time with an older Nsis7z decoder. Pin the
// compatible single-stream filter as soon as the build config is loaded. The
// beforePack hook reasserts this for normal builds; this early assignment also
// protects --prepackaged builds, which skip beforePack entirely.
process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ';

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
