import { describe, expect, it } from 'vitest';

import {
  isBrowserGuestZoomDirection,
  resolveBrowserGuestShortcut,
  resolveBrowserGuestWheelZoomDirection,
  resolveBrowserPanelShortcutAction,
  stepBrowserZoomFactor,
} from '../../../shared/browser/browser';
import {
  browserPermissionKeys,
  isAllowedBrowserPanelUrl,
  isAllowedExternalBrowserUrl,
  isAllowedMainWindowNavigation,
  isBlockedBrowserMetadataHost,
  isBrowserPdfStreamNavigation,
  shouldAllowBrowserPanelPermission,
  shouldPromptBrowserPanelPermission,
} from './browserPanelSecurity';

describe('browser panel capabilities', () => {
  it('allows only the built-in PDF viewer child stream, never website or top-level extension navigation', () => {
    const viewer = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html';
    const stream = viewer.replace('index.html', '0091021c-34fe-4486-af22-ab6f723d0442');
    expect(isBrowserPdfStreamNavigation(stream, false, viewer)).toBe(true);
    expect(isBrowserPdfStreamNavigation(stream, true, viewer)).toBe(false);
    expect(isBrowserPdfStreamNavigation(stream, false, 'https://example.com/')).toBe(false);
    expect(isBrowserPdfStreamNavigation(stream, false, undefined)).toBe(false);
    expect(isBrowserPdfStreamNavigation(viewer, false, viewer)).toBe(false);
    expect(isBrowserPdfStreamNavigation(`${stream}?redirect=https://example.com`, false, viewer)).toBe(false);
    expect(isBrowserPdfStreamNavigation('chrome-extension://other/index.html', false, viewer)).toBe(false);
    expect(isAllowedBrowserPanelUrl(stream)).toBe(false);
  });
  it('does not treat a microphone grant as camera permission', () => {
    const grants = new Set(browserPermissionKeys('https://example.test', 'media', ['audio']));
    expect(
      browserPermissionKeys('https://example.test', 'media', ['video']).every(key =>
        grants.has(key),
      ),
    ).toBe(false);
    expect(
      browserPermissionKeys('https://example.test', 'media', ['audio']).every(key =>
        grants.has(key),
      ),
    ).toBe(true);
    expect(browserPermissionKeys('https://example.test', 'media', ['unknown'])).toEqual([]);
    expect(browserPermissionKeys('https://example.test', 'media')).toEqual([]);
  });
  it('allows only focused low-risk browser permissions without prompting', () => {
    expect(shouldAllowBrowserPanelPermission('fullscreen', true)).toBe(true);
    expect(shouldAllowBrowserPanelPermission('clipboard-sanitized-write', true)).toBe(true);
    expect(shouldAllowBrowserPanelPermission('fullscreen', false)).toBe(false);
    expect(shouldAllowBrowserPanelPermission('clipboard-read', true)).toBe(false);
    expect(shouldAllowBrowserPanelPermission('media', true)).toBe(false);
  });

  it('prompts for privacy permissions only from the focused browser guest', () => {
    expect(shouldPromptBrowserPanelPermission('media', true)).toBe(true);
    expect(shouldPromptBrowserPanelPermission('geolocation', true)).toBe(true);
    expect(shouldPromptBrowserPanelPermission('notifications', true)).toBe(true);
    expect(shouldPromptBrowserPanelPermission('media', false)).toBe(false);
    expect(shouldPromptBrowserPanelPermission('display-capture', true)).toBe(false);
    expect(shouldPromptBrowserPanelPermission('clipboard-read', true)).toBe(false);
  });

  it.each([
    'mailto:team@example.com',
    'tel:+8613800138000',
    'sms:+8613800138000',
    'magnet:?xt=urn:btih:example',
    'webcal://example.com/calendar.ics',
  ])('allows the safe external URL %s', url => expect(isAllowedExternalBrowserUrl(url)).toBe(true));

  it.each(['https://example.com', 'file:///C:/secret.txt', 'javascript:1'])(
    'rejects the external URL %s',
    url => expect(isAllowedExternalBrowserUrl(url)).toBe(false),
  );
});

describe('isAllowedBrowserPanelUrl', () => {
  it('allows only blank and HTTP(S) guest navigation', () => {
    expect(isAllowedBrowserPanelUrl('')).toBe(true);
    expect(isAllowedBrowserPanelUrl('about:blank')).toBe(true);
    expect(isAllowedBrowserPanelUrl('https://example.com/path')).toBe(true);
    expect(isAllowedBrowserPanelUrl('http://localhost:43127')).toBe(true);
    expect(isAllowedBrowserPanelUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedBrowserPanelUrl('http://[::ffff:169.254.169.254]/')).toBe(false);
    expect(isAllowedBrowserPanelUrl('http://metadata.google.internal/')).toBe(false);
    expect(isAllowedBrowserPanelUrl('file:///C:/secrets.txt')).toBe(false);
    expect(isAllowedBrowserPanelUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedBrowserPanelUrl('data:text/html,hello')).toBe(false);
  });

  it('recognizes normalized cloud metadata addresses without blocking ordinary LAN hosts', () => {
    expect(isBlockedBrowserMetadataHost('169.254.1.2')).toBe(true);
    expect(isBlockedBrowserMetadataHost('100.100.100.200')).toBe(true);
    expect(isBlockedBrowserMetadataHost('fe80::1')).toBe(true);
    expect(isBlockedBrowserMetadataHost('fd00:ec2::254')).toBe(true);
    expect(isBlockedBrowserMetadataHost('192.168.1.10')).toBe(false);
    expect(isBlockedBrowserMetadataHost('127.0.0.1')).toBe(false);
  });
});

