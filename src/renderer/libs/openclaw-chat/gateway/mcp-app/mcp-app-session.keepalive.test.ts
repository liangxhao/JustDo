import { McpAppMethod } from '@shared/plugins/mcpApps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayClient, GatewayRequestOptions } from '../client';
import { McpAppSession } from './mcp-app-session';

function fixture() {
  const state = { active: true, owner: true };
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    params.keepAlive
      ? { viewId: params.viewId, expiresAtMs: Date.now() + 600_000 }
      : {},
  );
  const client = { generation: 1, request };
  const apps = new McpAppSession(() => ({
    client: client as unknown as GatewayClient,
    generation: 1,
    sessionKey: 'agent:main:lease-test',
    sessionId: 'lease-incarnation',
    agentId: 'main',
    isCurrent: () => state.active,
    isOwnerCurrent: () => state.owner,
  }));
  return { apps, request, client, state };
}

describe('MCP App view presence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps every loaded view on its original scope beyond the old fixed lifetime without reloading it', async () => {
    const f = fixture();
    const view = f.apps.bind('mcp-app-generic');
    await view.view();
    await vi.advanceTimersByTimeAsync(31 * 60_000);

    expect(f.request.mock.calls).toHaveLength(32);
    for (const [method, params] of f.request.mock.calls.slice(1)) {
      expect(method).toBe(McpAppMethod.View);
      expect(params).toEqual({
        sessionKey: 'agent:main:lease-test', sessionId: 'lease-incarnation',
        agentId: 'main', viewId: 'mcp-app-generic', keepAlive: true,
      });
    }
    expect(view.nativeViewId).toBe('mcp-app-generic');
    expect(view.isCurrent()).toBe(true);
    await view.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a paused tab through its original owner without restoring business access', async () => {
    const f = fixture();
    const view = f.apps.bind('mcp-app-paused');
    await view.view();
    view.preservePresentation = true;
    f.state.active = false;
    f.apps.invalidate(true);
    await vi.advanceTimersByTimeAsync(11 * 60_000);

    expect(view.suspended).toBe(true);
    expect(f.request.mock.calls.filter(([, p]) => p.keepAlive)).toHaveLength(11);
    await expect(view.request(McpAppMethod.CallTool, { toolName: 'write' }))
      .rejects.toThrow('binding expired');
    f.state.active = true;
    expect(f.apps.resume(view)).toBe(true);
    expect(view.nativeViewId).toBe('mcp-app-paused');
    f.state.owner = false;
    f.state.active = false;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(f.request.mock.calls.filter(([, p]) => p.keepAlive)).toHaveLength(11);
    await view.close();
  });

  it('renews the fresh native identity of a recovered read-only view', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(Object.assign(new Error('expired'), {
      details: { code: 'MCP_APP_VIEW_EXPIRED' },
    })).mockResolvedValueOnce({
      viewId: 'mcp-app-restored', payload: { html: 'history', messageSupported: false },
    });
    const view = f.apps.bind('mcp-app-original');
    const payload = await view.view(undefined, {
      viewId: 'mcp-app-original', serverName: 'example', toolName: 'show',
      uiResourceUri: 'ui://example/app', originSessionKey: 'agent:main:lease-test',
    });
    expect(payload.messageSupported).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.request.mock.calls.at(-1)).toEqual([
      McpAppMethod.View,
      expect.objectContaining({ viewId: 'mcp-app-restored', keepAlive: true }),
      expect.anything(),
    ]);
    await view.close();
  });

  it('aborts a pending heartbeat on close and ignores its late success', async () => {
    const f = fixture();
    const view = f.apps.bind('mcp-app-closing');
    await view.view();
    let complete!: (value: { viewId: string; expiresAtMs: number }) => void;
    let signal: AbortSignal | undefined;
    f.request.mockImplementationOnce((_method, _params, ...rest: unknown[]) => {
      signal = (rest[0] as GatewayRequestOptions).signal;
      return new Promise(resolve => { complete = resolve; });
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await view.close();
    expect(signal?.aborted).toBe(true);
    complete({ viewId: 'mcp-app-closing', expiresAtMs: Date.now() + 600_000 });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(f.request.mock.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on connection replacement and detach without adopting another generation', async () => {
    const f = fixture();
    const view = f.apps.bind('mcp-app-replaced');
    await view.view();
    f.client.generation++;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(f.request.mock.calls).toHaveLength(1);
    view.detach();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one pending heartbeat and discards its stale reply after a verified resume', async () => {
    const f = fixture();
    const view = f.apps.bind('mcp-app-resumed');
    await view.view();
    view.preservePresentation = true;
    let complete!: (value: object) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(f.request.mock.calls).toHaveLength(2);

    f.state.active = false;
    f.apps.invalidate(true);
    f.state.active = true;
    expect(f.apps.resume(view)).toBe(true);
    complete({});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.request.mock.calls).toHaveLength(3);
    expect(f.request.mock.calls[2][1]).toMatchObject({ viewId: 'mcp-app-resumed', keepAlive: true });
    await view.close();
  });

  it.each(['expired', 'unsupported', 'transient'] as const)(
    'bounds %s heartbeat failures and never replays launch or business tools', async kind => {
      const f = fixture();
      const view = f.apps.bind('mcp-app-failure');
      await view.view();
      if (kind === 'unsupported') f.request.mockResolvedValue({});
      else f.request.mockRejectedValue(kind === 'expired'
        ? Object.assign(new Error('expired'), { details: { code: 'MCP_APP_VIEW_EXPIRED' } })
        : new Error('temporarily unavailable'));
      await vi.advanceTimersByTimeAsync(20 * 60_000);

      expect(f.request.mock.calls).toHaveLength(kind === 'transient' ? 4 : 2);
      expect(f.request.mock.calls.every(([method]) => method === McpAppMethod.View)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await view.close();
    },
  );
});
