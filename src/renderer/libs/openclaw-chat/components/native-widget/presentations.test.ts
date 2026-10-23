// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { decodeNativeCanvasResult } from '../../pipeline/native-canvas';
import { NativeWidgetAnchor } from './anchor';
import type { NativeWidgetContext } from './host';
import { getNativeWidgetPresentations, type NativeWidgetPresentationAnchor } from './presentations';
import { NativeWidgetView } from './view';

let release: () => void;
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(NativeWidgetView.prototype, 'canPin', 'get').mockImplementation(function (
    this: NativeWidgetView,
  ) {
    return this.context?.isCurrent() === true;
  });
  release = getNativeWidgetPresentations().retainWorkspace();
});
afterEach(async () => {
  release();
  document.body.replaceChildren();
  await new Promise(resolve => setTimeout(resolve, 20));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const owner = {};
  const request = vi.fn().mockResolvedValue({
    html: '<!doctype html><input value="local value">',
    sandboxPort: 18790,
    sandboxUrl: '/mcp-app-sandbox',
  });
  const client = { generation: 1, gatewayUrl: 'ws://127.0.0.1:18789', request };
  let current = true;
  const context = (overrides: Partial<NativeWidgetContext> = {}): NativeWidgetContext => ({
    client,
    generation: client.generation,
    sessionKey: 'agent:a:conversation',
    sessionId: 'incarnation',
    presentationScope: 'conversation',
    presentationOwner: owner,
    isCurrent: () => current,
    canDraft: () => true,
    ...overrides,
  });
  const preview = (id = 'widget-one') =>
    decodeNativeCanvasResult(
      JSON.stringify({
        kind: 'canvas',
        presentation: { target: 'assistant_message', sandbox: 'scripts', title: 'View title' },
        view: { id },
      }),
      'show_widget',
      'call-one',
    )!;
  const anchor = () => {
    const element = document.createElement('div') as unknown as NativeWidgetPresentationAnchor;
    element.presentationChanged = vi.fn();
    const rect = new DOMRect(20, 40, 600, 480);
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(element, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList);
    document.body.append(element);
    return element;
  };
  return {
    manager: getNativeWidgetPresentations(),
    owner,
    client,
    request,
    context,
    preview,
    anchor,
    invalidate: () => {
      current = false;
    },
  };
}

async function settle(view: NativeWidgetView): Promise<void> {
  await Promise.resolve();
  await view.updateComplete;
  await Promise.resolve();
  await view.updateComplete;
}

test('only admitted current widget descriptors can create a same-document presentation', () => {
  const f = fixture();
  const preview = f.preview();
  expect(f.manager.acquire(f.anchor(), { ...preview }, f.context())).toBeUndefined();
  expect(
    f.manager.acquire(f.anchor(), preview, f.context({ isCurrent: () => false })),
  ).toBeUndefined();
  expect(f.manager.acquire(f.anchor(), preview, f.context({ generation: 0 }))).toBeUndefined();
  expect(f.manager.entries).toHaveLength(0);
  const entry = f.manager.acquire(f.anchor(), preview, f.context())!;
  expect(entry.view.ownerDocument).toBe(document);
  expect(entry.layer.parentElement).toBe(document.body);
  expect(entry.preview).toBe(preview);
});

test('untitled widgets receive the same readable title as their message card', () => {
  const f = fixture();
  const preview = decodeNativeCanvasResult(
    JSON.stringify({
      kind: 'canvas',
      presentation: { target: 'assistant_message', sandbox: 'scripts' },
      view: { id: 'untitled-widget' },
    }),
    'show_widget',
    'call-untitled',
  )!;
  const entry = f.manager.acquire(f.anchor(), preview, f.context())!;
  expect(f.manager.title(entry).trim()).not.toBe('');
});

test('source occlusion revokes widget admission before the next layout timer', async () => {
  const f = fixture();
  const entry = f.manager.acquire(f.anchor(), f.preview(), f.context())!;
  await settle(entry.view);
  f.manager.layout();
  expect(entry.view.presentationVisible?.()).toBe(true);
  const modal = document.createElement('div');
  modal.dataset.workspaceOverlay = 'true';
  vi.spyOn(modal, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 800, 600),
  ] as unknown as DOMRectList);
  document.body.append(modal);
  expect(entry.visible).toBe(true);
  expect(entry.view.presentationVisible?.()).toBe(false);
});

