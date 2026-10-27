// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNativeBoardResult, markNativeBoardRealtime } from '../../pipeline/native-board';
import type { NativeWidgetContext } from '../native-widget/host';
import { NativeBoardWidgetController } from './controller';
import { readBoardHtml, readCurrentBoard, validateFrameUrl } from './loader';

const sessionKey = 'agent:main:board-test';
const generation = 'a'.repeat(32);
const csp = btoa('{}').replace(/=+$/, '');
const sandboxUrl = `/mcp-app-sandbox?csp=${csp}&v=${'a'.repeat(64)}`;
const flush = async () => {
  for (let index = 0; index < 35; index++) await Promise.resolve();
};
function fixture(
  grantState: 'pending' | 'granted' | 'rejected' | 'none' = 'none',
  realtime = false,
) {
  const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
  let revision = 'life-1';
  let current = true;
  const widget = {
    name: 'earth',
    revision: 1,
    instanceId: 'instance-native',
    contentKind: 'html',
    contentOwner: 'html',
    grantState,
    declared: { netOrigins: [] as string[] },
    viewGeneration: generation,
    frameUrl: `/__openclaw__/board/${encodeURIComponent(sessionKey)}/earth/index.html?bt=ticket`,
    sandboxPort: 18790,
    sandboxUrl,
  };
  const widgets = [widget];
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === 'sessions.describe')
      return {
        session: {
          key: sessionKey,
          agentId: 'main',
          sessionId: 'session-1',
          lifecycleRevision: revision,
        },
      };
    if (method === 'board.get') return { sessionKey, widgets };
    throw new Error('Unexpected request');
  });
  const client = {
    generation: 1,
    gatewayUrl: 'ws://127.0.0.1:18789',
    request,
    subscribeEvents: (listener: (event: { event: string; payload?: unknown }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const context: NativeWidgetContext = {
    client: client as NativeWidgetContext['client'],
    generation: 1,
    sessionKey,
    sessionId: 'session-1',
    agentId: 'main',
    presentationOwner: {},
    isCurrent: () => current,
    canDraft: () => true,
  };
  const tool = {};
  if (realtime)
    markNativeBoardRealtime(tool, { client, generation: 1, sessionKey, sessionId: 'session-1' });
  const reference = decodeNativeBoardResult(
    JSON.stringify({ boardWidgetName: 'earth' }),
    'show_widget',
    'call',
    tool,
  )!;
  const publish = vi.fn();
  const destroy = vi.fn();
  const controller = new NativeBoardWidgetController(
    reference,
    context,
    'http://localhost:5173',
    () => current,
    publish,
    destroy,
  );
  const changed = (payload: { widget?: string } = { widget: 'earth' }) => {
    for (const listener of listeners)
      listener({ event: 'board.changed', payload: { sessionKey, ...payload } });
  };
  return {
    controller,
    context,
    client,
    request,
    widget,
    widgets,
    publish,
    destroy,
    changed,
    setRevision: (value: string) => {
      revision = value;
    },
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}
const controllers: NativeBoardWidgetController[] = [];
function mounted(...args: Parameters<typeof fixture>) {
  const result = fixture(...args);
  controllers.push(result.controller);
  return result;
}
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('native board loader and controller', () => {

  it.each(['none', 'pending', 'granted', 'rejected'] as const)(
    'refuses a networked card before approval or execution, with grant state %s',
    async grantState => {
      vi.stubGlobal('fetch', vi.fn());
      const value = mounted(grantState, true);
      value.widget.declared.netOrigins = ['https://assets.example.test'];
      delete (value.widget as Partial<typeof value.widget>).frameUrl;
      await flush();
      expect(value.controller.state.status).toBe('unsupported');
      await value.controller.start();
      expect(fetch).not.toHaveBeenCalled();
      expect(value.publish.mock.calls.some(call => call[1])).toBe(false);
      expect(value.request.mock.calls.some(call => call[0] === 'board.widget.grant')).toBe(false);
    },
  );
  it.each([
    { declared: { tools: ['browser'] } },
    { contentKind: 'plugin', contentOwner: 'registered', registeredContentKind: 'retired-page' },
    { grantState: 'pending' },
    { grantState: 'rejected' },
  ])('rejects unsupported content/capabilities before loading: %j', async changes => {
    vi.stubGlobal('fetch', vi.fn());
    const value = mounted('none', true);
    Object.assign(value.widget, changes);
    await flush();
    expect(value.controller.state.status).toBe('unsupported');
    await value.controller.start();
    expect(fetch).not.toHaveBeenCalled();
    expect(value.request.mock.calls.some(call => call[0] === 'board.widget.grant')).toBe(false);
  });
  it('history waits for explicit loading and does not expose the native ticket', async () => {
    const calls: string[] = [];
    const value = mounted();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        calls.push('html');
        expect(options).toMatchObject({
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
        });
        return new Response('<p>Native</p>', { headers: { 'content-type': 'text/html' } });
      }),
    );
    await flush();
    expect(value.controller.state.status).toBe('idle');
    expect(fetch).not.toHaveBeenCalled();
    await value.controller.start();
    expect(calls).toEqual(['html']);
    const delivered = value.publish.mock.calls.find(call => call[1]);
    expect(delivered?.[1]).toMatchObject({
      html: '<p>Native</p>',
    });
    expect(JSON.stringify(delivered?.[1])).not.toContain('ticket');
  });
  it('auto-runs a real live result once and does not repeat after anchor/owner remount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<p>Native</p>', { headers: { 'content-type': 'text/html' } }),
      ),
    );
    const value = mounted('granted', true);
    await flush();
    expect(value.controller.state.status).toBe('running');
    value.controller.dispose();
    const reference = value.controller.reference;
    const next = new NativeBoardWidgetController(
      reference,
      { ...value.context, presentationOwner: {} },
      'http://localhost:5173',
      () => true,
      vi.fn(),
      vi.fn(),
    );
    controllers.push(next);
    await flush();
    expect(next.state.status).toBe('idle');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts a newer same-name live call, while duplicate wrappers and historical references do not rerun it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<p>Native</p>', { headers: { 'content-type': 'text/html' } }),
      ),
    );
    const value = mounted('granted', true);
    await flush();
    const incoming = (call: string, live: boolean) => {
      const tool = {};
      if (live)
        markNativeBoardRealtime(tool, {
          client: value.client,
          generation: 1,
          sessionKey,
          sessionId: 'session-1',
        });
      return decodeNativeBoardResult(
        JSON.stringify({ boardWidgetName: 'earth' }),
        'show_widget',
        call,
        tool,
      )!;
    };
    expect(value.controller.receiveReference(incoming('outer-same-result', true))).toBe(true);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(value.controller.state.status).toBe('running');
    value.widget.revision++;
    value.widget.instanceId = 'new-native-instance';
    value.changed();
    await flush();
    expect(value.controller.state.status).toBe('idle');
    expect(value.controller.receiveReference(incoming('new-call', true))).toBe(true);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(value.controller.receiveReference(incoming('historical-call', false))).toBe(false);
    expect(value.controller.state.status).toBe('running');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['running', 'loading'] as const)(
    'keeps an unchanged %s document after an unrelated whole-board change',
    async status => {
      let finishHtml: (() => void) | undefined;
      const fetchHtml = vi.fn(async () =>
        new Response('<p>Native</p>', { headers: { 'content-type': 'text/html' } }),
      );
      if (status === 'loading') {
        fetchHtml.mockImplementationOnce(
          () => new Promise<Response>(resolve => {
            finishHtml = () => resolve(new Response('<p>Native</p>', {
              headers: { 'content-type': 'text/html' },
            }));
          }),
        );
      }
      vi.stubGlobal('fetch', fetchHtml);
      const value = mounted('none', true);
      await flush();
      expect(value.controller.state.status).toBe(status);
      const destroyed = value.destroy.mock.calls.length;
      value.widgets.push({
        ...value.widget, name: 'comparison', instanceId: 'other-native-instance',
      });
      value.changed({});
      await flush();
      expect(value.controller.state.status).toBe(status);
      finishHtml?.();
      await flush();
      expect(value.controller.state.status).toBe('running');
      expect(value.destroy).toHaveBeenCalledTimes(destroyed);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('stops the running guest within 15 seconds when a whole-board verification hangs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<p>Native</p>', {
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    const value = mounted('granted', true);
    await flush();
    expect(value.controller.state.status).toBe('running');
    const destroyed = value.destroy.mock.calls.length;
    value.request.mockImplementation(() => new Promise(() => undefined));
    value.changed({});
    await flush();
    await vi.advanceTimersByTimeAsync(15_001);
    await flush();
    expect(value.destroy).toHaveBeenCalledTimes(destroyed + 1);
    expect(value.controller.state.status).not.toBe('running');
  });

  it('stops the old document after a whole-board change reveals a session reset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<p>Native</p>', { headers: { 'content-type': 'text/html' } }),
      ),
    );
    const value = mounted();
    await flush();
    await value.controller.start();
    const destroyed = value.destroy.mock.calls.length;
    value.setRevision('new-lifecycle');
    value.changed({});
    await flush();
    expect(value.controller.state.status).toBe('failed');
    expect(value.destroy).toHaveBeenCalledTimes(destroyed + 1);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects a board snapshot without current native content ownership', async () => {
    const value = mounted();
    delete (value.widget as Partial<typeof value.widget>).contentOwner;
    await flush();
    expect(value.controller.state.status).toBe('unsupported');
    await expect(
      readCurrentBoard(value.context, 'earth', 'http://localhost:5173', () => true),
    ).rejects.toThrow('Unsupported native widget');
  });
  it('requires matching lifecycle before and after board reads, including same-sessionId reset', async () => {
    const value = mounted();
    await flush();
    let count = 0;
    const original = value.request.getMockImplementation()!;
    value.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.describe' && ++count === 2) value.setRevision('life-reset');
      return original(method, params);
    });
    await expect(
      readCurrentBoard(value.context, 'earth', 'http://localhost:5173', () => true, 'life-1'),
    ).rejects.toThrow('session changed');
    expect(() =>
      validateFrameUrl('https://other.test/document?bt=ticket', value.context, 'earth'),
    ).toThrow();
    expect(() =>
      validateFrameUrl(`${value.widget.frameUrl}&extra=value`, value.context, 'earth'),
    ).toThrow();
  });
  it('periodically revalidates the document and stops across a lifecycle change', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<p>Native</p>', { headers: { 'content-type': 'text/html' } }),
      ),
    );
    const value = mounted();
    await flush();
    await value.controller.start();
    value.setRevision('new-lifecycle');
    await vi.advanceTimersByTimeAsync(30_001);
    await flush();
    expect(value.controller.state.status).toBe('stopped');
  });
  it('anchors the first identity check to verification even when HTML loads slowly', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 29_000));
        return new Response('<p>Native</p>', { headers: { 'content-type': 'text/html' } });
      }),
    );
    const value = mounted();
    await flush();
    const start = value.controller.start();
    await flush();
    await vi.advanceTimersByTimeAsync(29_000);
    await start;
    expect(value.controller.state.status).toBe('running');
    const reads = value.request.mock.calls.filter(call => call[0] === 'board.get').length;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(value.request.mock.calls.filter(call => call[0] === 'board.get')).toHaveLength(reads + 1);
  });

  it('stops a running document if a native update adds networking', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<p>Native</p>', { headers: { 'content-type': 'text/html' } }),
    ));
    const value = mounted('none', true);
    await flush();
    const destroyed = value.destroy.mock.calls.length;
    value.widget.declared.netOrigins = ['https://assets.example.test'];
    value.changed({});
    await flush();
    expect(value.controller.state.status).toBe('unsupported');
    expect(value.destroy).toHaveBeenCalledTimes(destroyed + 1);
    expect(fetch).toHaveBeenCalledOnce();
    await value.controller.start();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('revalidates the same document before refreshing an expired HTML ticket once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<p>Native</p>', { headers: { 'content-type': 'text/html' } }),
    ));
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }));
    const value = mounted();
    await flush();
    await value.controller.start();
    expect(value.controller.state.status).toBe('running');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(value.request.mock.calls.filter(call => call[0] === 'board.get')).toHaveLength(3);
  });

  it('enforces HTML MIME/stream bounds and does not attach application credentials', async () => {
    const request = vi.fn(
      async () => new Response('code', { headers: { 'content-type': 'application/javascript' } }),
    );
    await expect(
      readBoardHtml('http://gateway/document', new AbortController().signal, request),
    ).rejects.toThrow();
    const huge = vi.fn(
      async () =>
        new Response('x', {
          headers: { 'content-type': 'text/html', 'content-length': '10485761' },
        }),
    );
    await expect(
      readBoardHtml('http://gateway/document', new AbortController().signal, huge),
    ).rejects.toThrow('too large');
  });
});
