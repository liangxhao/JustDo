// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import { decodeNativeBoardResult } from '../../pipeline/native-board';
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

test('board history uses the original anchor and one retained presentation across virtualization and sidebar projection', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const key = 'agent:main:board-presentation';
  const request = vi.fn(async (method: string) =>
    method === 'sessions.describe'
      ? {
          session: { key, agentId: 'main', sessionId: 'native-session', lifecycleRevision: 'life' },
        }
      : {
          sessionKey: key,
          widgets: [
            {
              name: 'earth',
              revision: 1,
              instanceId: 'native-instance',
              contentKind: 'html',
              contentOwner: 'html',
              grantState: 'pending',
              declared: { netOrigins: ['https://assets.example.test'] },
            },
          ],
        },
  );
  const owner = {};
  let current = true;
  const context: NativeWidgetContext = {
    client: {
      generation: 1,
      gatewayUrl: 'ws://127.0.0.1:18789',
      request,
    } as NativeWidgetContext['client'],
    generation: 1,
    sessionKey: key,
    sessionId: 'native-session',
    agentId: 'main',
    presentationScope: 'product-board',
    presentationOwner: owner,
    isCurrent: () => current,
    canDraft: () => false,
  };
  const preview = decodeNativeBoardResult(
    JSON.stringify({ status: 'pending', boardWidgetName: 'earth' }),
    'show_widget',
    'call',
  )!;
  const manager = getNativeWidgetPresentations();
  const anchor = new NativeWidgetAnchor();
  anchor.context = context;
  anchor.preview = preview;
  document.body.append(anchor);
  await anchor.updateComplete;
  for (let index = 0; index < 20; index++) await Promise.resolve();
  const entry = manager.entries.find(value => value.owner === owner)!;
  await entry.view.updateComplete;
  expect(entry.view.shadowRoot!.textContent).toContain('https://assets.example.test');
  expect(entry.view.shadowRoot!.querySelector('iframe,webview')).toBeNull();
  expect(request).toHaveBeenCalledTimes(3);
  anchor.remove();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(manager.entries).toContain(entry);
  const replacement = new NativeWidgetAnchor();
  replacement.context = context;
  replacement.preview = preview;
  document.body.append(replacement);
  await replacement.updateComplete;
  expect(manager.entries.filter(value => value.owner === owner)).toEqual([entry]);
  expect(entry.primary).toBe(replacement);
  vi.spyOn(entry.view, 'canPin', 'get').mockReturnValue(true);
  manager.pin(entry);
  const sidebar = document.createElement('section');
  document.body.append(sidebar);
  manager.setSidebar(entry, sidebar);
  manager.unpin(entry);
  expect(entry.pinned).toBe(false);
  expect(entry.primary).toBe(replacement);
  expect(request).toHaveBeenCalledTimes(3);
  current = false;
  replacement.context = undefined;
  manager.refresh(owner);
  await replacement.updateComplete;
  expect(manager.entries).not.toContain(entry);
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
