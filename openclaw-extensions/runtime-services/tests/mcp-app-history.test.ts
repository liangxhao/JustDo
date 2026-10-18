import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MCP_APP_HISTORY_TOOL_METHOD, MCP_APP_HISTORY_VIEW_METHOD } from '../contracts/mcp-apps';
import { registerMcpAppHistory } from '../mcp-app-history';

const sdk = vi.hoisted(() => ({
  session: vi.fn(),
  transcript: vi.fn(),
  dispatch: vi.fn(),
  materialize: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('openclaw/plugin-sdk/agent-scope-runtime', () => ({ resolveAgentDir: () => '/agent' }));
vi.mock('openclaw/plugin-sdk/agent-harness-runtime', () => ({
  getPluginToolMeta: (tool: { mcp: unknown }) => ({ mcp: tool.mcp }),
  prepareHarnessNativeMcpAppPreview: sdk.preview,
}));
vi.mock('openclaw/plugin-sdk/codex-mcp-projection', () => ({
  materializeStaticMcpToolsForHarnessRun: sdk.materialize,
}));
vi.mock('openclaw/plugin-sdk/gateway-method-runtime', () => ({
  dispatchGatewayMethod: sdk.dispatch,
}));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({ getSessionEntry: sdk.session }));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({
  readVisibleSessionTranscriptMessageEntries: sdk.transcript,
}));

const sessionKey = 'agent:main:history';
const sessionId = 'native-history';
const viewId = 'mcp-app-original';
type Invocation = {
  params: Record<string, unknown>;
  respond: ReturnType<typeof vi.fn>;
  client: { connectionSignal: AbortSignal };
  signal: AbortSignal;
  hasCurrentClientAuthority: () => boolean;
};

function fixture() {
  let entry: Record<string, unknown> = {
    sessionId,
    lifecycleRevision: 'revision',
    sessionRoot: '/workspace',
    permissionMode: 'workspace',
  };
  const cfg = { mcp: { apps: { enabled: true } }, plugins: { entries: {} }, tools: {} };
  let authorized = true;
  const methods = new Map<string, (input: Invocation) => Promise<void>>();
  registerMcpAppHistory({
    runtime: { config: { current: () => cfg } },
    registerGatewayMethod: (name: string, handler: (input: Invocation) => Promise<void>) =>
      methods.set(name, handler),
    logger: { warn: vi.fn() },
  } as never);
  sdk.session.mockImplementation(() => entry);
  const original = {
    role: 'custom',
    customType: 'openclaw.nested-tool.v1',
    display: true,
    excludeFromContext: true,
    details: {
      runId: 'run',
      parentToolCallId: 'parent',
      toolCallId: 'child',
      toolName: 'fixture__show',
      input: { rows: 3 },
      isError: false,
      result: {
        content: [{ type: 'text', text: 'Recorded result' }],
        details: {
          mcpServer: 'fixture',
          mcpTool: 'show',
          structuredContent: { total: 100 },
          mcpAppPreview: {
            mcpApp: {
              viewId,
              serverName: 'fixture',
              toolName: 'show',
              toolCallId: 'child',
              uiResourceUri: 'ui://fixture/app',
              originSessionKey: sessionKey,
            },
          },
        },
      },
    },
  };
  sdk.transcript.mockResolvedValue([{ message: original }]);
  sdk.dispatch.mockImplementation(async (method: string) => ({
    ok: true,
    payload:
      method === 'sessions.describe'
        ? { session: entry }
        : method === 'sessions.files.list'
          ? { root: '/workspace' }
          : { html: '<p>Fixture</p>', messageSupported: true },
  }));
  const execute = vi.fn(async () => {
    throw new Error('Business tool must never execute');
  });
  const read = vi.fn(async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ contents: [{ uri: 'ui://fixture/app', text: '<p>Fixture</p>' }] }),
      },
    ],
  }));
  const dispose = vi.fn(async () => undefined);
  sdk.materialize.mockResolvedValue({
    tools: [
      {
        mcp: { serverName: 'fixture', toolName: 'show', operation: 'tool' },
        parameters: { type: 'object', properties: { rows: { default: 3 } } },
        execute,
      },
      { mcp: { serverName: 'fixture', operation: 'resources_read' }, execute: read },
    ],
    dispose,
  });
  sdk.preview.mockResolvedValue({ mcpAppPreview: { mcpApp: { viewId: 'mcp-app-recovered' } } });
  const connection = new AbortController();
  const request = new AbortController();
  const invoke = async (method: string, extra: Record<string, unknown> = {}) => {
    const respond = vi.fn();
    await methods.get(method)!({
      params: { sessionKey, sessionId, agentId: 'main', viewId, ...extra },
      respond,
      client: { connectionSignal: connection.signal },
      signal: request.signal,
      hasCurrentClientAuthority: () => authorized,
    });
    return respond;
  };
  return {
    invoke,
    execute,
    read,
    dispose,
    cfg,
    original,
    connection,
    request,
    changeEntry: (change: Record<string, unknown>) => {
      entry = { ...entry, ...change };
    },
    revoke: () => {
      authorized = false;
    },
  };
}

