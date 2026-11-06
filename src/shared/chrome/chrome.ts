/** Application-owned operations for the installed Chrome client and extension. */
export const ChromeIpc = {
  OpenUrl: 'chrome:openUrl',
  OpenRemoteDebugging: 'chrome:openRemoteDebugging',
  OpenExtensionManagement: 'chrome:openExtensionManagement',
  RevealExtension: 'chrome:revealExtension',
  CopyExtensionPairing: 'chrome:copyExtensionPairing',
  TestExtensionConnection: 'chrome:testExtensionConnection',
} as const;
