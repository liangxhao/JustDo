'use strict';

const baseConfig = require('./electron-builder.json');
const packageJson = require('./package.json');

const productName = packageJson.productName;

if (
  typeof productName !== 'string' ||
  !/^[A-Za-z]{1,64}$/.test(productName) ||
  /^(con|prn|aux|nul)$/i.test(productName)
) {
  throw new Error(
    'package.json productName must be a non-reserved English word containing 1-64 ASCII letters only.',
  );
}

module.exports = {
  ...baseConfig,
  productName,
  executableName: productName,
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
