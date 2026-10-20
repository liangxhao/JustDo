import { McpAppMethod } from '@shared/plugins/mcpApps';
import { describe, expect, it, vi } from 'vitest';

import { DRAWIO_RESTORE_METHOD } from '../../../../../openclaw-extensions/drawio/contracts';
import {
  MCP_APP_HISTORY_TOOL_METHOD,
  MCP_APP_HISTORY_VIEW_METHOD,
} from '../../../../../openclaw-extensions/runtime-services/contracts/mcp-apps';
import type { GatewayClient, GatewayRequestOptions } from './client';
import { McpAppSession } from './mcp-app-session';

function fixture() {
  let current = true;
  const request = vi.fn(
    async (
      _method: string,
      _params?: unknown,
      _options?: GatewayRequestOptions,
    ): Promise<unknown> => ({}),
  );
  const client = {
    generation: 3,
    gatewayUrl: 'ws://127.0.0.1:18789',
    request,
    subscribeEvents: vi.fn(() => () => undefined),
  };
  const apps = new McpAppSession(() => ({
    client: client as unknown as GatewayClient,
    generation: 3,
    sessionKey: 'agent:a:conversation',
    sessionId: 'native-incarnation',
    agentId: 'a',
    isCurrent: () => current,
  }));
  return {
    apps,
    client,
    request,
    expire: () => {
      current = false;
    },
  };
}

