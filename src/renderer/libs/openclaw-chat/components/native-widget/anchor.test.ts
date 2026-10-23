// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import { decodeNativeCanvasResult } from '../../pipeline/native-canvas';
import { NativeWidgetAnchor } from './anchor';
import type { NativeWidgetContext } from './host';
import { getNativeWidgetPresentations } from './presentations';
import type { NativeWidgetView } from './view';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('a standalone history keeps its widget within the original surface and updates its context', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const client = {
    generation: 1,
    gatewayUrl: 'ws://127.0.0.1:18789',
    request: vi.fn().mockResolvedValue({
      html: '<input value="Original">',
      sandboxPort: 18790,
      sandboxUrl: '/mcp-app-sandbox',
    }),
  };
  const context: NativeWidgetContext = {
    client,
    generation: 1,
    sessionKey: 'standalone',
    isCurrent: () => true,
    canDraft: () => false,
  };
  const surface = document.createElement('section');
  surface.style.cssText = 'position:absolute;z-index:60';
  document.body.append(surface);
  const anchor = new NativeWidgetAnchor();
  anchor.context = context;
  anchor.preview = decodeNativeCanvasResult(
    JSON.stringify({
      kind: 'canvas',
      presentation: { target: 'assistant_message', sandbox: 'scripts' },
      view: { id: 'standalone-widget' },
    }),
    'show_widget',
    'standalone-call',
  );
  surface.append(anchor);
  await anchor.updateComplete;
  const view = anchor.shadowRoot!.querySelector('justdo-native-widget') as NativeWidgetView;
  await view.updateComplete;
  expect(view.context).toBe(context);
  expect(view.getRootNode()).toBe(anchor.shadowRoot);
  expect(view.pinPresentation).toBeUndefined();
  expect(getNativeWidgetPresentations().entries).toHaveLength(0);
  surface.style.visibility = 'hidden';
  surface.setAttribute('inert', '');
  expect(anchor.shadowRoot!.querySelector('justdo-native-widget')).toBe(view);
  const next = { ...context, canDraft: () => true };
  anchor.context = next;
  await anchor.updateComplete;
  expect(view.context).toBe(next);
  expect(anchor.shadowRoot!.querySelector('justdo-native-widget')).toBe(view);
  expect(getNativeWidgetPresentations().entries).toHaveLength(0);
});
