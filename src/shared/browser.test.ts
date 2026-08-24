import { describe, expect, test } from 'vitest';

import {
  BrowserMode,
  isBrowserExtensionConnected,
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

describe('isBrowserExtensionConnected', () => {
  test.each([{ running: true }, { running: true, tabs: [] }, { running: true, tabs: [null] }])(
    'accepts a running extension independently of shared tabs %#',
    response => {
      expect(isBrowserExtensionConnected(response)).toBe(true);
    },
  );

  test.each([null, {}, { running: false }, { running: 'true' }])(
    'rejects a response without the running signal %#',
    response => {
      expect(isBrowserExtensionConnected(response)).toBe(false);
    },
  );
});
