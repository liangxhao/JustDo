/** Keep all application windows on the same platform-specific chrome policy. */
export const getWindowChromeOptions = (
  isMac: boolean,
  isWindows: boolean,
  titleBarOverlay: Electron.TitleBarOverlay,
): Pick<
  Electron.BrowserWindowConstructorOptions,
  'frame' | 'titleBarStyle' | 'trafficLightPosition' | 'titleBarOverlay'
> =>
  isMac
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 20 } }
    : isWindows
      ? { frame: false, titleBarStyle: 'hidden' }
      : { titleBarStyle: 'hidden', titleBarOverlay };
