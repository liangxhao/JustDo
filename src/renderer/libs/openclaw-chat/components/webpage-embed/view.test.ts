// @vitest-environment jsdom
import {
  WEBPAGE_EMBED_OPEN_LINK_EVENT,
  type WebpageEmbedApi,
  type WebpageEmbedEvent,
  WebpageEmbedIpc,
  type WebpageEmbedMount,
} from '@shared/browser/webpageEmbed';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import type { WebpageEmbedContext } from './context';
import { WebpageEmbedView } from './page-view';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  let current = true;
  const listeners = new Set<(event: WebpageEmbedEvent) => void>();
  const api: WebpageEmbedApi = {
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    prepare: vi.fn(async input => ({
      mountId: input.mountId,
      partition: `page:${input.mountId}`,
      viewerUrl: `http://127.0.0.1:10000/embed-viewer.html?mount=${input.mountId}`,
    })),
    release: vi.fn(async () => undefined),
    retryProxy: vi.fn(async () => undefined),
    onEvent: vi.fn(listener => {
      listeners.add(listener);
      return vi.fn(() => { listeners.delete(listener); });
    }),
  };
  const context: WebpageEmbedContext = {
    sessionKey: 'agent:a:conversation',
    sessionId: 'native-sid',
    presentationOwner: {},
    isCurrent: () => current,
    openLink: vi.fn(),
  };
  const view = new WebpageEmbedView();
  view.api = api;
  view.context = context;
  view.preview = {
    kind: 'canvas',
    surface: 'assistant_message',
    render: 'url',
    url: 'https://example.test/page',
  };
  return {
    view,
    api,
    context,
    listeners,
    emitMain: (event: unknown) => {
      for (const listener of listeners) listener(event as WebpageEmbedEvent);
    },
    invalidate: () => {
      current = false;
    },
  };
}
async function settle(view: WebpageEmbedView) {
  await view.updateComplete;
  await Promise.resolve();
  await view.updateComplete;
  await Promise.resolve();
}
function emit(frame: Element, mountId: string, type: string) {
  const event = new Event('ipc-message');
  Object.assign(event, { channel: WebpageEmbedIpc.Event, args: [{ mountId, type }] });
  frame.dispatchEvent(event);
}
function mockDialog(view: WebpageEmbedView) {
  const dialog = view.shadowRoot!.querySelector('dialog')!;
  dialog.close = vi.fn(() => { dialog.open = false; });
  dialog.showModal = vi.fn(() => { dialog.open = true; });
  return dialog;
}

test('loads an independent webpage without a Widget tool result or application bridge', async () => {
  const { view, api } = fixture();
  document.body.append(view);
  await settle(view);
  const frame = view.shadowRoot!.querySelector('webview')!;
  expect(api.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      url: 'https://example.test/page',
      sessionKey: 'agent:a:conversation',
      sessionId: 'native-sid',
    }),
  );
  expect(frame.hasAttribute('preload')).toBe(false);
  expect(frame.hasAttribute('allowpopups')).toBe(true);
  expect(frame.getAttribute('partition')).toMatch(/^page:/);
  const mountId = vi.mocked(api.prepare).mock.calls[0][0].mountId;
  emit(frame, 'unrelated-mount', 'proxy-failed');
  await settle(view);
  expect(view.shadowRoot!.textContent).not.toContain(i18nService.t('webpageEmbedProxyFailed'));
  emit(frame, mountId, 'proxy-failed');
  await settle(view);
  expect(view.shadowRoot!.textContent).toContain(i18nService.t('webpageEmbedProxyFailed'));
  const retry = [...view.shadowRoot!.querySelectorAll('button')].find(
    button => button.textContent?.trim() === i18nService.t('coworkWidgetRetry'),
  )!;
  retry.click();
  expect(api.retryProxy).toHaveBeenCalledWith(mountId);
  expect(view.shadowRoot!.querySelector('webview')).toBe(frame);
  emit(frame, mountId, 'proxy-ready');
  await settle(view);
  expect(view.shadowRoot!.querySelector('webview')).toBe(frame);
  expect(api.prepare).toHaveBeenCalledTimes(1);
});

