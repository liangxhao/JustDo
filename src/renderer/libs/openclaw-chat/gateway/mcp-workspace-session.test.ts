// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GatewayClientOptions } from './client';
import { McpWorkspaceSession } from './mcp-workspace-session';

interface TestClient {
  generation: number;
  connected: boolean;
  options: GatewayClientOptions;
}
const fixture = vi.hoisted(() => ({
  clients: [] as TestClient[],
  request: vi.fn<(method: string, params?: unknown, options?: unknown) => Promise<unknown>>(),
}));
vi.mock('./client', () => ({
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fixture.clients.length = 0;
});

function setup() {
  let active = true;
  const native = {
    sessionKey: 'agent:main:workspace-preview:owned',
    gatewaySessionId: 'native',
    agentId: 'main',
  };
  const prepareWorkspace = vi.fn(async () => ({ success: true, value: native }));
  const releaseWorkspace = vi.fn().mockResolvedValue({ success: true, value: null });
  const getPort = vi.fn().mockResolvedValue({ success: true, port: 12345 });
  vi.stubGlobal('electron', {
    mcpApps: { prepareWorkspace, releaseWorkspace },
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
    addDraft: vi.fn().mockResolvedValue(true),
    openFile: vi.fn(),
  };
  const scope = { requestId: crypto.randomUUID(), agentId: 'main', cwd: '/workspace' };
  const session = new McpWorkspaceSession(scope, host);
  return {
    session,
    scope,
    native,
    prepareWorkspace,
    releaseWorkspace,
    getPort,
    host,
    expire: () => {
      active = false;
    },
  };
}

describe('homepage MCP workspace connection', () => {
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

  it('rejects a mismatched native incarnation before exposing App capabilities', async () => {
    const f = setup();
    fixture.request.mockResolvedValue({ session: { sessionId: 'replacement' } });
    await expect(f.session.prepare()).rejects.toThrow('changed');
    expect(f.session.apps.ready).toBe(false);
    f.session.dispose();
  });
});
