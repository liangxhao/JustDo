import { describe, expect, test } from 'vitest';

import {
  BrowserMode,
  BrowserSearchEngine,
  DEFAULT_BROWSER_PANEL_SHORTCUTS,
  isBrowserAgentProfile,
  isBrowserProfileRunning,
  normalizeBrowserDownloadSettings,
  normalizeBrowserMode,
  normalizeBrowserPanelHttpAuthRequest,
  normalizeBrowserPanelHttpAuthResponse,
  normalizeBrowserPanelOpenTabEvent,
  normalizeBrowserPanelShortcutSettings,
  normalizeBrowserSearchEngine,
  parseDevToolsActivePort,
  resolveBrowserAddressInput,
  resolveBrowserPanelShortcutAction,
} from './browser';

test('routes configured review shortcuts and respects an explicitly disabled binding', () => {
  const input = { key: 'g', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
  expect(resolveBrowserPanelShortcutAction(input, DEFAULT_BROWSER_PANEL_SHORTCUTS)).toBe('review');
  const settings = normalizeBrowserPanelShortcutSettings({
    ...DEFAULT_BROWSER_PANEL_SHORTCUTS,
    review: 'Ctrl+Shift+R',
  })!;
  expect(resolveBrowserPanelShortcutAction(input, settings)).toBeNull();
  expect(resolveBrowserPanelShortcutAction({ ...input, key: 'r' }, settings)).toBe('review');
  expect(resolveBrowserPanelShortcutAction(input, { ...settings, review: '' })).toBeNull();
});

describe('browser agent profile names', () => {
  test.each(['embedded', '1-work', '2026', 'profile-1'])(
    'accepts the OpenClaw profile name %j',
    profile => {
      expect(isBrowserAgentProfile(profile)).toBe(true);
    },
  );

  test.each(['Work', 'work_one', '-work', 'work.name', ''])(
    'rejects the unsupported profile name %j',
    profile => {
      expect(isBrowserAgentProfile(profile)).toBe(false);
    },
  );
});

describe('normalizeBrowserMode', () => {
  test('defaults missing and unknown values to the embedded browser', () => {
    expect(normalizeBrowserMode(undefined)).toBe(BrowserMode.Embedded);
    expect(normalizeBrowserMode('unknown')).toBe(BrowserMode.Embedded);
  });

  test('keeps an explicit isolated-browser selection', () => {
    expect(normalizeBrowserMode(BrowserMode.Isolated)).toBe(BrowserMode.Isolated);
  });

  test('keeps an explicit user-browser selection', () => {
    expect(normalizeBrowserMode(BrowserMode.User)).toBe(BrowserMode.User);
  });

  test('keeps an explicit extension-browser selection', () => {
    expect(normalizeBrowserMode(BrowserMode.Extension)).toBe(BrowserMode.Extension);
  });

  test('keeps an explicit embedded-browser selection', () => {
    expect(normalizeBrowserMode(BrowserMode.Embedded)).toBe(BrowserMode.Embedded);
  });
});

describe('browser address resolution', () => {
  test('defaults unknown search engine values to Baidu', () => {
    expect(normalizeBrowserSearchEngine(undefined)).toBe(BrowserSearchEngine.Baidu);
    expect(normalizeBrowserSearchEngine('duckduckgo')).toBe(BrowserSearchEngine.Baidu);
    expect(normalizeBrowserSearchEngine(BrowserSearchEngine.Google)).toBe(
      BrowserSearchEngine.Google,
    );
  });

  test.each([
    ['example.com/docs', 'https://example.com/docs'],
    ['http://localhost:43127/path', 'http://localhost:43127/path'],
    ['localhost:43127/path', 'https://localhost:43127/path'],
    ['127.0.0.1:8080', 'https://127.0.0.1:8080/'],
    ['about:blank', 'about:blank'],
  ])('navigates likely web address %j', (input, expected) => {
    expect(resolveBrowserAddressInput(input, BrowserSearchEngine.Baidu)).toBe(expected);
  });

  test('uses Baidu for text that is not a web address', () => {
    expect(resolveBrowserAddressInput('天气 北京', BrowserSearchEngine.Baidu)).toBe(
      'https://www.baidu.com/s?wd=%E5%A4%A9%E6%B0%94+%E5%8C%97%E4%BA%AC',
    );
  });

  test('uses Google when it is selected', () => {
    expect(resolveBrowserAddressInput('electron webview', BrowserSearchEngine.Google)).toBe(
      'https://www.google.com/search?q=electron+webview',
    );
  });

  test('returns null for empty input and searches unsupported schemes safely', () => {
    expect(resolveBrowserAddressInput('  ', BrowserSearchEngine.Baidu)).toBeNull();
    expect(resolveBrowserAddressInput('javascript:alert(1)', BrowserSearchEngine.Google)).toBe(
      'https://www.google.com/search?q=javascript%3Aalert%281%29',
    );
  });
});

describe('browser download settings', () => {
  test('keeps valid values and trims the selected directory', () => {
    expect(
      normalizeBrowserDownloadSettings({
        directory: '  C:\\Downloads\\Work  ',
        askWhereToSave: false,
      }),
    ).toEqual({ directory: 'C:\\Downloads\\Work', askWhereToSave: false });
  });

  test('preserves the existing ask-before-saving behavior for missing settings', () => {
    expect(normalizeBrowserDownloadSettings({})).toEqual({
      directory: '',
      askWhereToSave: true,
    });
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

describe('isBrowserProfileRunning', () => {
  test.each([{ running: true }, { running: true, tabs: [] }, { running: true, tabs: [null] }])(
    'accepts a running extension independently of shared tabs %#',
    response => {
      expect(isBrowserProfileRunning(response)).toBe(true);
    },
  );

  test.each([null, {}, { running: false }, { running: 'true' }])(
    'rejects a response without the running signal %#',
    response => {
      expect(isBrowserProfileRunning(response)).toBe(false);
    },
  );
});

describe('normalizeBrowserPanelOpenTabEvent', () => {
  test('preserves the whitelisted POST-blocked marker across preload', () => {
    expect(
      normalizeBrowserPanelOpenTabEvent({
        url: 'https://example.com/submit',
        openerGuestId: 42,
        errorCode: 'post-navigation-blocked',
        secret: 'discarded',
      }),
    ).toEqual({
      url: 'https://example.com/submit',
      openerGuestId: 42,
      errorCode: 'post-navigation-blocked',
    });
  });

  test('drops unknown fields and rejects malformed events', () => {
    expect(
      normalizeBrowserPanelOpenTabEvent({ url: 'https://example.com', errorCode: 'unknown' }),
    ).toEqual({ url: 'https://example.com' });
    expect(normalizeBrowserPanelOpenTabEvent({ errorCode: 'post-navigation-blocked' })).toBeNull();
  });
});

describe('browser HTTP authentication IPC', () => {
  test('rejects oversized credentials rather than sending a changed password', () => {
    expect(
      normalizeBrowserPanelHttpAuthResponse({
        id: 'request-1',
        guestId: 42,
        username: 'alice',
        password: 'x'.repeat(4097),
      }),
    ).toBeNull();
  });
  test('normalizes requests and removes unknown fields', () => {
    expect(
      normalizeBrowserPanelHttpAuthRequest({
        id: 'request-1',
        guestId: 42,
        host: 'example.com',
        port: 443,
        realm: 'Private',
        scheme: 'basic',
        password: 'discarded',
      }),
    ).toEqual({
      id: 'request-1',
      guestId: 42,
      host: 'example.com',
      port: 443,
      realm: 'Private',
      scheme: 'basic',
    });
  });

  test('accepts complete credentials or an explicit cancellation only', () => {
    expect(
      normalizeBrowserPanelHttpAuthResponse({
        id: 'request-1',
        guestId: 42,
        username: 'alice',
        password: 'secret',
      }),
    ).toEqual({ id: 'request-1', guestId: 42, username: 'alice', password: 'secret' });
    expect(
      normalizeBrowserPanelHttpAuthResponse({
        id: 'request-1',
        guestId: 42,
        username: 'partial',
      }),
    ).toEqual({ id: 'request-1', guestId: 42 });
    expect(normalizeBrowserPanelHttpAuthResponse({ id: 'request-1' })).toBeNull();
  });
});