describe('isAllowedMainWindowNavigation', () => {
  it('keeps the privileged renderer on its application origin', () => {
    const options = {
      appRoot: 'C:\\app',
      devServerUrl: 'http://localhost:43127',
      isDev: true,
    };
    expect(isAllowedMainWindowNavigation('http://localhost:43127/settings', options)).toBe(true);
    expect(isAllowedMainWindowNavigation('https://example.com/', options)).toBe(false);
  });
});

describe('resolveBrowserGuestShortcut', () => {
  const input = (overrides: Partial<Parameters<typeof resolveBrowserGuestShortcut>[0]>) => ({
    type: 'keyDown',
    key: '',
    control: false,
    meta: false,
    alt: false,
    shift: false,
    ...overrides,
  });

  it('maps standard browser navigation and tab shortcuts', () => {
    expect(resolveBrowserGuestShortcut(input({ key: 'l', control: true }))).toBe('focus-address');
    expect(resolveBrowserGuestShortcut(input({ key: 't', meta: true }))).toBeNull();
    expect(resolveBrowserGuestShortcut(input({ key: 't', control: true, shift: true }))).toBe(
      'reopen-tab',
    );
    expect(resolveBrowserGuestShortcut(input({ key: 'w', control: true }))).toBe('close-tab');
    expect(resolveBrowserGuestShortcut(input({ key: 'F5' }))).toBe('reload');
    expect(resolveBrowserGuestShortcut(input({ key: 'ArrowLeft', alt: true }))).toBe('back');
    expect(resolveBrowserGuestShortcut(input({ key: 'Tab', control: true }))).toBe('next-tab');
    expect(resolveBrowserGuestShortcut(input({ key: 'Tab', control: true, shift: true }))).toBe(
      'previous-tab',
    );
  });

  it('resolves configured app shortcuts before browser-local commands', () => {
    const shortcutInput = {
      key: 'k',
      altKey: false,
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
    };
    expect(
      resolveBrowserPanelShortcutAction(shortcutInput, {
        terminal: 'Ctrl+K',
        browser: 'Ctrl+B',
        'side-chat': 'Ctrl+Alt+S',
        files: 'Ctrl+P',
        review: 'Ctrl+Shift+G',
      }),
    ).toBe('terminal');
    expect(
      resolveBrowserPanelShortcutAction(
        { ...shortcutInput, key: 'b' },
        {
          terminal: 'Ctrl+K',
          browser: 'Ctrl+B',
          'side-chat': 'Ctrl+Alt+S',
          files: 'Ctrl+P',
          review: 'Ctrl+Shift+G',
        },
      ),
    ).toBe('browser');
    expect(
      resolveBrowserPanelShortcutAction(
        { ...shortcutInput, key: 's', altKey: true },
        {
          terminal: 'Ctrl+K',
          browser: 'Ctrl+B',
          'side-chat': 'Ctrl+Alt+S',
          files: 'Ctrl+P',
          review: 'Ctrl+Shift+G',
        },
      ),
    ).toBe('side-chat');
    expect(
      resolveBrowserPanelShortcutAction(
        { ...shortcutInput, key: 'p' },
        {
          terminal: 'Ctrl+K',
          browser: 'Ctrl+B',
          'side-chat': 'Ctrl+Alt+S',
          files: 'Ctrl+P',
          review: 'Ctrl+Shift+G',
        },
      ),
    ).toBe('files');
  });

  it('does not intercept page typing or modified application shortcuts', () => {
    expect(resolveBrowserGuestShortcut(input({ key: 'l' }))).toBeNull();
    expect(resolveBrowserGuestShortcut(input({ key: 'i', control: true, shift: true }))).toBeNull();
    expect(
      resolveBrowserGuestShortcut(input({ type: 'keyUp', key: 'w', control: true })),
    ).toBeNull();
  });
});

describe('browser guest zoom', () => {
  it('accepts only one-step zoom directions and clamps the supported range', () => {
    expect(isBrowserGuestZoomDirection(1)).toBe(true);
    expect(isBrowserGuestZoomDirection(-1)).toBe(true);
    expect(isBrowserGuestZoomDirection(0)).toBe(false);
    expect(stepBrowserZoomFactor(1, 1)).toBe(1.1);
    expect(stepBrowserZoomFactor(1, -1)).toBe(0.9);
    expect(stepBrowserZoomFactor(2, 1)).toBe(2);
    expect(stepBrowserZoomFactor(0.5, -1)).toBe(0.5);
  });

  it('maps only primary-modified vertical wheel input to zoom steps', () => {
    expect(
      resolveBrowserGuestWheelZoomDirection({ ctrlKey: true, metaKey: false, deltaY: -1 }),
    ).toBe(1);
    expect(
      resolveBrowserGuestWheelZoomDirection({ ctrlKey: false, metaKey: true, deltaY: 1 }),
    ).toBe(-1);
    expect(
      resolveBrowserGuestWheelZoomDirection({ ctrlKey: false, metaKey: false, deltaY: -1 }),
    ).toBeNull();
    expect(
      resolveBrowserGuestWheelZoomDirection({ ctrlKey: true, metaKey: false, deltaY: 0 }),
    ).toBeNull();
  });
});
