// @vitest-environment jsdom
import type { WidgetNetworkBridge } from '@shared/widgets/network';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNativeBoardResult, markNativeBoardRealtime } from '../../pipeline/native-board';
import type { NativeWidgetContext } from '../native-widget/host';
import { NativeBoardWidgetController } from './controller';
import { readBoardHtml, readCurrentBoard, refreshHtmlResources, validateFrameUrl } from './loader';

const sessionKey = 'agent:main:board-test';
const generation = 'a'.repeat(32);
const csp = btoa('{}').replace(/=+$/, '');
const sandboxUrl = `/mcp-app-sandbox?csp=${csp}&v=${'a'.repeat(64)}`;
const flush = async () => {
  for (let index = 0; index < 35; index++) await Promise.resolve();
};
function fixture(
  grantState: 'pending' | 'granted' | 'rejected' | 'none' = 'granted',
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
    declared: { netOrigins: grantState === 'none' ? [] : ['https://assets.example.test'] },
    viewGeneration: generation,
    frameUrl: `/__openclaw__/board/${encodeURIComponent(sessionKey)}/earth/index.html?bt=ticket`,
    sandboxPort: 18790,
    sandboxUrl,
  };
  const widgets = [widget];
  const request = vi.fn(async (method: string, params?: unknown) => {
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
    if (method === 'board.widget.grant') {
      const name = (params as { name: string }).name;
      widgets.find(widget => widget.name === name)!.grantState = 'granted';
      for (const listener of listeners)
        listener({ event: 'board.changed', payload: { sessionKey } });
      return { ok: true };
    }
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
  const bridge: WidgetNetworkBridge = {
    beginCheck: vi.fn(async () => ({ nonce: 'check', validForMs: 15_000 })),
    create: vi.fn(async args => ({
      mountId: args.mountId,
      instanceId: 'main-instance',
      partition: 'widget-network-test',
    })),
    renew: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    onRevoked: vi.fn(() => () => undefined),
  };
  const publish = vi.fn();
  const destroy = vi.fn();
  const controller = new NativeBoardWidgetController(
    reference,
    context,
    'http://localhost:5173',
    () => current,
    publish,
    destroy,
    bridge,
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
    bridge,
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
  it('reads pending metadata without viewGeneration/frame URL and never creates a guest', async () => {
    const value = mounted('pending');
    delete (value.widget as Partial<typeof value.widget>).viewGeneration;
    delete (value.widget as Partial<typeof value.widget>).frameUrl;
    await flush();
    expect(value.controller.state.status).toBe('pending');
    expect(value.bridge.create).not.toHaveBeenCalled();
    await value.controller.start();
    expect(value.bridge.create).not.toHaveBeenCalled();
  });
  it('history only reads current state; an explicit load installs Main lease before fetching HTML', async () => {
    const calls: string[] = [];
    const value = mounted();
    vi.mocked(value.bridge.create).mockImplementation(async args => {
      calls.push('lease');
      return {
        mountId: args.mountId,
        instanceId: 'main-instance',
        partition: 'widget-network-test',
      };
    });
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
    expect(calls).toEqual(['lease', 'html']);
    const delivered = value.publish.mock.calls.find(call => call[1]);
    expect(delivered?.[1]).toMatchObject({
      html: '<p>Native</p>',
      network: { instanceId: 'main-instance' },
    });
    expect(JSON.stringify(delivered?.[1])).not.toContain('ticket');
  });
  it('refreshes the registered HTML adapter surface before requesting an executable board frame', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<p>Native</p>', { headers: { 'content-type': 'text/html' } }),
      ),
    );
    const value = mounted();
    const frameUrl = value.widget.frameUrl;
    Object.assign(value.widget, {
      contentKind: 'plugin',
      contentOwner: 'registered',
      registeredContentKind: 'html-page',
      pluginKind: 'smart-canvas:html-page',
    });
    delete (value.widget as Partial<typeof value.widget>).frameUrl;
    delete (value.widget as Partial<typeof value.widget>).viewGeneration;
    const observedUrl = `http://127.0.0.1:18789/__openclaw__/cap/${'a'.repeat(24)}`;
    const scopedUrl = `http://127.0.0.1:18789/__openclaw__/cap/${'b'.repeat(24)}`;
    value.context.methods = ['plugin.surface.refresh'];
    value.context.pluginSurfaceUrls = { 'smart-canvas-html': observedUrl };
    const original = value.request.getMockImplementation()!;
    value.request.mockImplementation(async (method, params) => {
      if (method !== 'plugin.surface.refresh') return original(method, params);
      value.widget.frameUrl = frameUrl;
      value.widget.viewGeneration = generation;
      return {
        surface: 'smart-canvas-html',
        pluginSurfaceUrls: { 'smart-canvas-html': scopedUrl },
      } as never;
    });
    await flush();
    expect(value.controller.state.status).toBe('idle');
    await value.controller.start();
    expect(value.controller.state.status).toBe('running');
    expect(value.request).toHaveBeenCalledWith('plugin.surface.refresh', {
      surface: 'smart-canvas-html',
      observedUrl,
    });
    expect(vi.mocked(value.bridge.create).mock.calls[0][0].resourceUrls).toHaveLength(1);
  });
  it('coalesces concurrent surface refresh and keeps using the connection observation for later starts', async () => {
    const value = mounted();
    await flush();
    const observedUrl = `http://127.0.0.1:18789/__openclaw__/cap/${'a'.repeat(24)}`;
    const scopedUrl = `http://127.0.0.1:18789/__openclaw__/cap/${'b'.repeat(24)}`;
    const request = vi.fn(async (_method: string, params?: unknown) => {
      expect(params).toEqual({ surface: 'smart-canvas-html', observedUrl });
      return { surface: 'smart-canvas-html', pluginSurfaceUrls: { 'smart-canvas-html': scopedUrl } };
    });
    const context = {
      ...value.context,
      client: { ...value.client, request } as NativeWidgetContext['client'],
      methods: ['plugin.surface.refresh'],
      pluginSurfaceUrls: { 'smart-canvas-html': observedUrl },
    };
    const urls = await Promise.all([refreshHtmlResources(context), refreshHtmlResources(context)]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(urls[0]).toEqual(urls[1]);
    expect(await refreshHtmlResources(context)).toEqual(urls[0]);
    expect(request).toHaveBeenCalledTimes(2);
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
      value.bridge,
    );
    controllers.push(next);
    await flush();
    expect(next.state.status).toBe('idle');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('honors explicit approval when board.changed is delivered before grant response, with one fresh execution', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<p>Native</p>', { headers: { 'content-type': 'text/html' } }),
      ),
    );
    const value = mounted('pending');
    await flush();
    await value.controller.grant('granted');
    await flush();
    expect(value.request).toHaveBeenCalledWith(
      'board.widget.grant',
      expect.objectContaining({ name: 'earth', revision: 1, instanceId: 'instance-native' }),
    );
    expect(value.controller.state.status).toBe('running');
    expect(fetch).toHaveBeenCalledTimes(1);
    value.changed();
    await flush();
    expect(value.controller.state.status).toBe('idle');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(value.bridge.close).toHaveBeenCalled();
  });
  it('does not auto-execute a same-name replacement returned after an approval', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const value = mounted('pending');
    await flush();
    const original = value.request.getMockImplementation()!;
    value.request.mockImplementation(async (method, params) => {
      const response = await original(method, params);
      if (method === 'board.widget.grant') value.widget.instanceId = 'replacement';
      return response;
    });
    await value.controller.grant('granted');
    await flush();
    expect(value.controller.state.status).toBe('idle');
    expect(fetch).not.toHaveBeenCalled();
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
    'keeps a %s document when another widget receives a native grant',
    async status => {
      let finishHtml: (() => void) | undefined;
      const fetchHtml = vi.fn(
        async () =>
          new Response('<p>Native</p>', {
            headers: { 'content-type': 'text/html' },
          }),
      );
      if (status === 'loading') {
        fetchHtml.mockImplementationOnce(
          () =>
            new Promise<Response>(resolve => {
              finishHtml = () =>
                resolve(
                  new Response('<p>Native</p>', {
                    headers: { 'content-type': 'text/html' },
                  }),
                );
            }),
        );
      }
      vi.stubGlobal('fetch', fetchHtml);
      const value = mounted('granted', true);
      await flush();
      expect(value.controller.state.status).toBe(status);
      const destroyed = value.destroy.mock.calls.length;
      value.widgets.push({
        ...value.widget,
        name: 'comparison',
        instanceId: 'other-native-instance',
        grantState: 'pending',
        frameUrl: `/__openclaw__/board/${encodeURIComponent(sessionKey)}/comparison/index.html?bt=other`,
      });
      const other = new NativeBoardWidgetController(
        decodeNativeBoardResult(
          JSON.stringify({ boardWidgetName: 'comparison' }),
          'show_widget',
          'other-call',
        )!,
        value.context,
        'http://localhost:5173',
        () => true,
        vi.fn(),
        vi.fn(),
        value.bridge,
      );
      controllers.push(other);
      await flush();
      expect(other.state.status).toBe('pending');
      await other.grant('granted');
      await flush();
      expect(other.state.status).toBe('running');
      expect(value.controller.state.status).toBe(status);
      finishHtml?.();
      await flush();
      expect(value.controller.state.status).toBe('running');
      expect(value.destroy).toHaveBeenCalledTimes(destroyed);
      expect(value.bridge.close).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(2);
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
    expect(value.bridge.close).toHaveBeenCalledOnce();
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
    expect(value.bridge.close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects a board snapshot without current native content ownership', async () => {
    const value = mounted();
    delete (value.widget as Partial<typeof value.widget>).contentOwner;
    await flush();
    expect(value.controller.state.status).toBe('failed');
    expect(value.bridge.create).not.toHaveBeenCalled();
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
  it('bounds pending reads and grants to 15 seconds without trusting a delayed acknowledgement', async () => {
    vi.useFakeTimers();
    const value = mounted('pending');
    await flush();
    value.request.mockImplementation(() => new Promise(() => undefined));
    const grant = value.controller.grant('granted');
    await vi.advanceTimersByTimeAsync(15_001);
    await grant;
    expect(value.controller.state.status).toBe('failed');
    expect(value.bridge.create).not.toHaveBeenCalled();
  });
  it('does not approve a pending card after its physical session incarnation reset', async () => {
    const value = mounted('pending');
    await flush();
    value.setRevision('reset-before-approval');
    await value.controller.grant('granted');
    expect(value.controller.state.status).toBe('failed');
    expect(value.request.mock.calls.some(call => call[0] === 'board.widget.grant')).toBe(false);
    expect(value.bridge.create).not.toHaveBeenCalled();
  });
  it('destroys on board invalidation and refuses lease renewal across a lifecycle change', async () => {
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
    expect(value.bridge.renew).not.toHaveBeenCalled();
    expect(value.bridge.close).toHaveBeenCalled();
  });
  it('anchors the first renewal to verification even when HTML loads near the timeout', async () => {
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
    expect(value.bridge.beginCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(value.bridge.beginCheck).toHaveBeenCalledTimes(2);
    expect(value.bridge.renew).toHaveBeenCalledTimes(1);
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
