import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ipcMain } from 'electron';
import { describe, expect, test, vi } from 'vitest';

import { ChromeIpc } from '../../../shared/chrome/chrome';
import { openChromeUrl } from '../../chrome/chromeSettings';
import { registerChromeHandlers } from './chrome';

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(), isPackaged: false },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openPath: vi.fn() },
}));

describe('opening message links in Chrome', () => {
  test('denies Chrome launches from guests and child frames', () => {
    const handle = vi.mocked(ipcMain.handle);
    handle.mockClear();
    registerChromeHandlers({
      getGatewayClient: () => null,
      buildCliEnvironment: vi.fn(),
    });
    const handler = handle.mock.calls.find(([channel]) => channel === ChromeIpc.OpenUrl)?.[1];
    expect(handler).toBeTruthy();
    const mainFrame = {};
    for (const event of [
      { sender: { getType: () => 'webview', mainFrame }, senderFrame: mainFrame },
      { sender: { getType: () => 'window', mainFrame }, senderFrame: {} },
    ]) {
      expect(handler!(event as Electron.IpcMainInvokeEvent, 'https://example.com')).toEqual({
        success: false,
        error: 'Access denied',
      });
    }
  });
  test.each([
    undefined,
    null,
    {},
    'file:///C:/report.html',
    'javascript:alert(1)',
    '--incognito',
    'https://example.com/\n--incognito',
  ])('rejects an invalid URL: %s', async url => {
    const launch = vi.fn();
    expect((await openChromeUrl(url, launch)).success).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  test('passes the complete web URL as one launch argument and returns launch failures', async () => {
    const url = 'https://example.com/report.html?q=%E4%B8%AD%E6%96%87#chart';
    const launch = vi.fn().mockResolvedValue({ success: false, error: 'Chrome unavailable' });
    expect(await openChromeUrl(url, launch)).toEqual({
      success: false,
      error: 'Chrome unavailable',
    });
    expect(launch).toHaveBeenCalledWith(url);
  });

  test('opens an existing local HTML in Chrome with its original file URL', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-chrome-html-'));
    try {
      const filePath = path.join(directory, '季度报告 #100%.html');
      fs.writeFileSync(filePath, '<p>Report</p>');
      const url = pathToFileURL(filePath);
      url.search = '?mode=3d';
      url.hash = '#camera';
      const launch = vi.fn().mockResolvedValue({ success: true });

      await expect(openChromeUrl(url.href, launch)).resolves.toEqual({ success: true });
      expect(launch).toHaveBeenCalledWith(url.href);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

test('registers Chrome-owned channels and rejects guest or child-frame actions before effects', () => {
  const handle = vi.mocked(ipcMain.handle);
  handle.mockClear();
  const getGatewayClient = vi.fn();
  const buildCliEnvironment = vi.fn();
  registerChromeHandlers({ getGatewayClient, buildCliEnvironment });
  expect(handle.mock.calls.map(([channel]) => channel)).toEqual(Object.values(ChromeIpc));
  const mainFrame = {};
  for (const [, handler] of handle.mock.calls) {
    for (const event of [
      { sender: { getType: () => 'webview', mainFrame }, senderFrame: mainFrame },
      { sender: { getType: () => 'window', mainFrame }, senderFrame: {} },
    ]) {
      expect(handler(event as Electron.IpcMainInvokeEvent)).toEqual({
        success: false,
        error: 'Access denied',
      });
    }
  }
  expect(getGatewayClient).not.toHaveBeenCalled();
  expect(buildCliEnvironment).not.toHaveBeenCalled();
});

test('tests the exact native Chrome profile for an authorized application frame', async () => {
  const handle = vi.mocked(ipcMain.handle);
  handle.mockClear();
  const request = vi.fn().mockResolvedValue({ running: true, tabs: [] });
  registerChromeHandlers({ getGatewayClient: () => ({ request }), buildCliEnvironment: vi.fn() });
  const handler = handle.mock.calls.find(
    ([channel]) => channel === ChromeIpc.TestExtensionConnection,
  )![1];
  const mainFrame = {};
  await expect(
    handler({
      sender: { getType: () => 'window', mainFrame },
      senderFrame: mainFrame,
    } as Electron.IpcMainInvokeEvent),
  ).resolves.toEqual({ success: true });
  expect(request).toHaveBeenCalledWith('browser.request', {
    method: 'GET',
    path: '/tabs',
    query: { profile: 'chrome' },
    timeoutMs: 45_000,
  });
});