test('routes Main new-window links through the current conversation without replacing the webpage', async () => {
  const { view, api, context, emitMain, invalidate } = fixture();
  document.body.append(view);
  await settle(view);
  const frame = view.shadowRoot!.querySelector('webview')!;
  const mountId = vi.mocked(api.prepare).mock.calls[0][0].mountId;
  const request = { mountId, type: WEBPAGE_EMBED_OPEN_LINK_EVENT, url: 'https://destination.test/' };
  const pageEvent = new Event('ipc-message');
  Object.assign(pageEvent, { channel: WebpageEmbedIpc.Event, args: [request] });
  frame.dispatchEvent(pageEvent);
  emitMain({ ...request, mountId: 'other-mount' });
  for (const url of ['javascript:alert(1)', 'file:///file', 'https://user:pass@example.test/', null])
    emitMain({ ...request, url });
  expect(context.openLink).not.toHaveBeenCalled();

  const dialog = mockDialog(view);
  view.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="expand"]')!.click();
  await settle(view);
  expect(view.expanded).toBe(true);
  const openLink = vi.fn();
  view.context = { ...context, openLink };
  await settle(view);
  emitMain(request);
  expect(openLink).toHaveBeenCalledExactlyOnceWith(request.url);
  expect(context.openLink).not.toHaveBeenCalled();
  expect(view.expanded).toBe(false);
  expect(dialog.close).toHaveBeenCalled();
  await settle(view);
  expect(view.shadowRoot!.querySelector('webview')).toBe(frame);
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(api.release).not.toHaveBeenCalled();

  invalidate();
  emitMain(request);
  expect(openLink).toHaveBeenCalledTimes(1);
});

test('keeps hosted documents from requesting new windows', async () => {
  const { view } = fixture();
  view.preview = { kind: 'canvas', surface: 'assistant_message', render: 'url', ref: 'hosted-report' };
  document.body.append(view);
  await settle(view);
  expect(view.shadowRoot!.querySelector('webview')!.hasAttribute('allowpopups')).toBe(false);
});

test('accepts only current Main mount events and preserves the document during proxy changes', async () => {
  const { view, api, emitMain } = fixture();
  document.body.append(view);
  await settle(view);
  const frame = view.shadowRoot!.querySelector('webview')!;
  const initialSrc = (frame as HTMLElement & { src: string }).src;
  const mountId = vi.mocked(api.prepare).mock.calls[0][0].mountId;
  emitMain({ mountId: 'foreign', type: 'failure' });
  emitMain({ mountId, type: 'unknown' });
  emitMain(null);
  await settle(view);
  expect(api.release).not.toHaveBeenCalled();
  expect(view.shadowRoot!.querySelector('webview')).toBe(frame);

  emitMain({ mountId, type: 'proxy-pending' });
  await settle(view);
  expect(view.shadowRoot!.textContent).toContain(i18nService.t('webpageEmbedProxyPending'));
  emitMain({ mountId, type: 'proxy-failed' });
  await settle(view);
  expect(view.shadowRoot!.textContent).toContain(i18nService.t('webpageEmbedProxyFailed'));
  const retry = [...view.shadowRoot!.querySelectorAll('button')].find(
    button => button.textContent?.trim() === i18nService.t('coworkWidgetRetry'),
  )!;
  retry.click();
  expect(api.retryProxy).toHaveBeenCalledExactlyOnceWith(mountId);
  emitMain({ mountId, type: 'proxy-ready' });
  await settle(view);
  expect(view.shadowRoot!.textContent).not.toContain(i18nService.t('webpageEmbedProxyFailed'));
  expect(view.shadowRoot!.querySelector('webview')).toBe(frame);
  expect((frame as HTMLElement & { src: string }).src).toBe(initialSrc);
  expect(api.prepare).toHaveBeenCalledOnce();
  expect(api.release).not.toHaveBeenCalled();
});

