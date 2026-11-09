const translations = {
  zh: {
    webLaunchSitesTitle: '已连接的网站',
    webLaunchSitesHint:
      '在业务网页点击对话按钮，再到扩展中批准连接，无需手填网址。这里管理已连接网站；直接发送和结果分享仍单独授权。桌面应用需已启动。',
    webLaunchAllowSend: '允许直接发送',
    webLaunchAllowResult: '允许回传本次请求结果',
    webLaunchRefresh: '刷新网站权限',
    webLaunchRevoke: '撤销网站访问权限',
    webLaunchNoSites: '尚无已连接的网站，请先在业务网页点击对话按钮。',
    webLaunchSaved: '网站权限已保存。',
    webLaunchPermissionDenied: '未授予 Chrome 访问权限，未保存网站授权。',
    webLaunchSettingsFailed: '无法确认网站设置，请检查桌面应用是否已启动后刷新。',
    webLaunchConflict: '编辑期间设置已改变，请核对最新值后重试。',
    webLaunchObservations: '执行状态未知的请求',
    webLaunchUnknownSource: '网页请求',
    webLaunchAbandon: '解除关联并放弃观察',
    webLaunchAbandonConfirm:
      '解除此请求关联并放弃观察？任务可能仍在执行，此操作不会停止或重复任务。',
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
    webLaunchSitesTitle: 'Connected websites',
    webLaunchSitesHint:
      'Click the conversation button on a business website, then approve its connection in the extension. No address entry is needed. Manage connected websites here; direct sending and result sharing remain separate permissions. The desktop app must be running.',
    webLaunchAllowSend: 'Allow direct sending',
    webLaunchAllowResult: 'Allow returning this request’s result',
    webLaunchRefresh: 'Refresh website permissions',
    webLaunchRevoke: 'Revoke website access',
    webLaunchNoSites:
      'No connected websites. Start with the conversation button on a business website.',
    webLaunchSaved: 'Website permissions saved.',
    webLaunchPermissionDenied: 'Chrome access was not granted. No website permission was saved.',
    webLaunchSettingsFailed:
      'Could not confirm website settings. Check that the desktop application is running, then refresh.',
    webLaunchConflict:
      'Settings changed while you were editing. Check the current values and try again.',
    webLaunchObservations: 'Requests with unknown execution status',
    webLaunchUnknownSource: 'Website request',
    webLaunchAbandon: 'Unlink and stop observing',
    webLaunchAbandonConfirm:
      'Unlink this request and stop observing it? Its execution may still be running. This does not stop or repeat the task.',
    title: '__PRODUCT_NAME__ Chrome Settings',
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
