/** @vitest-environment jsdom */
import './justdo-chat';

import { BrowserLinkTarget } from '@shared/browser/browserLinkOpening';
import { afterEach, expect, test, vi } from 'vitest';

import { defaultConfig } from '@/app/config';
import { MessageBrowserEvent, openMessageWebLink } from '@/features/browser/messageBrowserLinks';
import { configService } from '@/services/config';

import type { JustDoChatElement } from './justdo-chat';
import { toSanitizedMarkdownHtml } from './markdown';
import { handleMessageLinkClick } from './message-content-interactions';

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'electron');
  vi.restoreAllMocks();
});

test.each([BrowserLinkTarget.Embedded, BrowserLinkTarget.Chrome])(
  'preserves %s link preferences and local HTML context in another document',
  async target => {
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...defaultConfig,
      browserWebLinkTarget: target,
    });
    const openInChrome = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { browser: { openInChrome } },
    });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const child = frame.contentDocument!;
    const realm = frame.contentWindow! as Window & typeof globalThis;
    child.body.innerHTML =
      '<a href="https://example.com/report.html?q=1#chart"><strong>Web report</strong></a>' +
      '<a data-local-html-path="output/report.html" data-local-html-suffix="#chart"><strong>Local report</strong></a>';
    child.body.addEventListener('click', event => {
      handleMessageLinkClick(event, 'C:\\project');
    });

    for (const strong of child.querySelectorAll('strong')) {
      const click = new realm.MouseEvent('click', { bubbles: true, cancelable: true });
      strong.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
    }
    await Promise.resolve();

    if (target === BrowserLinkTarget.Chrome) {
      expect(openInChrome).toHaveBeenCalledWith('https://example.com/report.html?q=1#chart');
    } else {
      expect(openInChrome).not.toHaveBeenCalled();
      const webEvent = dispatch.mock.calls.find(
        ([event]) => event.type === MessageBrowserEvent.OpenWebUrl,
      )?.[0] as CustomEvent;
      expect(webEvent.detail.url).toBe('https://example.com/report.html?q=1#chart');
    }
    const htmlEvent = dispatch.mock.calls.find(
      ([event]) => event.type === MessageBrowserEvent.OpenLocalHtml,
    )?.[0] as CustomEvent;
    expect(htmlEvent.detail).toEqual({
      filePath: 'output/report.html',
      workingDirectory: 'C:\\project',
      navigationSuffix: '#chart',
    });
  },
);

test('shows a failed Chrome launch without opening a built-in tab', async () => {
  vi.spyOn(configService, 'getConfig').mockReturnValue({
    ...defaultConfig,
    browserWebLinkTarget: BrowserLinkTarget.Chrome,
  });
  const openInChrome = vi.fn().mockResolvedValue({ success: false });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { browser: { openInChrome } },
  });
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  await openMessageWebLink('https://example.com');
  expect(dispatch.mock.calls.some(([event]) => event.type === 'app:showToast')).toBe(true);
  expect(dispatch.mock.calls.some(([event]) => event.type === MessageBrowserEvent.OpenWebUrl)).toBe(
    false,
  );
});

test.each([BrowserLinkTarget.Embedded, BrowserLinkTarget.Chrome])(
  'opens a nested web anchor in %s without native navigation',
  async target => {
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...defaultConfig,
      browserWebLinkTarget: target,
    });
    const openInChrome = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { browser: { openInChrome } },
    });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    document.body.append(chat);
    await chat.updateComplete;
    const container = document.createElement('div');
    container.innerHTML =
      '<a href="https://example.com/report.html?q=1#chart"><strong>Report</strong></a>';
    chat.shadowRoot!.append(container);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    container.querySelector('strong')!.dispatchEvent(click);
    await Promise.resolve();
    expect(click.defaultPrevented).toBe(true);
    if (target === BrowserLinkTarget.Chrome) {
      expect(openInChrome).toHaveBeenCalledWith('https://example.com/report.html?q=1#chart');
    } else {
      expect(openInChrome).not.toHaveBeenCalled();
      expect(
        dispatch.mock.calls.some(
          ([event]) =>
            event instanceof CustomEvent &&
            event.type === MessageBrowserEvent.OpenWebUrl &&
            event.detail.url === 'https://example.com/report.html?q=1#chart',
        ),
      ).toBe(true);
    }
  },
);

test.each([
  { source: '[Report](output/report.html)', filePath: 'output/report.html' },
  { source: '[Report](<output/100%.html>)', filePath: 'output/100%.html' },
  { source: 'See C:\\project\\100%.html for the results.', filePath: 'C:\\project\\100%.html' },
  {
    source: '[Report](output/report.html?view=compact#chart)',
    filePath: 'output/report.html',
    navigationSuffix: '?view=compact#chart',
  },
  {
    source: '[Report](file:///C:/project/report.html#chart)',
    filePath: 'file:///C:/project/report.html',
    navigationSuffix: '#chart',
  },
])(
  'opens an HTML link with its conversation working directory: $source',
  async ({ source, filePath, navigationSuffix }) => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.workingDirectory = 'C:\\project';
    document.body.append(chat);
    await chat.updateComplete;
    const container = document.createElement('div');
    container.innerHTML = toSanitizedMarkdownHtml(source);
    chat.shadowRoot!.append(container);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    container.querySelector('a')!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    const event = dispatch.mock.calls.find(
      ([event]) => event.type === MessageBrowserEvent.OpenLocalHtml,
    )?.[0] as CustomEvent;
    expect(event.detail).toEqual({
      filePath,
      workingDirectory: 'C:\\project',
      ...(navigationSuffix ? { navigationSuffix } : {}),
    });
  },
);