test('unsubscribes retired guests and ignores late Main or shell events', async () => {
  const { view, api, listeners, emitMain } = fixture();
  document.body.append(view);
  await settle(view);
  const frame = view.shadowRoot!.querySelector('webview')!;
  const mountId = vi.mocked(api.prepare).mock.calls[0][0].mountId;
  const retiredListener = vi.mocked(api.onEvent).mock.calls[0][0];
  const unsubscribe = vi.mocked(api.onEvent).mock.results[0].value;
  emitMain({ mountId, type: 'failure' });
  await settle(view);
  expect(api.release).toHaveBeenCalledExactlyOnceWith(mountId);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
  expect(view.shadowRoot!.querySelector('webview')).toBeNull();
  retiredListener({ mountId, type: 'proxy-ready' });
  emit(frame, mountId, 'initialized');
  await settle(view);
  expect(view.shadowRoot!.textContent).toContain(i18nService.t('webpageEmbedUnavailable'));
  expect(view.shadowRoot!.querySelector('webview')).toBeNull();
  expect(api.prepare).toHaveBeenCalledOnce();
});

test('ignores cancelled and subframe loads while reporting real main-frame failures', async () => {
  const { view, api } = fixture();
  document.body.append(view);
  await settle(view);
  const frame = view.shadowRoot!.querySelector('webview')!;
  const failLoad = (errorCode: number, isMainFrame: boolean) => {
    const event = new Event('did-fail-load');
    Object.assign(event, { errorCode, isMainFrame });
    frame.dispatchEvent(event);
  };
  failLoad(-3, true);
  failLoad(-105, false);
  await settle(view);
  expect(view.shadowRoot!.querySelector('webview')).toBe(frame);
  expect(api.release).not.toHaveBeenCalled();
  failLoad(-105, true);
  await settle(view);
  expect(view.shadowRoot!.querySelector('webview')).toBeNull();
  expect(api.release).toHaveBeenCalledOnce();
});

test('keeps the same document through title, expansion and sidebar layout changes', async () => {
  const { view, api } = fixture();
  document.body.append(view);
  await settle(view);
  const frame = view.shadowRoot!.querySelector('webview');
  view.preview = { ...view.preview!, title: 'Updated title' };
  view.expanded = true;
  await settle(view);
  view.expanded = false;
  view.fillContainer = true;
  await settle(view);
  expect(view.shadowRoot!.querySelector('webview')).toBe(frame);
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(api.release).not.toHaveBeenCalled();
});

test('uses accessible icon actions and preserves the document through their presentation changes', async () => {
  const { view, api, context } = fixture();
  const pin = vi.fn();
  view.pinPresentation = pin;
  view.preview = { ...view.preview!, title: 'Business report' };
  document.body.append(view);
  await settle(view);
  mockDialog(view);
  const frame = view.shadowRoot!.querySelector('webview');
  const action = (name: string) =>
    view.shadowRoot!.querySelector<HTMLButtonElement>(`[data-action="${name}"]`);
  const open = action('open')!;
  expect(view.shadowRoot!.querySelector('header .title')?.textContent).toBe('Business report');
  expect(open.getAttribute('aria-label')).toBe(i18nService.t('webpageEmbedOpen'));
  expect(open.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(open.textContent?.trim()).toBe('');
  open.click();
  expect(context.openLink).toHaveBeenCalledExactlyOnceWith('https://example.test/page');
  expect(action('pin')?.getAttribute('aria-label')).toBe(i18nService.t('mcpAppsPin'));
  action('pin')!.click();
  expect(pin).toHaveBeenCalledOnce();

  action('expand')!.click();
  await settle(view);
  expect(action('expand')?.getAttribute('aria-label')).toBe(i18nService.t('coworkWidgetCollapse'));
  expect(action('expand')?.getAttribute('aria-expanded')).toBe('true');
  expect(action('pin')).toBeNull();
  expect(view.shadowRoot!.querySelector('webview')).toBe(frame);

  action('expand')!.click();
  await settle(view);
  expect(action('expand')?.getAttribute('aria-expanded')).toBe('false');
  expect(action('pin')).not.toBeNull();
  view.fillContainer = true;
  await settle(view);
  expect(action('pin')).toBeNull();
  expect(action('expand')?.disabled).toBe(false);
  view.fillContainer = false;
  await settle(view);
  expect(action('pin')).not.toBeNull();
  expect(view.shadowRoot!.querySelector('webview')).toBe(frame);
  expect(api.prepare).toHaveBeenCalledOnce();
  expect(api.release).not.toHaveBeenCalled();
});

test.each(['invalidate', 'unmount'])('standalone expansion uses the same modal document and cleans up on %s', async retirement => {
  const { view, api, invalidate } = fixture();
  const drawer = document.createElement('div');
  drawer.style.cssText = 'width:280px;height:300px;overflow:hidden';
  document.body.append(drawer);
  drawer.append(view);
  await settle(view);
  const dialog = mockDialog(view);
  const frame = view.shadowRoot!.querySelector('webview');
  const changed = vi.fn();
  view.presentationChanged = changed;
  const expand = () => view.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="expand"]')!.click();
  expand();
  await settle(view);
  expect(dialog.showModal).toHaveBeenCalledOnce();
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(changed).toHaveBeenCalledOnce();
  expect(view.presentationOverlay?.isConnected).toBe(true);
  const cancel = new Event('cancel', { cancelable: true });
  dialog.dispatchEvent(cancel);
  await settle(view);
  expect(cancel.defaultPrevented).toBe(true);
  expect(view.expanded).toBe(false);
  expect(dialog.open).toBe(true);
  expect(dialog.getAttribute('role')).toBe('group');
  expect(view.presentationOverlay).toBeUndefined();
  expect(changed).toHaveBeenCalledTimes(2);
  expand();
  await settle(view);
  expect(view.shadowRoot!.querySelector('webview')).toBe(frame);
  expect(api.prepare).toHaveBeenCalledOnce();
  expect(api.release).not.toHaveBeenCalled();
  if (retirement === 'invalidate') {
    invalidate();
    view.refreshPresentation();
    await settle(view);
    expect(view.expanded).toBe(false);
  } else view.remove();
  expect(view.presentationOverlay).toBeUndefined();
  expect(document.body.querySelector('[data-workspace-overlay="true"]')).toBeNull();
  expect(api.release).toHaveBeenCalledOnce();
});

