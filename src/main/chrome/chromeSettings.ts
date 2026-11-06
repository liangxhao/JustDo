import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, clipboard, shell } from 'electron';

import type { BrowserActionResult } from '../../shared/browser/browser';
import { isWebBrowserLink } from '../../shared/browser/browserLinkOpening';
import { resolveLocalHtmlPreviewFilePath } from '../browser/preview/localHtmlPreviewServer';
import type { OpenClawCliEnvironment } from '../openclaw/runtime/openclawEngineManager';
import { readChromeExtensionPairing } from './chromeExtensionPairing';

export const resolveChromeUserDataDir = (): string | null => {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return localAppData ? path.join(localAppData, 'Google', 'Chrome', 'User Data') : null;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.config', 'google-chrome');
  }
  return null;
};

export const resolveChromeExecutable = (): string | null => {
  const candidates =
    process.platform === 'win32'
      ? [
          process.env.PROGRAMFILES
            ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
            : '',
          process.env['PROGRAMFILES(X86)']
            ? path.join(
                process.env['PROGRAMFILES(X86)'],
                'Google',
                'Chrome',
                'Application',
                'chrome.exe',
              )
            : '',
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
            : '',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) ?? null;
};

export const launchOrFocusChrome = async (url?: string): Promise<BrowserActionResult> => {
  const executable = resolveChromeExecutable();
  if (!executable) return { success: false, error: 'Google Chrome was not found.' };
  try {
    return await new Promise<BrowserActionResult>(resolve => {
      const child = spawn(executable, url ? [url] : [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', () =>
        resolve({ success: false, error: 'Google Chrome could not be opened.' }),
      );
      child.once('spawn', () => resolve({ success: true }));
      child.unref();
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export const openChromeUrl = async (
  url: unknown,
  launch: (url: string) => Promise<BrowserActionResult> = launchOrFocusChrome,
): Promise<BrowserActionResult> => {
  if (
    typeof url !== 'string' ||
    (!isWebBrowserLink(url) && !(await resolveLocalHtmlPreviewFilePath(url)))
  ) {
    return { success: false, error: 'Invalid browser URL.' };
  }
  return launch(url);
};

export const focusRunningChrome = (): void => {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SYSTEMROOT?.trim();
    const powershell = systemRoot
      ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const script = [
      'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class NativeWindow { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); }\'',
      '$chrome = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
      'if ($chrome) { [NativeWindow]::ShowWindowAsync($chrome.MainWindowHandle, 9) | Out-Null; [NativeWindow]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null }',
    ].join('; ');
    const child = spawn(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.once('error', () => {});
    child.unref();
    return;
  }

  if (process.platform === 'darwin') {
    const child = spawn('open', ['-a', 'Google Chrome'], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', () => {});
    child.unref();
  }
};

export const findBundledChromeExtensionPath = (
  environment: { isPackaged: boolean; resourcesPath: string; appPath: string },
  pathExists: (candidate: string) => boolean = fs.existsSync,
): string | null => {
  const candidates = environment.isPackaged
    ? [path.join(environment.resourcesPath, 'chrome-extension')]
    : [
        path.join(environment.appPath, 'build', 'chrome-extension'),
        path.join(process.cwd(), 'build', 'chrome-extension'),
      ];
  return (
    candidates.find(candidate =>
      pathExists(path.join(candidate, 'chrome-extension', 'manifest.json')),
    ) ?? null
  );
};

export const resolveChromeExtensionPath = (): string => {
  const extensionPath = findBundledChromeExtensionPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  if (!extensionPath) throw new Error('The bundled Chrome extension is missing.');
  return extensionPath;
};

export const readBundledChromeExtensionVersion = (extensionPath?: string): string | null => {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(
          extensionPath ?? resolveChromeExtensionPath(),
          'chrome-extension',
          'manifest.json',
        ),
        'utf8',
      ),
    );
    if (typeof manifest.version === 'string' && manifest.version.trim()) {
      return manifest.version.trim();
    }
  } catch {
    // Missing or unreadable extension metadata must not block browser settings.
  }
  return null;
};

export {
  buildChromeExtensionPairingCommandArgs,
  buildChromePairingCommandEnvironment,
} from './chromeExtensionPairing';

export const copyChromeExtensionPairing = async (
  buildCliEnvironment: () => Promise<OpenClawCliEnvironment>,
  runPairCommand?: (cli: OpenClawCliEnvironment) => Promise<string>,
): Promise<void> => {
  const result = await readChromeExtensionPairing(buildCliEnvironment, 'relay', runPairCommand);
  clipboard.writeText(result.pairingString);
  console.log(`[ChromeSettings] Browser extension pairing copied (relayPort=${result.relayPort}).`);
};

export const openChromeExtensionFolder = async (
  extensionPath: string,
  openPath: (targetPath: string) => Promise<string> = shell.openPath,
): Promise<void> => {
  const error = await openPath(extensionPath);
  if (error) throw new Error(error);
};
