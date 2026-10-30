import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ dispatch: vi.fn(), entry: vi.fn() }));
vi.mock('openclaw/plugin-sdk/gateway-method-runtime', () => ({
  dispatchGatewayMethod: sdk.dispatch,
}));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({ getSessionEntry: sdk.entry }));

import { DRAWIO_CANVAS_METHOD, DRAWIO_EDIT_TOOL, DRAWIO_SEND_METHOD } from '../contracts';
import { getDiagramEditingState, registerDiagramEditing } from '../editing';

const scope = { sessionKey: 'agent:main:canvas', sessionId: 'physical', agentId: 'main' };
const xml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const snapshot = { diagramId: 'diagram-one', xml, title: 'Current', contentStamp: 'base' };
const admitted = {
  serverName: 'drawio',
  toolName: 'open_editor',
  uiResourceUri: 'ui://drawio/editor',
  originSessionKey: scope.sessionKey,
};
type Handler = (request: Record<string, unknown>) => Promise<void>;
let handlers: Map<string, Handler>;
let factory: { create: (context: Record<string, unknown>) => any };
let service: { start: (ctx: unknown) => void; stop: () => void };
let live: boolean;
let emitted: ReturnType<typeof vi.fn>;
let connections: Map<string, AbortController>;
async function request(
  method: string,
  params: Record<string, unknown>,
  connectionId = 'connection',
) {
  const respond = vi.fn();
  if (!connections.has(connectionId)) connections.set(connectionId, new AbortController());
  await handlers.get(method)!({
    params,
    respond,
    client: { connId: connectionId, connectionSignal: connections.get(connectionId)!.signal },
    hasCurrentClientAuthority: () => live,
  });
  const call = respond.mock.calls[0];
  if (call[0] !== true) throw new Error(call[2]?.message ?? 'RPC failed');
  return call[1];
}
const admit = (override: Record<string, unknown> = {}) =>
  request(DRAWIO_CANVAS_METHOD, {
    ...scope,
    viewId: 'mcp-app-original',
    action: 'admit',
    source: admitted,
    diagramId: snapshot.diagramId,
    ...override,
  });
const prepareOnly = (override: Record<string, unknown> = {}, connectionId?: string) =>
  request(
    DRAWIO_CANVAS_METHOD,
    {
      ...scope,
      viewId: 'mcp-app-original',
      action: 'prepare',
      source: admitted,
      snapshot,
      ...override,
    },
    connectionId,
  );