beforeEach(() => vi.resetAllMocks());

describe('authenticated MCP App history recovery', () => {
  it('requires native session visibility before reading any transcript or MCP resource', async () => {
    const f = fixture();
    sdk.dispatch.mockResolvedValue({ ok: false });
    const respond = await f.invoke(MCP_APP_HISTORY_VIEW_METHOD);
    expect(respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: 'UNAVAILABLE' }),
    );
    expect(sdk.transcript).not.toHaveBeenCalled();
    expect(sdk.materialize).not.toHaveBeenCalled();
  });

  it.each(['incarnation', 'lifecycle', 'permission', 'policy', 'authority', 'connection'])(
    'rejects a %s change while reading native history',
    async change => {
      const f = fixture();
      sdk.transcript.mockImplementation(async () => {
        if (change === 'incarnation') f.changeEntry({ sessionId: 'replacement' });
        if (change === 'lifecycle') f.changeEntry({ lifecycleRevision: 'replacement' });
        if (change === 'permission') f.changeEntry({ permissionMode: 'guarded' });
        if (change === 'policy') f.cfg.mcp.apps.enabled = false;
        if (change === 'authority') f.revoke();
        if (change === 'connection') f.connection.abort();
        return [{ message: f.original }];
      });
      const respond = await f.invoke(MCP_APP_HISTORY_VIEW_METHOD);
      expect(respond).toHaveBeenLastCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: 'UNAVAILABLE' }),
      );
      expect(sdk.materialize).not.toHaveBeenCalled();
    },
  );

  it('returns only the recorded result for the original tool and matching defaulted input', async () => {
    const f = fixture();
    const respond = await f.invoke(MCP_APP_HISTORY_TOOL_METHOD, {
      toolName: 'show',
      arguments: {},
    });
    expect(respond).toHaveBeenLastCalledWith(true, {
      content: [{ type: 'text', text: 'Recorded result' }],
      structuredContent: { total: 100 },
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it.each([{ toolName: 'write' }, { toolName: 'show', arguments: { rows: 4 } }])(
    'rejects a new historical query or business operation %#',
    async input => {
      const f = fixture();
      const respond = await f.invoke(MCP_APP_HISTORY_TOOL_METHOD, input);
      expect(respond).toHaveBeenLastCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: 'UNAVAILABLE' }),
      );
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.dispose).toHaveBeenCalledOnce();
    },
  );

  it('creates a view with no tool, file or context authority and an exact resource reader', async () => {
    const f = fixture();
    const respond = await f.invoke(MCP_APP_HISTORY_VIEW_METHOD);
    expect(respond).toHaveBeenLastCalledWith(true, {
      viewId: 'mcp-app-recovered',
      payload: {
        html: '<p>Fixture</p>',
        messageSupported: false,
        updateModelContextSupported: false,
        fileResourcesSupported: false,
        openFilesSupported: false,
      },
    });
    const { runtime, allowedAppToolNames } = sdk.preview.mock.calls[0][0];
    expect(allowedAppToolNames.size).toBe(0);
    expect(runtime.mcpAppModelContextRevoked).toBe(true);
    expect(runtime.canReadLocalFiles()).toBe(false);
    await expect(runtime.callTool()).rejects.toThrow('cannot execute');
    await expect(runtime.readResource('other', 'ui://fixture/app')).rejects.toThrow(
      'cannot execute',
    );
    await expect(runtime.readResource('fixture', 'ui://other/app')).rejects.toThrow(
      'cannot execute',
    );
    expect(await runtime.readResource('fixture', 'ui://fixture/app')).toEqual({
      contents: [{ uri: 'ui://fixture/app', text: '<p>Fixture</p>' }],
    });
    f.revoke();
    expect(() => runtime.assertOwnerCurrent()).toThrow('session changed');
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
  });
});
