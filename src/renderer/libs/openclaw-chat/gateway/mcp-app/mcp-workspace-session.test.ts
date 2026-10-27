// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GatewayClientOptions } from '../client';
import { McpWorkspaceSession } from './mcp-workspace-session';

interface TestClient {
  generation: number;
  connected: boolean;
  options: GatewayClientOptions;
  start: () => void;
  stop: () => void;
}
const fixture = vi.hoisted(() => ({
  clients: [] as TestClient[],
  autoHello: true,
  request: vi.fn<(method: string, params?: unknown, options?: unknown) => Promise<unknown>>(),
}));
vi.mock('../client', () => ({
  GatewayClient: class {
    generation = 1;
    connected = false;
    constructor(readonly options: GatewayClientOptions) {
      fixture.clients.push(this);
    }
    get gatewayUrl() {
      return this.options.url;
    }
    start() {
      this.connected = true;
      if (fixture.autoHello)
        queueMicrotask(() => this.options.onHello?.({ type: 'hello-ok', protocol: 4 }));
    }
    stop() {
      this.connected = false;
    }
    request = fixture.request;
    subscribeEvents() {
      return () => {};
    }
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fixture.clients.length = 0;
  fixture.autoHello = true;
});

function setup() {
  let active = true;
  let interactive = true;
  const native = {
    sessionKey: 'agent:main:workspace-preview:owned',
    gatewaySessionId: 'native',
    agentId: 'main',
  };
  const prepareWorkspace = vi.fn(async () => ({ success: true, value: native }));
  const prepare = vi.fn(async () => ({ success: true, value: native }));
  const releaseWorkspace = vi.fn().mockResolvedValue({ success: true, value: null });
  const getPort = vi.fn().mockResolvedValue({ success: true, port: 12345 });
  vi.stubGlobal('electron', {
    mcpApps: { prepare, prepareWorkspace, releaseWorkspace },
    openclaw: {
      engine: { getPort, getToken: async () => ({ success: true, token: 'fixture-token' }) },
    },
  });
  fixture.request.mockImplementation(async (method: string) =>
    method === 'sessions.describe'
      ? { session: { sessionId: native.gatewaySessionId } }
      : { servers: [] },
  );
  const host = {
    isCurrent: () => active,
    canInteract: () => interactive,
    addDraft: vi.fn().mockResolvedValue(true),
    openFile: vi.fn(),
  };
  const scope = { requestId: crypto.randomUUID(), agentId: 'main', cwd: '/workspace' };
  const session = new McpWorkspaceSession(scope, host);
  return {
    session,
    scope,
    native,
    prepare,
    prepareWorkspace,
    releaseWorkspace,
    getPort,
    host,
    setInteractive: (value: boolean) => {
      interactive = value;
    },
    expire: () => {
      active = false;
    },
  };
}

describe('homepage MCP workspace connection', () => {
  it('prewarms a read-only catalog in the background without granting interactive capabilities', async () => {
    const f = setup();
    f.setInteractive(false);

    const catalog = await f.session.discover();

    expect(catalog.value).toEqual({ servers: [] });
    expect(catalog.isCurrent()).toBe(true);
    expect('apps' in catalog).toBe(false);
    await expect(f.session.prepare()).rejects.toThrow('not interactive');
    expect(f.prepareWorkspace).toHaveBeenCalledOnce();
    expect(fixture.request.mock.calls.map(([method]) => method)).toEqual([
      'sessions.describe',
      'mcp.app.discover',
    ]);
    expect(f.host.addDraft).not.toHaveBeenCalled();
    expect(f.host.openFile).not.toHaveBeenCalled();
    f.session.dispose();
  });

  it('shares native preparation between discovery and an admitted prepare while keeping their authority separate', async () => {
    const f = setup();
    const [catalog, context] = await Promise.all([f.session.discover(), f.session.prepare()]);
    expect(f.prepareWorkspace).toHaveBeenCalledOnce();
    expect(
      fixture.request.mock.calls.filter(([method]) => method === 'sessions.describe'),
    ).toHaveLength(1);

    f.setInteractive(false);

    expect(context.isCurrent()).toBe(false);
    expect(context.canDraft()).toBe(false);
    expect(context.resume?.()).toBeUndefined();
    await expect(context.addDraft('background')).resolves.toBe(false);
    await expect(context.openFile?.({ path: '/workspace/file', name: 'file' })).resolves.toBe(
      false,
    );
    f.session.apps.invalidate(true);
    expect(catalog.isCurrent()).toBe(true);
    expect(f.host.addDraft).not.toHaveBeenCalled();
    expect(f.host.openFile).not.toHaveBeenCalled();
    f.session.dispose();
  });

  it('rereads only the directory when a presentation pause interrupts discovery on the same native owner', async () => {
    const f = setup();
    let finish!: (value: unknown) => void;
    let reads = 0;
    fixture.request.mockImplementation(async method => {
      if (method === 'sessions.describe')
        return { session: { sessionId: f.native.gatewaySessionId } };
      if (method === 'mcp.app.discover' && reads++ === 0)
        return new Promise(resolve => {
          finish = resolve;
        });
      return { servers: [] };
    });
    const pending = f.session.discover();
    await vi.waitFor(() => expect(reads).toBe(1));

    f.session.apps.invalidate(true);
    finish({ servers: [] });

    const catalog = await pending;
    expect(catalog.isCurrent()).toBe(true);
    expect(reads).toBe(2);
    expect(f.prepareWorkspace).toHaveBeenCalledOnce();
    expect(fixture.clients).toHaveLength(1);
    f.session.dispose();
  });

  it('bounds directory rereads after repeated presentation pauses', async () => {
    const f = setup();
    const finishes: Array<(value: unknown) => void> = [];
    fixture.request.mockImplementation(async method => {
      if (method === 'sessions.describe')
        return { session: { sessionId: f.native.gatewaySessionId } };
      return new Promise(resolve => finishes.push(resolve));
    });
    const pending = f.session.discover();
    const rejected = expect(pending).rejects.toThrow('superseded');
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    f.session.apps.invalidate(true);
    finishes[0]({ servers: [] });
    await vi.waitFor(() => expect(finishes).toHaveLength(2));

    f.session.apps.invalidate(true);
    finishes[1]({ servers: [] });

    await rejected;
    expect(finishes).toHaveLength(2);
    expect(f.prepareWorkspace).toHaveBeenCalledOnce();
    f.session.dispose();
  });

  it('stays lazy and shares preparation while preserving existing view bindings', async () => {
    const f = setup();
    expect(f.prepareWorkspace).not.toHaveBeenCalled();
    expect(fixture.clients).toHaveLength(0);
    const [first, second] = await Promise.all([f.session.prepare(), f.session.prepare()]);
    expect(first).toBe(second);
    const view = f.session.apps.bind('view');
    await f.session.prepare();
    expect(first.isCurrent()).toBe(true);
    expect(view.isCurrent()).toBe(true);
    expect(fixture.clients).toHaveLength(1);
    await f.session.apps.discover();
    expect(fixture.request).toHaveBeenLastCalledWith(
      'mcp.app.discover',
      expect.objectContaining({
        sessionKey: f.native.sessionKey,
        agentId: 'main',
      }),
      expect.anything(),
    );
    expect(fixture.request.mock.calls.some(([method]) => /^chat\./.test(method))).toBe(false);
    f.session.dispose();
  });

  it('rejects a late preparation after leaving home without connecting or publishing it', async () => {
    const f = setup();
    let finish!: (value: Awaited<ReturnType<typeof f.prepareWorkspace>>) => void;
    f.prepareWorkspace.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const pending = f.session.prepare();
    await vi.waitFor(() => expect(f.prepareWorkspace).toHaveBeenCalledOnce());
    f.expire();
    f.session.dispose();
    finish({ success: true, value: f.native });
    await expect(pending).rejects.toThrow('unavailable');
    expect(fixture.clients[0].connected).toBe(false);
    expect(f.releaseWorkspace).toHaveBeenCalledExactlyOnceWith(f.scope.requestId);
  });

  it('does not create native state when Gateway connectivity is unavailable', async () => {
    const f = setup();
    f.getPort.mockResolvedValueOnce({ success: false });
    await expect(f.session.prepare()).rejects.toThrow('unavailable');
    expect(f.prepareWorkspace).not.toHaveBeenCalled();
    f.session.dispose();
  });

  it('invalidates old views on disconnect and requires explicit preparation after reconnect', async () => {
    const f = setup();
    const first = await f.session.prepare();
    const client = fixture.clients[0];
    client.connected = false;
    client.options.onClose?.({ code: 1006, reason: 'test disconnect' });
    expect(first.isCurrent()).toBe(false);
    const calls = f.prepareWorkspace.mock.calls.length;
    client.generation++;
    client.connected = true;
    client.options.onHello?.({ type: 'hello-ok', protocol: 4 });
    expect(f.prepareWorkspace).toHaveBeenCalledTimes(calls);
    const next = await f.session.prepare();
    expect(next.isCurrent()).toBe(true);
    expect(first.isCurrent()).toBe(false);
    f.session.dispose();
  });

  it('records adoption while disconnected and prepares only the canonical conversation after reconnect', async () => {
    const f = setup();
    const first = await f.session.prepare();
    const client = fixture.clients[0];
    client.connected = false;
    client.options.onClose?.({ code: 1006, reason: 'disconnect during promotion' });

    expect(() => f.session.adopt('canonical-chat')).not.toThrow();
    expect(first.isCurrent()).toBe(false);
    expect(f.prepare).not.toHaveBeenCalled();
    client.generation++;
    client.connected = true;
    client.options.onHello?.({ type: 'hello-ok', protocol: 4 });

    const resumed = await f.session.prepare();
    expect(resumed.isCurrent()).toBe(true);
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith('canonical-chat');
    expect(f.prepareWorkspace).toHaveBeenCalledOnce();
    f.session.dispose();
    expect(() => f.session.adopt('another-chat')).toThrow('unavailable');
  });

  it('publishes authenticated connection state and waits for the new hello on the same reconnecting client', async () => {
    const f = setup();
    fixture.autoHello = false;
    const states: boolean[] = [];
    const stop = f.session.subscribeConnection(() => states.push(f.session.connected));
    const first = f.session.prepare();
    await vi.waitFor(() => expect(fixture.clients).toHaveLength(1));
    const client = fixture.clients[0];
    expect(client.connected).toBe(true);
    expect(f.session.connected).toBe(false);
    expect(f.prepareWorkspace).not.toHaveBeenCalled();
    client.options.onHello?.({ type: 'hello-ok', protocol: 4 });
    const initial = await first;
    expect(states).toEqual([true]);
    expect(f.prepareWorkspace).toHaveBeenCalledOnce();

    client.connected = false;
    client.options.onClose?.({ code: 1006, reason: 'test disconnect' });
    client.generation++;
    client.connected = true;
    expect(f.session.connected).toBe(false);
    const pending = f.session.prepare();
    const same = f.session.prepare();
    expect(same).toBe(pending);
    await Promise.resolve();
    expect(f.prepareWorkspace).toHaveBeenCalledOnce();
    expect(fixture.request).toHaveBeenCalledOnce();
    expect(fixture.clients).toHaveLength(1);

    client.options.onHello?.({ type: 'hello-ok', protocol: 4 });
    const resumed = await pending;
    expect(resumed.isCurrent()).toBe(true);
    expect(initial.isCurrent()).toBe(false);
    expect(states).toEqual([true, false, true]);
    expect(f.prepareWorkspace).toHaveBeenCalledTimes(2);
    expect(fixture.request.mock.calls.every(([method]) => method === 'sessions.describe')).toBe(
      true,
    );
    stop();
    f.session.dispose();
    expect(states).toEqual([true, false, true]);
  });

  it('keeps the first connection wait across a failed socket attempt without preparing native state', async () => {
    const f = setup();
    fixture.autoHello = false;
    const pending = f.session.prepare();
    await vi.waitFor(() => expect(fixture.clients).toHaveLength(1));
    const client = fixture.clients[0];
    const stop = vi.spyOn(client, 'stop');
    client.connected = false;
    client.options.onClose?.({ code: 1006, reason: 'first attempt disconnected' });
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    expect(f.prepareWorkspace).not.toHaveBeenCalled();
    client.generation++;
    client.connected = true;
    client.options.onHello?.({ type: 'hello-ok', protocol: 4 });
    await expect(pending).resolves.toHaveProperty('sessionKey', f.native.sessionKey);
    expect(f.prepareWorkspace).toHaveBeenCalledOnce();
    expect(fixture.clients).toHaveLength(1);
    f.session.dispose();
  });

  it('bounds a reconnect wait and ignores late callbacks from the retired client', async () => {
    const f = setup();
    await f.session.prepare();
    vi.useFakeTimers();
    const client = fixture.clients[0];
    const stop = vi.spyOn(client, 'stop');
    client.connected = false;
    client.options.onClose?.({ code: 1006, reason: 'test disconnect' });
    const calls = f.prepareWorkspace.mock.calls.length;
    const pending = f.session.prepare();
    const rejected = expect(pending).rejects.toThrow('timed out');
    client.options.onClose?.({ code: 1013, reason: 'gateway starting' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    expect(f.prepareWorkspace).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
    client.connected = true;
    client.generation++;
    client.options.onHello?.({ type: 'hello-ok', protocol: 4 });
    expect(f.session.connected).toBe(false);
    await f.session.prepare();
    expect(fixture.clients).toHaveLength(2);
    expect(f.prepareWorkspace).toHaveBeenCalledTimes(calls + 1);
    f.session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the normal deadline for a replacement client after this workspace has authenticated', async () => {
    const f = setup();
    await f.session.prepare();
    vi.useFakeTimers();
    const client = fixture.clients[0];
    client.connected = false;
    client.options.onClose?.({ code: 1006, reason: 'connection lost' });
    const reconnect = f.session.prepare();
    const reconnectRejected = expect(reconnect).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await reconnectRejected;
    fixture.autoHello = false;

    const replacement = f.session.prepare();
    const replacementRejected = expect(replacement).rejects.toThrow('timed out');
    await vi.dynamicImportSettled();
    expect(fixture.clients).toHaveLength(2);
    fixture.clients[1].connected = false;
    fixture.clients[1].options.onClose?.({ code: 1013, reason: 'gateway starting' });
    await vi.advanceTimersByTimeAsync(15_000);

    await replacementRejected;
    expect(f.prepareWorkspace).toHaveBeenCalledOnce();
    expect(fixture.request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    f.session.dispose();
  });

  it('disposal settles a blocked connection wait and clears its deadline before credentials arrive', async () => {
    vi.useFakeTimers();
    const f = setup();
    let finish!: (value: { success: boolean; port: number }) => void;
    f.getPort.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const pending = f.session.prepare();
    const rejected = expect(pending).rejects.toThrow('changed');
    expect(vi.getTimerCount()).toBe(1);
    f.session.dispose();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    finish({ success: true, port: 12345 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.clients).toHaveLength(0);
    expect(f.prepareWorkspace).not.toHaveBeenCalled();
    expect(f.releaseWorkspace).toHaveBeenCalledExactlyOnceWith(f.scope.requestId);
  });

  it('disposal ends a pending hello wait and ignores later client callbacks', async () => {
    vi.useFakeTimers();
    const f = setup();
    fixture.autoHello = false;
    const listener = vi.fn();
    f.session.subscribeConnection(listener);
    const pending = f.session.prepare();
    const rejected = expect(pending).rejects.toThrow('changed');
    await vi.waitFor(() => expect(fixture.clients).toHaveLength(1));
    const client = fixture.clients[0];
    const stop = vi.spyOn(client, 'stop');

    f.session.dispose();

    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
    client.connected = true;
    client.options.onHello?.({ type: 'hello-ok', protocol: 4 });
    client.options.onClose?.({ code: 1006, reason: 'late close' });
    expect(listener).toHaveBeenCalledOnce();
    expect(f.session.connected).toBe(false);
    expect(f.prepareWorkspace).not.toHaveBeenCalled();
  });

  it('requires the authenticated generation to remain current during native preparation', async () => {
    const f = setup();
    let finish!: (value: Awaited<ReturnType<typeof f.prepareWorkspace>>) => void;
    f.prepareWorkspace.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const pending = f.session.prepare();
    const rejected = expect(pending).rejects.toThrow('unavailable');
    await vi.waitFor(() => expect(f.prepareWorkspace).toHaveBeenCalledOnce());
    fixture.clients[0].generation++;
    finish({ success: true, value: f.native });
    await rejected;
    expect(f.session.connected).toBe(false);
    expect(fixture.request).not.toHaveBeenCalled();
    f.session.dispose();
  });

  it('rejects a mismatched native incarnation before exposing App capabilities', async () => {
    const f = setup();
    fixture.request.mockResolvedValue({ session: { sessionId: 'replacement' } });
    await expect(f.session.prepare()).rejects.toThrow('changed');
    expect(f.session.apps.ready).toBe(false);
    f.session.dispose();
  });
});
