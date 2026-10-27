// @vitest-environment jsdom
import type { WebpageEmbedApi } from '@shared/browser/webpageEmbed';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { WebpageEmbedContext } from './context';
import type { WebpageEmbedView } from './page-view';
import { getWebpageEmbedPresentations, type WebpageEmbedPresentationAnchor } from './presentations';

let release: () => void;
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  release = getWebpageEmbedPresentations().retainWorkspace();
});
afterEach(async () => {
  release();
  document.body.replaceChildren();
  await new Promise(resolve => setTimeout(resolve, 20));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function settle(view: WebpageEmbedView) {
  await view.updateComplete;
  await Promise.resolve();
  await view.updateComplete;
}
function fixture() {
  const owner = {};
  const context: WebpageEmbedContext = {
    sessionKey: 'agent:a:conversation',
    sessionId: 'native-sid',
    presentationScope: 'product-session',
    presentationOwner: owner,
    isCurrent: () => true,
  };
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
    onEvent: vi.fn(() => vi.fn()),
  };
  const anchor = () => {
    const element = document.createElement('div') as unknown as WebpageEmbedPresentationAnchor;
    element.presentationChanged = vi.fn();
    const rect = new DOMRect(20, 40, 600, 480);
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(element, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList);
    document.body.append(element);
    return element;
  };
  const preview = {
    kind: 'canvas' as const,
    surface: 'assistant_message' as const,
    render: 'url' as const,
    url: 'https://example.test/report',
  };
  return { owner, context, api, anchor, preview, manager: getWebpageEmbedPresentations() };
}

test('pin, expansion, sidebar docking and row replacement retain the original webpage document', async () => {
  const f = fixture();
  const original = f.anchor();
  const entry = f.manager.acquire(original, f.preview, f.context, f.api)!;
  await settle(entry.view);
  entry.view.shadowRoot!.querySelector('dialog')!.close = vi.fn();
  const frame = entry.view.shadowRoot!.querySelector('webview');
  expect(frame).not.toBeNull();
  f.manager.pin(entry);
  const sidebar = f.anchor();
  f.manager.setSidebar(entry, sidebar);
  f.manager.layout();
  entry.view.expanded = true;
  await settle(entry.view);
  f.manager.layout();
  expect(entry.view.shadowRoot!.querySelector('webview')).toBe(frame);
  f.manager.unpin(entry);
  original.remove();
  f.manager.release(original, entry);
  const replacement = f.anchor();
  expect(f.manager.acquire(replacement, { ...f.preview }, { ...f.context }, f.api)).toBe(entry);
  await settle(entry.view);
  expect(entry.view.shadowRoot!.querySelector('webview')).toBe(frame);
  expect(f.api.prepare).toHaveBeenCalledTimes(1);
});

test('the expand button schedules fullscreen layout without a resize or scroll', async () => {
  const f = fixture();
  const entry = f.manager.acquire(f.anchor(), f.preview, f.context, f.api)!;
  await settle(entry.view);
  await new Promise(resolve => setTimeout(resolve, 25));
  const dialog = entry.view.shadowRoot!.querySelector('dialog')!;
  dialog.close = vi.fn(() => { dialog.open = false; });
  dialog.showModal = vi.fn(() => { dialog.open = true; });
  const frame = entry.view.shadowRoot!.querySelector('webview');
  const layout = vi.spyOn(f.manager, 'layout');
  entry.view.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="expand"]')!.click();
  await settle(entry.view);
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(layout).toHaveBeenCalled();
  expect(entry.layer.style.inset).toBe('0px');
  expect(entry.view.shadowRoot!.querySelector('webview')).toBe(frame);
  expect(f.api.prepare).toHaveBeenCalledOnce();
  entry.view.collapsePresentation();
  await settle(entry.view);
});

test('session invalidation revokes the mount and late contexts cannot restore old network authority', async () => {
  const f = fixture();
  const entry = f.manager.acquire(f.anchor(), f.preview, f.context, f.api)!;
  await settle(entry.view);
  f.manager.refresh(f.owner);
  await settle(entry.view);
  expect(entry.view.shadowRoot!.querySelector('webview')).toBeNull();
  expect(f.api.release).toHaveBeenCalled();
  const invalid = { ...f.context, isCurrent: () => false };
  expect(f.manager.acquire(f.anchor(), f.preview, invalid, f.api)).toBeUndefined();
  expect(f.api.prepare).toHaveBeenCalledTimes(1);
});