test('pin, sidebar layout and return preserve the same widget and sandbox document', async () => {
  const f = fixture();
  const original = f.anchor();
  const entry = f.manager.acquire(original, f.preview(), f.context())!;
  await settle(entry.view);
  const frame = entry.view.shadowRoot!.querySelector('iframe')!;
  const frameWindow = frame.contentWindow;
  const reveal = vi.fn();
  const stop = f.manager.onReveal(reveal);
  f.manager.pin(entry);
  f.manager.setSidebar(entry, f.anchor());
  f.manager.layout();
  await settle(entry.view);
  expect(entry.pinned).toBe(true);
  expect(entry.view.fillContainer).toBe(true);
  expect(entry.visible).toBe(true);
  expect(reveal).toHaveBeenCalledWith(entry);
  f.manager.unpin(entry);
  f.manager.layout();
  await settle(entry.view);
  expect(entry.view.fillContainer).toBe(false);
  expect(entry.view.shadowRoot!.querySelector('iframe')).toBe(frame);
  expect(frame.contentWindow).toBe(frameWindow);
  expect(f.request).toHaveBeenCalledExactlyOnceWith('canvas.document.view', {
    docId: 'widget-one',
  });
  stop();
});

test.each([
  'client',
  'generation',
  'sessionKey',
  'sessionId',
  'presentationScope',
  'presentationOwner',
] as const)('different %s identities cannot take over a retained widget', property => {
  const f = fixture();
  const preview = f.preview();
  const first = f.manager.acquire(f.anchor(), preview, f.context())!;
  f.manager.pin(first);
  const overrides: Partial<NativeWidgetContext> = {};
  if (property === 'client') overrides.client = { ...f.client };
  if (property === 'generation') {
    overrides.client = { ...f.client, generation: 2 };
    overrides.generation = 2;
  }
  if (property === 'sessionKey') overrides.sessionKey = 'agent:a:other';
  if (property === 'sessionId') overrides.sessionId = 'replacement';
  if (property === 'presentationScope') overrides.presentationScope = 'other-conversation';
  if (property === 'presentationOwner') overrides.presentationOwner = {};
  const next = f.manager.acquire(f.anchor(), preview, f.context(overrides))!;
  expect(next).not.toBe(first);
  expect(next.view).not.toBe(first.view);
  expect(first.pinned).toBe(true);
  expect(next.pinned).toBe(false);
});

test('live-to-history replacement and returning without an anchor retain one widget', async () => {
  const f = fixture();
  const original = f.anchor();
  const preview = f.preview();
  const entry = f.manager.acquire(original, preview, f.context())!;
  f.manager.pin(entry);
  original.remove();
  f.manager.release(original, entry);
  f.manager.unpin(entry);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(entry.returnPending).toBe(true);
  expect(entry.view.isConnected).toBe(true);
  const history = f.anchor();
  expect(f.manager.acquire(history, f.preview(), f.context())).toBe(entry);
  expect(entry.returnPending).toBe(false);
  expect(entry.primary).toBe(history);
  expect(f.manager.entries).toHaveLength(1);
});