const prepare = async (override: Record<string, unknown> = {}) => {
  await admit({ ...override, action: 'admit' });
  return prepareOnly(override);
};
beforeEach(() => {
  live = true;
  handlers = new Map();
  emitted = vi.fn();
  connections = new Map();
  sdk.entry.mockReturnValue({ sessionId: scope.sessionId, lifecycleRevision: 'generation' });
  sdk.dispatch.mockImplementation(async (method, params) => {
    if (method === 'chat.history') return { ok: true, payload: { ...scope } };
    if (method === 'mcp.app.view')
      return { ok: true, payload: { toolResult: { structuredContent: snapshot } } };
    if (method === 'mcp.app.readResource')
      return {
        ok: true,
        payload: {
          contents: [
            {
              uri: params.uri,
              text: JSON.stringify({ diagramId: snapshot.diagramId, toolName: 'open_editor' }),
            },
          ],
        },
      };
    if (method === 'chat.send') return { ok: true, payload: { runId: params.idempotencyKey } };
    throw new Error('Unexpected SDK method');
  });
  registerDiagramEditing({
    source: '/plugin/index.cjs',
    runtime: { config: { current: () => ({ mcp: { apps: { enabled: true } } }) } },
    registerService: (value: typeof service) => {
      service = value;
    },
    registerGatewayMethod: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (value: typeof factory) => {
      factory = value;
    },
  } as never);
  service.start({ gatewayEvents: { emit: emitted } });
});
afterEach(() => {
  service.stop();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('authenticated draw.io editing adapter', () => {
  const refreshing = {
    ok: false,
    error: {
      code: 'UNAVAILABLE',
      message: 'Session access is refreshing; retry the operation shortly.',
    },
  };
  it.each(['mcp.app.view', 'mcp.app.readResource'])(
    'waits only for explicit native access refresh during read-only %s preparation',
    async method => {
      vi.useFakeTimers();
      const normal = sdk.dispatch.getMockImplementation()!;
      let attempts = 0;
      sdk.dispatch.mockImplementation((name, params) =>
        name === method && ++attempts <= 2 ? Promise.resolve(refreshing) : normal(name, params),
      );
      const preparation = prepare();
      await vi.runAllTimersAsync();
      await expect(preparation).resolves.toHaveProperty('token');
      expect(attempts).toBe(3);
      expect(sdk.dispatch.mock.calls.some(([name]) => name === 'chat.send')).toBe(false);
      vi.useRealTimers();
    },
  );
  it('bounds native refresh reads and rejects permanent errors immediately', async () => {
    vi.useFakeTimers();
    const normal = sdk.dispatch.getMockImplementation()!;
    sdk.dispatch.mockImplementation((name, params) =>
      name === 'mcp.app.readResource' ? Promise.resolve(refreshing) : normal(name, params),
    );
    const pending = expect(prepare()).rejects.toThrow();
    await vi.runAllTimersAsync();
    await pending;
    expect(
      sdk.dispatch.mock.calls.filter(([name]) => name === 'mcp.app.readResource'),
    ).toHaveLength(5);
    for (const error of [
      { code: 'UNAVAILABLE', message: 'Runtime disposed' },
      { code: 'FORBIDDEN', message: refreshing.error.message },
    ]) {
      sdk.dispatch.mockClear();
      sdk.dispatch.mockImplementation((name, params) =>
        name === 'mcp.app.readResource'
          ? Promise.resolve({ ok: false, error })
          : normal(name, params),
      );
      await expect(prepare()).rejects.toThrow();
      expect(
        sdk.dispatch.mock.calls.filter(([name]) => name === 'mcp.app.readResource'),
      ).toHaveLength(1);
    }
    vi.useRealTimers();
  });
  it.each(['cleanup', 'disconnect'])(
    'does not re-read or bind after %s during a waiting preparation',
    async mode => {
      vi.useFakeTimers();
      const normal = sdk.dispatch.getMockImplementation()!;
      sdk.dispatch.mockImplementation((name, params) =>
        name === 'mcp.app.readResource' ? Promise.resolve(refreshing) : normal(name, params),
      );
      const pending = expect(prepare()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      if (mode === 'disconnect') live = false;
      else
        await request(DRAWIO_CANVAS_METHOD, {
          ...scope,
          viewId: 'mcp-app-original',
          action: 'detach',
          token: '',
        });
      await vi.runAllTimersAsync();
      await pending;
      expect(
        sdk.dispatch.mock.calls.filter(([name]) => name === 'mcp.app.readResource'),
      ).toHaveLength(1);
      vi.useRealTimers();
    },
  );

  it('checks native view, same-runtime mint, incarnation and fixed desktop admission', async () => {
    expect((await prepare()).token).toBeTypeOf('string');
    expect(sdk.dispatch).toHaveBeenCalledWith(
      'mcp.app.readResource',
      expect.objectContaining({ viewId: 'mcp-app-original', uri: 'diagram://origin/diagram-one' }),
    );
    await expect(prepare({ source: { ...admitted, serverName: 'other' } })).rejects.toThrow();
    await expect(
      prepareOnly({ source: { ...admitted, toolName: 'create_diagram' } }),
    ).rejects.toThrow();
    await expect(prepare({ sessionId: 'rotated' })).rejects.toThrow();
    await request(DRAWIO_CANVAS_METHOD, {
      ...scope,
      viewId: 'mcp-app-original',
      action: 'detach',
      token: '',
      forgetSource: true,
    });
    sdk.dispatch.mockImplementation(async method =>
      method === 'chat.history'
        ? { ok: true, payload: { ...scope } }
        : {
            ok: true,
            payload: { toolResult: { structuredContent: { diagramId: 'diagram-foreign' } } },
          },
    );
    await expect(prepare()).rejects.toThrow();
  });

  it('requires separate provenance admission before preparing a writable canvas', async () => {
    await expect(prepareOnly()).rejects.toThrow();
    expect(await admit()).toEqual({ admitted: true });
    expect(getDiagramEditingState().canvases).toBeDefined();
    expect((await prepareOnly()).token).toBeTypeOf('string');
  });

  it('admits an authenticated recovery without reinstating its original MCP tools', async () => {
    getDiagramEditingState().recovered.set('mcp-app-original', {
      diagramId: snapshot.diagramId,
      source: {
        ...scope,
        kind: 'native-history-recovery',
        diagramId: snapshot.diagramId,
        serverName: 'drawio',
        toolName: 'create_diagram',
        uiResourceUri: 'ui://drawio/editor',
        originViewId: 'mcp-app-historical',
      },
    });
    const source = { ...admitted, toolName: 'create_diagram' };
    await expect(prepare({ source })).resolves.toHaveProperty('token');
    expect(sdk.dispatch.mock.calls.some(([method]) => method === 'mcp.app.readResource')).toBe(
      false,
    );
  });

  it('keeps admitted provenance after a model change and exports fresh content without old native grants', async () => {
    await admit();
    const normal = sdk.dispatch.getMockImplementation()!;
    sdk.dispatch.mockClear();
    sdk.dispatch.mockImplementation((name, params) =>
      name.startsWith('mcp.app.')
        ? Promise.resolve({
            ok: false,
            error: { code: 'UNAVAILABLE', message: 'runtime selection changed' },
          })
        : normal(name, params),
    );
    const edited = {
      ...snapshot,
      xml: xml.replace('id="1"', 'value="Manual edit" id="1"'),
      contentStamp: 'fresh',
    };
    const { token } = await prepareOnly({ snapshot: edited });
    expect(sdk.dispatch.mock.calls.some(([name]) => name.startsWith('mcp.app.'))).toBe(false);
    await request(DRAWIO_SEND_METHOD, {
      ...scope,
      send: { ...scope, idempotencyKey: 'changed-model', message: 'Edit the same diagram' },
      canvases: [{ token, viewId: 'mcp-app-original', selected: true }],
    });
    const tool = factory.create({ ...scope, assertInvocationCurrent: vi.fn() });
    tool.prepareBeforeToolCallParams(
      {},
      {
        toolCallId: 'read-new-model',
        hookContext: { ...scope, runId: 'changed-model' },
      },
    );
    expect(
      JSON.parse((await tool.execute('read-new-model', { action: 'read' })).content[0].text),
    ).toEqual(edited);
  });

  it('retains provenance across ordinary suspension but forgets it on explicit editor disposal', async () => {
    const first = await prepare();
    await request(DRAWIO_CANVAS_METHOD, {
      ...scope,
      viewId: 'mcp-app-original',
      action: 'detach',
      token: '',
    });
    const next = await prepareOnly({ retire: true });
    expect(next.token).not.toBe(first.token);
    await request(DRAWIO_CANVAS_METHOD, {
      ...scope,
      viewId: 'mcp-app-original',
      action: 'detach',
      token: '',
      forgetSource: true,
    });
    await expect(prepareOnly()).rejects.toThrow();
  });

  it.each(['connection', 'lifecycle', 'service', 'diagram', 'view'])(
    'refuses stale or mismatched %s provenance',
    async kind => {
      await admit();
      if (kind === 'connection') connections.get('connection')!.abort();
      if (kind === 'lifecycle')
        sdk.entry.mockReturnValue({ sessionId: scope.sessionId, lifecycleRevision: 'replaced' });
      if (kind === 'service') {
        service.stop();
        service.start({ gatewayEvents: { emit: emitted } });
      }
      await expect(
        prepareOnly({
          ...(kind === 'diagram' ? { snapshot: { ...snapshot, diagramId: 'diagram-other' } } : {}),
          ...(kind === 'view' ? { viewId: 'mcp-app-other' } : {}),
        }),
      ).rejects.toThrow();
      if (kind === 'connection')
        await expect(prepareOnly({}, 'foreign-connection')).rejects.toThrow();
    },
  );

  it('freezes one exact native send and admits read/update only through trusted tool preparation', async () => {
    const { token } = await prepare();
    const send = { ...scope, idempotencyKey: 'run', message: 'Edit current diagram' };
    await request(DRAWIO_SEND_METHOD, {
      ...scope,
      send,
      canvases: [{ token, viewId: 'mcp-app-original', selected: true }],
    });
    expect(sdk.dispatch).toHaveBeenCalledWith('chat.send', send);
    const guard = vi.fn();
    const tool = factory.create({ ...scope, assertInvocationCurrent: guard });
    await expect(tool.execute('unprepared', { action: 'read', runId: 'run' })).rejects.toThrow(
      'identity unavailable',
    );
    const metadata = (call: string, runId = 'run') => ({
      toolCallId: call,
      hookContext: { ...scope, runId },
    });
    tool.prepareBeforeToolCallParams({}, metadata('read'));
    const current = await tool.execute('read', { action: 'read' });
    expect(JSON.parse(current.content[0].text)).toEqual(snapshot);
    tool.prepareBeforeToolCallParams({}, metadata('update'));
    const updating = tool.execute('update', {
      action: 'update',
      diagramId: 'diagram-one',
      baseContentStamp: 'base',
      xml,
      title: 'Updated',
    });
    expect(emitted).toHaveBeenCalledWith(
      'canvas-changed',
      { viewId: 'mcp-app-original' },
      { scope: 'operator.admin' },
    );
    const { operation } = await request(DRAWIO_CANVAS_METHOD, {
      ...scope,
      viewId: 'mcp-app-original',
      token,
      action: 'next',
    });
    await expect(
      request(
        DRAWIO_CANVAS_METHOD,
        {
          ...scope,
          viewId: 'mcp-app-original',
          token,
          action: 'ack',
          operationId: operation.operationId,
          result: { status: 'applied', snapshot: { ...snapshot, contentStamp: 'applied' } },
        },
        'foreign-connection',
      ),
    ).rejects.toThrow();
    await request(DRAWIO_CANVAS_METHOD, {
      ...scope,
      viewId: 'mcp-app-original',
      token,
      action: 'ack',
      operationId: operation.operationId,
      result: { status: 'applied', snapshot: { ...snapshot, contentStamp: 'applied' } },
    });
    expect((await updating).details.diagramUpdate).toMatchObject({
      status: 'applied',
      runId: 'run',
      toolCallId: 'update',
    });
    expect(
      (
        await request(DRAWIO_CANVAS_METHOD, {
          ...scope,
          viewId: 'mcp-app-original',
          token,
          action: 'next',
        })
      ).operation,
    ).toBeNull();
    await expect(
      request(DRAWIO_SEND_METHOD, {
        ...scope,
        send,
        canvases: [{ token, viewId: 'mcp-app-original', selected: true }],
      }),
    ).rejects.toThrow();
  });

  it('does not authorize a guessed run or retained invocation after source invalidation', async () => {
    const tool = factory.create({
      ...scope,
      assertInvocationCurrent: () => {
        if (!live) throw new Error('expired');
      },
    });
    expect(() =>
      tool.prepareBeforeToolCallParams({}, { toolCallId: 'call', hookContext: { ...scope } }),
    ).toThrow();
    tool.prepareBeforeToolCallParams(
      {},
      { toolCallId: 'call', hookContext: { ...scope, runId: 'guessed' } },
    );
    await expect(tool.execute('call', { action: 'read' })).rejects.toThrow('No prepared diagram');
    live = false;
    expect(() =>
      tool.prepareBeforeToolCallParams(
        {},
        { toolCallId: 'later', hookContext: { ...scope, runId: 'guessed' } },
      ),
    ).toThrow('expired');
    expect(getDiagramEditingState().canvases).toBeDefined();
    expect(tool.name).toBe(DRAWIO_EDIT_TOOL);
  });
});
