/** @vitest-environment jsdom */
import './justdo-chat';

import { BrowserLinkTarget } from '@shared/browser/browserLinkOpening';
import { MessageFileLinkSourceKind } from '@shared/preview/messageFileLink';
import { render } from 'lit';
import { afterEach, expect, test, vi } from 'vitest';

import { defaultConfig } from '@/app/config';
import { MessageBrowserEvent, openMessageWebLink } from '@/features/browser/messageBrowserLinks';
import { configService } from '@/services/config';

import type { JustDoChatElement } from './justdo-chat';
import { toSanitizedMarkdownHtml } from './markdown/markdown';
import { handleMessageLinkClick } from './message/message-content-interactions';
import { renderAssistantTimelineContent } from './message/message-render';

test.each([false, true])(
  'assistant timeline forwards file capability while streaming=%s',
  streaming => {
    const container = document.createElement('div');
    const openFile = vi.fn();
    render(
      renderAssistantTimelineContent('[Book](<./output/My book.pdf>)\n\n', {
        key: 'content',
        timestamp: 1,
        streaming,
        onOpenFile: openFile,
      }),
      container,
    );
    const anchor = container.querySelector('[data-message-file-target]');
    expect(anchor?.getAttribute('data-message-file-target')).toBe('./output/My%20book.pdf');
  },
);

test.each(['user', 'assistant'])(
  'enables file links for %s messages only with a workspace opener',
  async role => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.messages = [{ role, content: '[Report](<C:/project/My book.pdf>)', timestamp: 1 }];
    document.body.append(chat);
    await chat.updateComplete;
    expect(chat.shadowRoot!.querySelector('[data-message-file-target]')).toBeNull();

    const openFile = vi.fn();
    chat.onOpenFile = openFile;
    await chat.updateComplete;
    const anchor = chat.shadowRoot!.querySelector<HTMLAnchorElement>('[data-message-file-target]');
    expect(anchor).not.toBeNull();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    anchor!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openFile).toHaveBeenCalledWith({
      sourceKind: MessageFileLinkSourceKind.MarkdownUri,
      target: 'C:/project/My%20book.pdf',
      navigationSuffix: undefined,
    });
    expect(dispatch.mock.calls.some(([event]) => event.type === 'cowork:preview-file')).toBe(false);

    chat.onOpenFile = undefined;
    await chat.updateComplete;
    expect(chat.shadowRoot!.querySelector('[data-message-file-target]')).toBeNull();
  },
);

test('file clicks return a synchronous handled result and preserve the encoded target', () => {
  const container = document.createElement('div');
  container.innerHTML = '<a href="#"><strong>Report</strong></a>';
  const anchor = container.querySelector('a')!;
  anchor.setAttribute('data-message-file-kind', MessageFileLinkSourceKind.FileUrl);
  anchor.setAttribute('data-message-file-target', 'file:///C:/project/My%20book.pdf');
  const openFile = vi.fn();
  let handled: unknown;
  container.addEventListener('click', event => {
    handled = handleMessageLinkClick(event, 'old/message/directory', openFile);
  });
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  container.querySelector('strong')!.dispatchEvent(event);
  expect(handled).toBe(true);
  expect(event.defaultPrevented).toBe(true);
  expect(openFile).toHaveBeenCalledWith({
    sourceKind: MessageFileLinkSourceKind.FileUrl,
    target: 'file:///C:/project/My%20book.pdf',
    navigationSuffix: undefined,
  });
});

test('routes legacy HTML through the receiving workspace without a global file event', async () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const openFile = vi.fn();
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.onOpenFile = openFile;
  document.body.append(chat);
  await chat.updateComplete;
  const container = document.createElement('div');
  container.innerHTML = toSanitizedMarkdownHtml('[Report](output/report.html#chart)');
  chat.shadowRoot!.append(container);
  container
    .querySelector('a')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
  expect(openFile).toHaveBeenCalledWith(
    {
      sourceKind: MessageFileLinkSourceKind.NativePath,
      target: 'output/report.html',
      navigationSuffix: '#chart',
    },
    { legacyHtml: true },
  );
  expect(
    dispatch.mock.calls.some(([event]) => event.type === MessageBrowserEvent.OpenLocalHtml),
  ).toBe(false);
});

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