test.each(['pinned', 'returnPending'] as const)(
  'a replacement chat recovers its inactive %s widget with the exact native incarnation',
  async retention => {
    const f = fixture();
    const original = f.anchor();
    const entry = f.manager.acquire(original, f.preview(), f.context())!;
    await settle(entry.view);
    f.manager.pin(entry);
    if (retention === 'returnPending') {
      original.remove();
      f.manager.release(original, entry);
      f.manager.unpin(entry);
    }
    f.invalidate();
    f.manager.refresh(f.owner);
    await settle(entry.view);
    const owner = {};
    const context = f.context({ presentationOwner: owner, isCurrent: () => true });
    const anchor = f.anchor();
    const recovered = f.manager.acquire(anchor, f.preview(), context)!;
    await settle(recovered.view);
    expect(recovered).toBe(entry);
    expect(recovered.owner).toBe(owner);
    expect(recovered.primary).toBe(anchor);
    expect(recovered.pinned).toBe(retention === 'pinned');
    expect(recovered.returnPending).toBe(false);
    expect(recovered.view.context).toBe(context);
    expect(f.manager.entries).toHaveLength(1);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.manager.refresh(f.owner);
    expect(recovered.view.context).toBe(context);
  },
);

test.each(['client', 'generation', 'sessionKey', 'sessionId', 'presentationScope'] as const)(
  'an inactive retained widget rejects a replacement owner with a different %s',
  property => {
    const f = fixture();
    const entry = f.manager.acquire(f.anchor(), f.preview(), f.context())!;
    f.manager.pin(entry);
    f.invalidate();
    f.manager.refresh(f.owner);
    const overrides: Partial<NativeWidgetContext> = {
      presentationOwner: {},
      isCurrent: () => true,
    };
    if (property === 'client') overrides.client = { ...f.client };
    if (property === 'generation') {
      overrides.client = { ...f.client, generation: 2 };
      overrides.generation = 2;
    }
    if (property === 'sessionKey') overrides.sessionKey = 'agent:a:other';
    if (property === 'sessionId') overrides.sessionId = 'replacement';
    if (property === 'presentationScope') overrides.presentationScope = 'other-conversation';
    expect(f.manager.acquire(f.anchor(), f.preview(), f.context(overrides))).not.toBe(entry);
    expect(entry.view.context).toBeUndefined();
  },
);

test('a replacement owner cannot recover a retained widget without a physical incarnation', () => {
  const f = fixture();
  const entry = f.manager.acquire(f.anchor(), f.preview(), f.context({ sessionId: undefined }))!;
  f.manager.pin(entry);
  f.invalidate();
  f.manager.refresh(f.owner);
  const next = f.manager.acquire(
    f.anchor(),
    f.preview(),
    f.context({ sessionId: undefined, presentationOwner: {}, isCurrent: () => true }),
  );
  expect(next).not.toBe(entry);
  expect(entry.view.context).toBeUndefined();
});

test('the exact owner can refresh anchorless widgets but cannot replace their native identity', async () => {
  const f = fixture();
  const original = f.anchor();
  const entry = f.manager.acquire(original, f.preview(), f.context())!;
  f.manager.pin(entry);
  original.remove();
  f.manager.release(original, entry);
  const fresh = f.context({ canDraft: () => false });
  f.manager.refresh({}, undefined);
  expect(entry.view.context).toBeDefined();
  f.manager.refresh(f.owner, fresh);
  expect(entry.view.context).toBe(fresh);
  f.manager.refresh(f.owner, f.context({ sessionId: 'replacement' }));
  await settle(entry.view);
  f.manager.layout();
  expect(entry.view.context).toBeUndefined();
  expect(entry.visible).toBe(false);
  expect(entry.view.shadowRoot!.querySelector('iframe')).toBeNull();
});

test('hidden and occluded presentation targets revoke visibility without moving the widget', () => {
  const f = fixture();
  const entry = f.manager.acquire(f.anchor(), f.preview(), f.context())!;
  f.manager.layout();
  expect(entry.visible).toBe(true);
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  const rect = new DOMRect(50, 60, 100, 100);
  vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(rect);
  vi.spyOn(menu, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList);
  document.body.append(menu);
  f.manager.layout();
  expect(entry.visible).toBe(false);
  expect(entry.layer.style.display).toBe('none');
  expect(entry.view.isConnected).toBe(true);
  menu.remove();
  f.manager.layout();
  expect(entry.visible).toBe(true);
  f.invalidate();
  f.manager.layout();
  expect(entry.visible).toBe(false);
});

