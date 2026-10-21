// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { McpAppSession } from '../../gateway/mcp-app/mcp-app-session';
import { decodeMcpAppLaunch } from '../../pipeline/native-mcp-app';
import { getMcpAppPresentations, type McpAppPresentationAnchor } from './presentations';
import { McpAppView, type McpAppViewContext } from './view';

let release: () => void;
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(McpAppView.prototype, 'canReference', 'get').mockImplementation(function (
    this: McpAppView,
  ) {
    return this.context?.isCurrent() === true && !this.closed;
  });
  release = getMcpAppPresentations().retainWorkspace();
});
afterEach(async () => {
  release();
  document.body.replaceChildren();
  await new Promise(resolve => setTimeout(resolve, 30));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  let sessionId = 'incarnation';
  const request = vi.fn((_method: string) => new Promise<never>(() => {}));
  const client = { generation: 1, gatewayUrl: 'ws://127.0.0.1', request };
  const apps = new McpAppSession(() => ({
    client: client as never,
    generation: client.generation,
    sessionKey: 'agent:a:chat',
    sessionId,
    agentId: 'a',
    isCurrent: () => true,
  }));
  const context = (): McpAppViewContext => {
    const captured = sessionId;
    return {
      apps,
      sessionKey: 'agent:a:chat',
      presentationScope: 'conversation',
      isCurrent: () => sessionId === captured,
      canDraft: () => true,
      addDraft: async () => false,
      resume: () => (sessionId === captured ? context() : undefined),
    };
  };
  const preview = (id = 'mcp-app-one', server = 'example') =>
    decodeMcpAppLaunch({
      viewId: id,
      preview: {
        kind: 'canvas',
        mcpApp: {
          viewId: id,
          serverName: server,
          toolName: 'show',
          uiResourceUri: `ui://${server}/app`,
        },
        view: { id, title: 'Same title' },
        presentation: { target: 'assistant_message', sandbox: 'scripts' },
      },
    })!;
  const anchor = () => {
    const element = document.createElement('div') as unknown as McpAppPresentationAnchor;
    element.presentationChanged = vi.fn();
    document.body.append(element);
    return element;
  };
  return {
    manager: getMcpAppPresentations(),
    request,
    context,
    preview,
    anchor,
    replaceSession: () => {
      sessionId = 'replacement';
    },
  };
}

test('same admitted view shares one presentation; pin and unpin never close or launch an App', async () => {
  const f = fixture(),
    preview = f.preview();
  const entry = f.manager.acquire(f.anchor(), preview, f.context())!;
  expect(f.manager.acquire(f.anchor(), preview, f.context())).toBe(entry);
  const close = vi.spyOn(entry.view, 'closeApp');
  const reveal = vi.fn(),
    stop = f.manager.onReveal(reveal);
  f.manager.pin(entry);
  f.manager.pin(entry);
  expect(f.manager.entries).toHaveLength(1);
  expect(entry.pinned).toBe(true);
  const ordinal = entry.ordinal;
  f.manager.unpin(entry);
  f.manager.pin(entry);
  expect(entry.ordinal).toBe(ordinal);
  expect(entry.preview).toBe(preview);
  expect(entry.view.context?.sessionKey).toBe('agent:a:chat');
  expect(close).not.toHaveBeenCalled();
  expect(f.request.mock.calls.every(args => args[0] === 'mcp.app.view')).toBe(true);
  stop();
});

test('copied or identity-mutated descriptors cannot create or merge a presentation', () => {
  const f = fixture(),
    preview = f.preview();
  expect(f.manager.acquire(f.anchor(), { ...preview }, f.context())).toBeUndefined();
  preview.descriptor!.serverName = 'other';
  expect(f.manager.acquire(f.anchor(), preview, f.context())).toBeUndefined();
  expect(f.manager.entries).toHaveLength(0);
});

test('same title and different views stay independent, with stable per-app ordinals', () => {
  const f = fixture();
  const one = f.manager.acquire(f.anchor(), f.preview(), f.context())!;
  const two = f.manager.acquire(f.anchor(), f.preview('mcp-app-two'), f.context())!;
  const other = f.manager.acquire(f.anchor(), f.preview('mcp-app-other', 'other'), f.context())!;
  expect([one.ordinal, two.ordinal, other.ordinal]).toEqual([1, 2, 1]);
  expect(f.manager.title(two)).toBe('Same title · #2');
  expect(f.manager.title(other)).toBe('Same title');
  f.manager.pin(one);
  f.manager.pin(two);
  expect(f.manager.entries.filter(entry => entry.pinned)).toHaveLength(2);
});

test('an unpinned reference waits for its history anchor without disposing its App', async () => {
  const f = fixture(),
    original = f.anchor(),
    preview = f.preview();
  const entry = f.manager.acquire(original, preview, f.context())!;
  f.manager.pin(entry);
  original.remove();
  f.manager.release(original, entry);
  f.manager.unpin(entry);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(entry.returnPending).toBe(true);
  expect(entry.view.isConnected).toBe(true);
  const returned = f.manager.acquire(f.anchor(), preview, f.context())!;
  expect(returned).toBe(entry);
  expect(returned.returnPending).toBe(false);
  expect(returned.view.fillContainer).toBe(false);
});

test('replacement native incarnations cannot take over the original retained instance', () => {
  const f = fixture(),
    preview = f.preview();
  const old = f.manager.acquire(f.anchor(), preview, f.context())!;
  f.manager.pin(old);
  f.replaceSession();
  const next = f.manager.acquire(f.anchor(), preview, f.context())!;
  expect(next).not.toBe(old);
  expect(next.view).not.toBe(old.view);
  expect(old.view.context?.isCurrent()).toBe(false);
  expect(old.pinned).toBe(true);
  expect(next.pinned).toBe(false);
});

test('history disposal keeps only UI numbering so the same target returns with its original ordinal', async () => {
  const f = fixture(),
    anchor = f.anchor(),
    preview = f.preview();
  const entry = f.manager.acquire(anchor, preview, f.context())!;
  f.manager.pin(entry);
  f.manager.unpin(entry);
  anchor.remove();
  f.manager.release(anchor, entry);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(entry.view.isConnected).toBe(false);
  f.manager.acquire(f.anchor(), f.preview('mcp-app-two'), f.context());
  const returned = f.manager.acquire(f.anchor(), preview, f.context())!;
  expect(returned).not.toBe(entry);
  expect(returned.ordinal).toBe(entry.ordinal);
});

test('deleting an initialized conversation scope disposes its retained reference', () => {
  const f = fixture();
  const entry = f.manager.acquire(f.anchor(), f.preview(), f.context())!;
  f.manager.pin(entry);
  f.manager.reconcileScopes(new Set(['another-conversation']));
  expect(f.manager.entries).toHaveLength(0);
  expect(entry.view.isConnected).toBe(false);
});
