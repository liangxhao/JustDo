const translations = {
  zh: {
    title: '__PRODUCT_NAME__ 浏览器设置',
    subtitle: '管理浏览器连接、标签页授权和对话背景。',
    sharedConnection: '两种方式管理同一个连接，关闭后停止自动重连。',
    automaticTitle: '自动连接 / 关闭',
    automaticHint: '自动发现本机 __PRODUCT_NAME__，并保持连接。',
    manualTitle: '手动连接 / 关闭',
    manualHint: '在 __PRODUCT_NAME__ 的设置 → 浏览器中复制扩展配对信息，然后粘贴到下方。',
    pairingLabel: '配对信息',
    pairingPlaceholder: '粘贴配对信息',
    accessTitle: 'Tab Access',
    accessLabel: '允许访问的标签页',
    accessHint: '选择“选定标签页”时，仅允许操作已授权的标签页。',
    selectedTabs: '选定标签页',
    allTabs: '所有标签页',
    connectLocal: '连接本机',
    connect: '连接',
    disconnect: '关闭',
    checking: '正在检查连接…',
    connected: '已连接',
    connecting: '正在连接…',
    unavailable: '已配对，连接暂不可用',
    notPaired: '未连接',
    paused: '自动化已暂停',
    automaticDisabled: '自动连接已关闭',
    automaticReady: '自动连接已开启',
    waitingLocal: '正在等待本机应用',
    manualRequired: '自动连接暂不可用，请使用手动连接。',
    custodyHint: '检测到需要确认的旧自动化任务。确认旧任务已结束后，点击“关闭”，再重新连接。',
    lookingLocal: '正在连接本机 __PRODUCT_NAME__…',
    automaticFailed: '无法连接本机应用。请确认桌面应用正在运行，然后重试。',
    paired: '配对信息已保存。',
    disconnected: '连接已关闭，自动重连已停用。',
    accessSaved: '标签页授权范围已更新。',
    invalidPairing: '配对信息无效，请重新复制完整配对信息。',
    operationFailed: '操作失败，请确认桌面应用可用后重试。',
    statusFailed: '无法读取连接状态，请重新打开设置页。',
  },
  en: {
    title: '__PRODUCT_NAME__ Browser Settings',
    subtitle: 'Manage browser connections, tab access, and chat backgrounds.',
    sharedConnection: 'Automatic local setup or manual pairing.',
    automaticTitle: 'Automatic connection',
    automaticHint: 'Use automatic local setup to connect to __PRODUCT_NAME__.',
    manualTitle: 'Manual connection',
    manualHint:
      'In __PRODUCT_NAME__, open Settings > Browser, copy the extension pairing information, then paste it below.',
    pairingLabel: 'Pairing string',
    pairingPlaceholder: 'Paste the pairing string',
    accessTitle: 'Tab Access',
    accessLabel: 'Browser access mode',
    accessHint: 'Selected tabs limits automation to the tabs you have authorized.',
    selectedTabs: 'Selected tabs',
    allTabs: 'All tabs',
    connectLocal: 'Use local __PRODUCT_NAME__',
    connect: 'Pair manually',
    disconnect: 'Disconnect',
    checking: 'Checking…',
    connected: 'Connected',
    connecting: 'Connecting…',
    unavailable: 'Paired; relay unavailable',
    notPaired: 'Not paired',
    paused: 'Automation paused',
    automaticDisabled: 'Automatic setup disabled',
    automaticReady: 'Automatic bootstrap ready',
    waitingLocal: 'Waiting for the local native host',
    manualRequired: 'Manual setup required',
    custodyHint:
      'Previous automation tasks need confirmation. Confirm they have finished, then disconnect and reconnect.',
    lookingLocal: 'Looking for local __PRODUCT_NAME__…',
    automaticFailed: 'Unable to connect. Check that the desktop app is running and try again.',
    paired: 'Pairing saved.',
    disconnected: 'Disconnected. Automatic setup is disabled.',
    accessSaved: 'Access mode updated.',
    invalidPairing: 'Invalid pairing string. Copy the complete pairing string again.',
    operationFailed: 'Operation failed. Check that the desktop app is available and try again.',
    statusFailed: 'Could not read connection status. Reopen the settings page.',
  },
};

// Product settings intentionally use English regardless of the browser locale.
export const language = 'en';
export const t = key => translations[language][key];

export function localizeOptions() {
  document.documentElement.lang = language;
  document.title = t('title');
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  }
}