test.each(['visibility', 'inert', 'aria-hidden'] as const)(
  'an expanded widget respects its source ancestor %s',
  async hiddenBy => {
    const f = fixture();
    const surface = document.createElement('section');
    const shadow = surface.attachShadow({ mode: 'open' });
    document.body.append(surface);
    const anchor = f.anchor();
    shadow.append(anchor);
    const entry = f.manager.acquire(anchor, f.preview(), f.context())!;
    await settle(entry.view);
    entry.view.shadowRoot!.querySelector('dialog')!.close = vi.fn();
    f.manager.layout();
    entry.view.expanded = true;
    Reflect.set(entry.view, 'suggestion', 'Old selection');
    if (hiddenBy === 'visibility') surface.style.visibility = 'hidden';
    else surface.setAttribute(hiddenBy, 'true');
    f.manager.layout();
    await settle(entry.view);
    expect(entry.visible).toBe(false);
    expect(entry.view.expanded).toBe(false);
    expect(entry.layer.style.display).toBe('none');
    expect(Reflect.get(entry.view, 'suggestion')).toBe('');
  },
);

test('an expanded widget ignores only its own overlay and still yields to another modal', async () => {
  const f = fixture();
  const entry = f.manager.acquire(f.anchor(), f.preview(), f.context())!;
  await settle(entry.view);
  entry.view.shadowRoot!.querySelector('dialog')!.close = vi.fn();
  const own = document.createElement('div');
  own.dataset.workspaceOverlay = 'true';
  document.body.append(own);
  vi.spyOn(own, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 600, 480),
  ] as unknown as DOMRectList);
  Reflect.set(entry.view, 'workspaceOverlay', own);
  entry.view.expanded = true;
  f.manager.layout();
  expect(entry.visible).toBe(true);
  expect(entry.view.expanded).toBe(true);
  const other = document.createElement('div');
  other.dataset.workspaceOverlay = 'true';
  document.body.append(other);
  vi.spyOn(other, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 600, 480),
  ] as unknown as DOMRectList);
  f.manager.layout();
  expect(entry.visible).toBe(false);
  expect(entry.view.expanded).toBe(false);
});

test('scope deletion and the final workspace release dispose retained widgets', async () => {
  const f = fixture();
  const deleted = f.manager.acquire(f.anchor(), f.preview(), f.context())!;
  f.manager.pin(deleted);
  f.manager.reconcileScopes(new Set(['another-conversation']));
  expect(f.manager.entries).toHaveLength(0);
  expect(deleted.view.isConnected).toBe(false);
  const remaining = f.manager.acquire(f.anchor(), f.preview('widget-two'), f.context())!;
  f.manager.pin(remaining);
  release();
  release = () => undefined;
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.manager.entries).toHaveLength(0);
  expect(remaining.view.isConnected).toBe(false);
});

test('standalone history widgets follow their anchors rather than the product session list', async () => {
  const f = fixture();
  const anchor = f.anchor();
  const entry = f.manager.acquire(
    anchor,
    f.preview(),
    f.context({ presentationScope: undefined }),
  )!;
  f.manager.reconcileScopes(new Set(['another-conversation']));
  release();
  release = () => undefined;
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.manager.entries).toContain(entry);
  expect(entry.view.isConnected).toBe(true);
  expect(entry.view.pinPresentation).toBeUndefined();
  anchor.remove();
  f.manager.release(anchor, entry);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.manager.entries).not.toContain(entry);
  expect(entry.view.isConnected).toBe(false);
});

test.each(['context', 'preview'] as const)(
  'an anchor releases its admitted widget when its %s is withdrawn',
  async property => {
    const f = fixture();
    const anchor = new NativeWidgetAnchor();
    anchor.context = f.context();
    anchor.preview = f.preview();
    document.body.append(anchor);
    await anchor.updateComplete;
    const entry = f.manager.entries[0];
    expect(entry).toBeDefined();
    if (property === 'context') anchor.context = undefined;
    else anchor.preview = { ...anchor.preview! };
    await anchor.updateComplete;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.manager.entries).toHaveLength(0);
    expect(entry.view.isConnected).toBe(false);
  },
);
