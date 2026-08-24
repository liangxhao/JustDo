import { describe, expect, test } from 'vitest';

import {
  BrowserMode,
  hasConnectedBrowserTab,
  normalizeBrowserMode,
  parseDevToolsActivePort,
} from './browser';

describe('normalizeBrowserMode', () => {
  test('defaults missing and unknown values to the isolated browser', () => {
    expect(normalizeBrowserMode(undefined)).toBe(BrowserMode.Isolated);
    expect(normalizeBrowserMode('unknown')).toBe(BrowserMode.Isolated);
  });

  test('keeps an explicit user-browser selection', () => {
    expect(normalizeBrowserMode(BrowserMode.User)).toBe(BrowserMode.User);
  });

  test('keeps an explicit extension-browser selection', () => {
    expect(normalizeBrowserMode(BrowserMode.Extension)).toBe(BrowserMode.Extension);
  });
});

describe('parseDevToolsActivePort', () => {
  test.each([
    ['3301\n/devtools/browser/test', 3301],
    ['9222\r\n/devtools/browser/test', 9222],
    [' 12345 \n', 12345],
  ])('reads the port from %j', (content, expected) => {
    expect(parseDevToolsActivePort(content)).toBe(expected);
  });

  test.each(['', 'not-a-port', '0', '65536', '12.5'])('rejects invalid content %j', content => {
    expect(parseDevToolsActivePort(content)).toBeNull();
  });
});

describe('hasConnectedBrowserTab', () => {
  test('accepts a running browser response with a usable target', () => {
    expect(
      hasConnectedBrowserTab({
        running: true,
        tabs: [{ targetId: 'shared-tab', title: 'Shared tab', url: 'https://example.com' }],
      }),
    ).toBe(true);
  });

  test.each([
    null,
    {},
    { running: false, tabs: [{ targetId: 'shared-tab' }] },
    { running: true, tabs: [] },
    { running: true, tabs: [null] },
    { running: true, tabs: ['shared-tab'] },
    { running: true, tabs: [{ targetId: '  ' }] },
  ])('rejects a disconnected or malformed response %#', response => {
    expect(hasConnectedBrowserTab(response)).toBe(false);
  });
});