test('keeps the hosted page browser action unavailable with an accessible explanation', async () => {
  const { view, context } = fixture();
  view.preview = { kind: 'canvas', surface: 'assistant_message', render: 'url', ref: 'report' };
  document.body.append(view);
  await settle(view);
  const open = view.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="open"]')!;
  expect(open.disabled).toBe(true);
  expect(open.getAttribute('aria-label')).toBe(i18nService.t('webpageEmbedOpen'));
  expect(open.title).toBe(i18nService.t('webpageEmbedHostedOpenUnavailable'));
  open.click();
  expect(context.openLink).not.toHaveBeenCalled();
});

test('stops the preparation notice when the shell is initialized without claiming page success', async () => {
  vi.useFakeTimers();
  const { view, api } = fixture();
  document.body.append(view);
  await settle(view);
  const frame = view.shadowRoot!.querySelector('webview')!;
  const mountId = vi.mocked(api.prepare).mock.calls[0][0].mountId;
  emit(frame, mountId, 'initialized');
  await vi.advanceTimersByTimeAsync(11_000);
  await settle(view);
  expect(view.shadowRoot!.textContent).not.toContain(i18nService.t('webpageEmbedSlow'));
  expect(view.shadowRoot!.querySelector('webview')).toBe(frame);
});

test('revokes stale preparation and never attaches its late result', async () => {
  const { view, api, invalidate } = fixture();
  let complete!: (value: WebpageEmbedMount) => void;
  vi.mocked(api.prepare).mockImplementation(
    input =>
      new Promise(resolve => {
        complete = value => resolve({ ...value, mountId: input.mountId });
      }),
  );
  document.body.append(view);
  await view.updateComplete;
  const mountId = vi.mocked(api.prepare).mock.calls[0][0].mountId;
  invalidate();
  view.context = undefined;
  await view.updateComplete;
  complete({ mountId, partition: 'stale', viewerUrl: 'http://127.0.0.1:10000/embed-viewer.html' });
  await settle(view);
  expect(view.shadowRoot!.querySelector('webview')).toBeNull();
  expect(api.release).toHaveBeenCalledWith(mountId);
});

test('shows paired fallback on unavailable content without admitting an MCP App as a webpage', async () => {
  const { view, api } = fixture();
  view.preview = { ...view.preview!, mcpApp: { viewId: 'app' }, fallbackText: 'Fallback report' };
  document.body.append(view);
  await settle(view);
  expect(api.prepare).not.toHaveBeenCalled();
  expect(view.shadowRoot!.textContent).toContain('Fallback report');
  expect(view.shadowRoot!.querySelector('webview')).toBeNull();
});