describe('MCP App native session authority', () => {
  it('suspends a retained presentation without rereading it and rejects responses from before navigation', async () => {
    const { apps, request } = fixture();
    const view = apps.bind('mcp-app-retained');
    await view.view();
    view.preservePresentation = true;
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const pending = view.request(McpAppMethod.CallTool, { toolName: 'edit' });
    const rejected = expect(pending).rejects.toThrow('superseded');
    apps.invalidate(true);
    expect(view.suspended).toBe(true);
    expect(view.isCurrent()).toBe(false);
    await expect(view.request(McpAppMethod.CallTool)).rejects.toThrow('expired');
    expect(apps.resume(view)).toBe(true);
    expect(view.isCurrent()).toBe(true);
    finish({ ok: true });
    await rejected;
    await view.request(McpAppMethod.ListTools);
    expect(request.mock.calls.filter(([method]) => method === McpAppMethod.View)).toHaveLength(1);
    apps.reportContext(view.viewId!, 'Editor', { updateId: 'new-selection' } as never);
    await view.close();
    expect(request).toHaveBeenLastCalledWith(
      McpAppMethod.RemoveModelContext,
      expect.objectContaining({
        sessionKey: 'agent:a:conversation',
        viewId: 'mcp-app-retained',
        updateId: 'new-selection',
      }),
      expect.anything(),
    );
    expect(apps.getContexts()).toEqual([]);
  });

  it('does not resume a retained presentation through another connection generation or a hard invalidation', async () => {
    const { apps, client } = fixture();
    const view = apps.bind('mcp-app-retained');
    await view.view();
    view.preservePresentation = true;
    apps.invalidate(true);
    client.generation++;
    expect(apps.resume(view)).toBe(false);
    client.generation--;
    apps.invalidate();
    expect(view.suspended).toBe(false);
    expect(apps.resume(view)).toBe(false);
  });

  it('binds plugin resource access to the authenticated view and strips forged scope', async () => {
    const { apps, request, expire } = fixture();
    const uri = `app-file://${'a'.repeat(64)}`;
    request.mockImplementation(async method =>
      method === McpAppMethod.View
        ? {
            messageSupported: true,
            hostContext: { 'openai/deepLink': { url: `/workspace-file/${'a'.repeat(64)}` } },
          }
        : { uri, name: 'budget.xlsx', writable: true },
    );
    const view = apps.bind('mcp-app-file');
    const payload = await view.view(undefined, {
      viewId: 'mcp-app-file',
      serverName: 'sheets',
      toolName: 'open_editor',
      uiResourceUri: 'ui://sheets/app.html',
      toolCallId: 'open',
      originSessionKey: 'agent:a:conversation',
    });
    expect(payload.workspaceFile).toEqual({ uri, name: 'budget.xlsx', writable: true });
    await view.fileResource('write', {
      uri,
      ifMatch: 'hash',
      blob: 'data',
      sessionKey: 'foreign',
      sessionId: 'foreign',
      viewId: 'foreign',
    });
    expect(request).toHaveBeenLastCalledWith(
      'mcp-app-files.resource.sheets',
      {
        action: 'write',
        uri,
        ifMatch: 'hash',
        blob: 'data',
        sessionKey: 'agent:a:conversation',
        sessionId: 'native-incarnation',
        agentId: 'a',
        viewId: 'mcp-app-file',
      },
      expect.anything(),
    );
    expect(() => view.fileResource('read', { uri: 'app-file://foreign' })).toThrow('unavailable');
    expire();
    await expect(view.fileResource('write', { uri })).rejects.toThrow('expired');
  });

  it('keeps older file plugins readable when their resource adapter is absent', async () => {
    const { apps, request } = fixture();
    request.mockResolvedValueOnce({
      messageSupported: true,
      hostContext: { 'openai/deepLink': { url: `/workspace-file/${'a'.repeat(64)}` } },
    });
    request.mockRejectedValueOnce(
      Object.assign(new Error('unknown method: mcp-app-files.resource.sheets'), {
        gatewayCode: 'INVALID_REQUEST',
      }),
    );
    const view = apps.bind('mcp-app-file');
    expect(
      (
        await view.view(undefined, {
          viewId: 'mcp-app-file',
          serverName: 'sheets',
          toolName: 'open_editor',
          uiResourceUri: 'ui://sheets/app.html',
          toolCallId: 'open',
          originSessionKey: 'agent:a:conversation',
        })
      ).workspaceFile,
    ).toBeUndefined();
    expect(() => view.fileResource('write', { uri: 'app-file://any' })).toThrow('unavailable');
  });

  const fileInput = {
    serverName: 'univer',
    toolName: 'preview_file',
    entrypointType: 'file' as const,
    filePath: 'E:/workspace/预算.xlsx',
  };

  it('launches plugin file handlers with the captured native incarnation', async () => {
    const { apps, request } = fixture();
    request.mockResolvedValue({ viewId: 'mcp-app-file' });
    await expect(apps.launch(fileInput)).resolves.toEqual({ viewId: 'mcp-app-file' });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'mcp-app-files.open.univer',
      {
        ...fileInput,
        sessionKey: 'agent:a:conversation',
        sessionId: 'native-incarnation',
        agentId: 'a',
      },
      expect.anything(),
    );
  });

  it('falls back only after the native router proves the plugin handler is absent', async () => {
    const { apps, request } = fixture();
    request.mockRejectedValueOnce(
      Object.assign(new Error('unknown method: mcp-app-files.open.univer'), {
        gatewayCode: 'INVALID_REQUEST',
      }),
    );
    await apps.launch(fileInput);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'mcp-app-files.open.univer',
      McpAppMethod.Launch,
    ]);
    expect(request.mock.calls[1][1]).not.toHaveProperty('sessionId');
  });

  it.each([
    new Error('request timeout'),
    Object.assign(new Error('outside workspace'), { gatewayCode: 'UNAVAILABLE' }),
    Object.assign(new Error('unknown method: different'), { gatewayCode: 'INVALID_REQUEST' }),
  ])('does not replay failed or uncertain file operations: %s', async error => {
    const { apps, request } = fixture();
    request.mockRejectedValueOnce(error);
    await expect(apps.launch(fileInput)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('discards a late file launch after the native binding changes', async () => {
    const { apps, request, expire } = fixture();
    request.mockImplementationOnce(async () => {
      expire();
      return { viewId: 'mcp-app-stale' };
    });
    await expect(apps.launch(fileInput)).rejects.toThrow('superseded');
    expect(request).toHaveBeenCalledTimes(1);
  });
  const original = {
    viewId: 'mcp-app-original',
    serverName: 'drawio',
    toolName: 'create_diagram',
    uiResourceUri: 'ui://drawio/editor',
    toolCallId: 'child',
    originSessionKey: 'agent:a:conversation',
  };
  const expired = () =>
    Object.assign(new Error('expired'), { details: { code: 'MCP_APP_VIEW_EXPIRED' } });

  it('restores only an expired diagram reference and routes subsequent operations through its fresh native view', async () => {
    const { apps, request } = fixture();
    request
      .mockRejectedValueOnce(expired())
      .mockResolvedValueOnce({ viewId: 'mcp-app-fresh', payload: { html: 'editor' } })
      .mockResolvedValue({});
    const view = apps.bind(original.viewId);
    expect(await view.view(undefined, original)).toEqual({ html: 'editor' });
    expect(request.mock.calls[1]).toEqual([
      DRAWIO_RESTORE_METHOD,
      {
        sessionKey: 'agent:a:conversation',
        agentId: 'a',
        sessionId: 'native-incarnation',
        viewId: original.viewId,
      },
      expect.anything(),
    ]);
    await view.request(McpAppMethod.ListResources);
    expect(request).toHaveBeenLastCalledWith(
      McpAppMethod.ListResources,
      expect.objectContaining({ viewId: 'mcp-app-fresh' }),
      expect.anything(),
    );
    apps.reportContext(original.viewId, 'Diagram', { updateId: 'selection' });
    await apps.removeContext(original.viewId, 'selection');
    expect(request).toHaveBeenLastCalledWith(
      McpAppMethod.RemoveModelContext,
      expect.objectContaining({ viewId: 'mcp-app-fresh', updateId: 'selection' }),
      expect.anything(),
    );
  });

  it.each(['network', 'session', 'view'])(
    'does not recover a %s failure or identity mismatch',
    async kind => {
      const { apps, request } = fixture();
      request.mockRejectedValue(kind === 'network' ? new Error('disconnected') : expired());
      const descriptor = { ...original };
      if (kind === 'session') descriptor.originSessionKey = 'agent:other:conversation';
      if (kind === 'view') descriptor.viewId = 'mcp-app-other';
      await expect(apps.bind(original.viewId).view(undefined, descriptor)).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it('uses native history recovery for an expired third-party App without replaying the tool', async () => {
    const { apps, request } = fixture();
    const descriptor = {
      ...original,
      serverName: 'budget-allocator',
      toolName: 'get-budget-data',
      uiResourceUri: 'ui://budget/app',
    };
    request.mockRejectedValueOnce(expired()).mockResolvedValueOnce({
      viewId: 'mcp-app-history',
      payload: { html: 'history', messageSupported: false },
    });
    const view = apps.bind(descriptor.viewId);
    expect(await view.view(undefined, descriptor)).toMatchObject({
      html: 'history',
      messageSupported: false,
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      McpAppMethod.View,
      MCP_APP_HISTORY_VIEW_METHOD,
    ]);
    expect(request.mock.calls[1][1]).toEqual({
      sessionKey: 'agent:a:conversation',
      sessionId: 'native-incarnation',
      agentId: 'a',
      viewId: descriptor.viewId,
    });
    request.mockResolvedValueOnce({ content: [], structuredContent: { total: 100 } });
    expect(await view.readHistoricalTool('get-budget-data', {})).toEqual({
      content: [],
      structuredContent: { total: 100 },
    });
    expect(request).toHaveBeenLastCalledWith(
      MCP_APP_HISTORY_TOOL_METHOD,
      {
        sessionKey: 'agent:a:conversation',
        sessionId: 'native-incarnation',
        agentId: 'a',
        viewId: descriptor.viewId,
        toolName: 'get-budget-data',
        arguments: {},
      },
      expect.anything(),
    );
    request.mockRejectedValueOnce(new Error('Different input is not a historical result'));
    await expect(view.readHistoricalTool('edit', { value: 2 })).rejects.toThrow('Different input');
    expect(request.mock.calls.some(([method]) => method === McpAppMethod.CallTool)).toBe(false);
    request.mockResolvedValueOnce({ html: 'reread', messageSupported: true });
    expect(await view.view()).toMatchObject({
      html: 'reread',
      messageSupported: false,
      updateModelContextSupported: false,
    });
    await view.close();
    await expect(view.readHistoricalTool('get-budget-data')).rejects.toThrow('expired');
  });

  it('aborts recovery and rejects its late result after the presentation closes', async () => {
    const { apps, request } = fixture();
    let finish!: (value: unknown) => void;
    request.mockRejectedValueOnce(expired()).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const view = apps.bind(original.viewId);
    const pending = view.view(undefined, original);
    const rejection = expect(pending).rejects.toThrow('superseded');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const options = request.mock.calls[1][2];
    await view.close();
    expect(options?.signal?.aborted).toBe(true);
    finish({ viewId: 'mcp-app-fresh', payload: { html: 'late' } });
    await rejection;
  });

  it('aborts a recovery wait when the owning session is invalidated', async () => {
    const { apps, request } = fixture();
    let finish!: (value: unknown) => void;
    request.mockRejectedValueOnce(expired()).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const pending = apps.bind(original.viewId).view(undefined, original);
    const rejection = expect(pending).rejects.toThrow('superseded');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const signal = request.mock.calls[1][2]?.signal;

    apps.invalidate();
    const aborted = signal?.aborted;
    finish({ viewId: 'mcp-app-fresh', payload: { html: 'late' } });

    await rejection;
    expect(aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('cancels historical result waits locally and rejects their late response after close', async () => {
    const { apps, request } = fixture();
    const descriptor = {
      ...original,
      serverName: 'cohort-heatmap',
      toolName: 'get-cohort-data',
      uiResourceUri: 'ui://get-cohort-data/mcp-app.html',
    };
    request.mockRejectedValueOnce(expired()).mockResolvedValueOnce({
      viewId: 'mcp-app-history',
      payload: { html: 'history', messageSupported: false },
    });
    const view = apps.bind(original.viewId);
    await view.view(undefined, descriptor);
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const pending = view.readHistoricalTool('get-cohort-data', {});
    const rejected = expect(pending).rejects.toThrow('superseded');
    const options = request.mock.lastCall![2];
    await view.close();
    expect(options?.signal?.aborted).toBe(true);
    finish({ content: [] });
    await rejected;
  });
  it('transfers context cleanup to a replacement presentation on the same session epoch', async () => {
    const { apps, request } = fixture();
    const old = apps.bind('view');
    await old.view();
    apps.reportContext('view', 'Diagram', { updateId: 'selection' });
    old.detach();
    const next = apps.bind('view');
    await next.view();
    request.mockClear();
    await old.close();
    expect(request).not.toHaveBeenCalled();
    expect(apps.getContexts()).toHaveLength(1);
    apps.reportContext('view', 'Diagram', { updateId: 'replacement' });
    await next.close();
    expect(request).toHaveBeenCalledWith(
      McpAppMethod.RemoveModelContext,
      expect.objectContaining({ updateId: 'replacement' }),
      expect.anything(),
    );
  });
  it('never lets a detached old presentation clear the new selection after returning to the same session', async () => {
    const { apps, request } = fixture();
    const old = apps.bind('view');
    await old.view();
    apps.reportContext('view', 'Diagram', { updateId: 'old' });
    old.detach();
    apps.invalidate();
    await apps.bind('view').view();
    apps.reportContext('view', 'Diagram', { updateId: 'new' });
    request.mockClear();
    await old.close();
    expect(request).not.toHaveBeenCalled();
    expect(apps.getContexts()).toEqual([{ viewId: 'view', title: 'Diagram', updateId: 'new' }]);
  });

  it('preserves a newer context reported while an exact cleanup is in flight', async () => {
    const { apps, request } = fixture();
    const old = apps.bind('view');
    await old.view();
    apps.reportContext('view', 'Diagram', { updateId: 'old' });
    let finish!: (value: unknown) => void;
    request.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const closing = old.close();
    apps.reportContext('view', 'Diagram', { updateId: 'new' });
    finish({});
    await closing;
    expect(apps.getContexts()).toEqual([{ viewId: 'view', title: 'Diagram', updateId: 'new' }]);
    expect(request).toHaveBeenCalledWith(
      McpAppMethod.RemoveModelContext,
      expect.objectContaining({ updateId: 'old' }),
      expect.anything(),
    );
  });
  it('injects only the captured owner into native requests', async () => {
    const { apps, request } = fixture();
    const view = apps.bind('view');
    await view.view();
    await view.request(McpAppMethod.CallTool, {
      toolName: 'edit',
      sessionKey: 'other',
      agentId: 'other',
      viewId: 'other',
      requesterId: 'other',
      requestId: 'other',
      sessionId: 'other',
    });
    expect(request).toHaveBeenLastCalledWith(
      McpAppMethod.CallTool,
      {
        toolName: 'edit',
        sessionKey: 'agent:a:conversation',
        agentId: 'a',
        viewId: 'view',
      },
      expect.objectContaining({ timeoutMs: null }),
    );
  });

  it('aborts the local wait without inventing a native cancellation or retry', async () => {
    const { apps, request } = fixture();
    request.mockImplementation(
      async (_method, _params, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        ),
    );
    const controller = new AbortController();
    const operation = apps
      .bind('view')
      .request(McpAppMethod.CallTool, { toolName: 'edit' }, controller.signal);
    const rejected = expect(operation).rejects.toThrow('aborted');
    controller.abort();
    await rejected;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never revives a stale binding after switching away and back on the same socket', async () => {
    const { apps, request } = fixture();
    const old = apps.bind('view');
    apps.invalidate();
    await expect(old.request(McpAppMethod.CallTool)).rejects.toThrow('expired');
    expect(request).not.toHaveBeenCalled();
    await expect(apps.bind('view').request(McpAppMethod.ListTools)).resolves.toEqual({});
  });

  it('retires a pending launch locally without replaying its unknown native outcome', async () => {
    const { apps, request } = fixture();
    request.mockImplementation(
      async (_method, _params, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        ),
    );
    const operation = apps.launch({
      serverName: 'demo',
      toolName: 'show',
      entrypointType: 'global',
    });
    const rejected = expect(operation).rejects.toThrow('aborted');
    apps.invalidate();
    await rejected;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('closes once and removes only the known native context update', async () => {
    const { apps, request } = fixture();
    const view = apps.bind('view');
    await view.view();
    apps.reportContext('view', 'Diagram', { updateId: 'selection-1' });
    await view.close();
    await view.close();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      McpAppMethod.View,
      McpAppMethod.RemoveModelContext,
    ]);
    expect(request).toHaveBeenLastCalledWith(
      McpAppMethod.RemoveModelContext,
      {
        sessionKey: 'agent:a:conversation',
        agentId: 'a',
        viewId: 'view',
        updateId: 'selection-1',
      },
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(apps.getContexts()).toEqual([]);
    await expect(view.request(McpAppMethod.CallTool)).rejects.toThrow('expired');
  });

  it('removes context retained by a detached frame on session retirement', async () => {
    const { apps, request } = fixture();
    const view = apps.bind('view');
    await view.view();
    apps.reportContext('view', 'Diagram', { updateId: 'selection-1' });
    view.detach();
    apps.invalidate();
    expect(request).toHaveBeenLastCalledWith(
      McpAppMethod.RemoveModelContext,
      expect.objectContaining({ updateId: 'selection-1' }),
      expect.anything(),
    );
    expect(apps.getContexts()).toEqual([]);
  });

  it('never sends stale cleanup through a replacement socket generation', async () => {
    const { apps, client, request } = fixture();
    const view = apps.bind('view');
    await view.view();
    apps.reportContext('view', 'Diagram', { updateId: 'selection-1' });
    client.generation++;
    await view.close();
    expect(request).toHaveBeenCalledTimes(1);
    await expect(view.request(McpAppMethod.CallTool)).rejects.toThrow('expired');
  });

  it('rejects a late native response after local cancellation', async () => {
    const { apps, request } = fixture();
    let complete!: (value: unknown) => void;
    request.mockImplementation(
      () =>
        new Promise(resolve => {
          complete = resolve;
        }),
    );
    const view = apps.bind('view');
    const operation = view.request(McpAppMethod.CallTool);
    const rejected = expect(operation).rejects.toThrow('superseded');
    await view.close();
    complete({ result: 'already completed on server' });
    await rejected;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports failed context cleanup without retrying or blocking a fresh native read', async () => {
    const { apps, request } = fixture();
    const view = apps.bind('view');
    await view.view();
    apps.reportContext('view', 'Diagram', { updateId: 'selection-1' });
    request.mockImplementation(async method => {
      if (method === McpAppMethod.RemoveModelContext) throw new Error('unavailable');
      return {};
    });
    await expect(view.close()).rejects.toThrow('unavailable');
    await expect(apps.bind('view').view()).resolves.toEqual({});
    expect(
      request.mock.calls.filter(([method]) => method === McpAppMethod.RemoveModelContext),
    ).toHaveLength(1);
  });
});
