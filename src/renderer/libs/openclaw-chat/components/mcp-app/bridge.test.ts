import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import { App } from '@modelcontextprotocol/ext-apps';
import { McpAppMethod } from '@shared/plugins/mcpApps';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { McpAppSessionView } from '../../gateway/mcp-app-session';
import { createMcpAppBridge } from './bridge';

function pair(): [Transport, Transport] {
  const first: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      queueMicrotask(() => second.onmessage?.(message));
    },
    async close() {},
  };
  const second: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      queueMicrotask(() => first.onmessage?.(message));
    },
    async close() {},
  };
  return [first, second];
}
async function fixture(
  historyTool?: (name: string, args?: Record<string, unknown>) => Promise<unknown>,
  workspaceFile?: { uri: string; name: string; writable: boolean },
) {
  let interactive = true;
  const request = vi.fn(
    async (method: string, _params?: unknown, _signal?: AbortSignal): Promise<unknown> => {
      if (method === McpAppMethod.CallTool) return { content: [{ type: 'text', text: 'updated' }] };
      if (method === McpAppMethod.ListTools) return { tools: [] };
      if (method === McpAppMethod.ReadResource)
        return {
          contents: [
            {
              uri: 'openclaw-file://model',
              text: 'content',
              _meta: { 'openai/resource': { writable: true, etag: 'revision-1' } },
            },
          ],
        };
      if (method === McpAppMethod.ModelContext)
        return {
          state: { updateId: 'selection-1', content: [{ type: 'text', text: 'selection' }] },
        };
      if (method === McpAppMethod.OpenFile) return { path: 'fixture.txt', name: 'fixture.txt' };
      return {};
    },
  );
  const confirmDraft = vi.fn(async () => false);
  const confirmFile = vi.fn(async () => false);
  const openFile = vi.fn(async () => false);
  const contextChanged = vi.fn();
  const fileResource = vi.fn(async (action: string, params: Record<string, unknown>) =>
    action === 'read'
      ? {
          contents: [
            {
              uri: params.uri,
              blob: 'YWJj',
              _meta: { 'openai/resource': { etag: 'hash', writable: true } },
            },
          ],
        }
      : { outcome: 'saved', etag: 'updated' },
  );
  const host = createMcpAppBridge({
    session: {
      request,
      fileResource,
      subscribe: () => () => undefined,
      isCurrent: () => true,
      canReadHistoricalTool: Boolean(historyTool),
      readHistoricalTool: historyTool,
    } as unknown as McpAppSessionView,
    payload: {
      html: '',
      sandboxPort: 1,
      sandboxUrl: '/mcp-app-sandbox',
      messageSupported: !historyTool,
      updateModelContextSupported: true,
      richModelContextSupported: true,
      fileResourcesSupported: true,
      openFilesSupported: true,
      workspaceFile,
    },
    hostContext: () => ({ theme: 'dark', displayMode: 'inline' }),
    canInteract: () => interactive,
    confirmDraft,
    confirmFile,
    openFile,
    contextChanged,
    close: () => undefined,
  });
  const app = new App({ name: 'SDK fixture', version: '1' }, {}, { autoResize: false });
  const [a, b] = pair();
  await host.bridge.connect(a);
  await app.connect(b);
  return {
    app,
    host,
    request,
    fileResource,
    confirmDraft,
    confirmFile,
    openFile,
    contextChanged,
    hide: () => {
      interactive = false;
    },
  };
}

describe('MCP Apps SDK round trip', () => {
  it('routes only the bound plugin file through its adapter and denies background writes', async () => {
    const file = { uri: `app-file://${'a'.repeat(64)}`, name: 'file.xlsx', writable: true };
    const { app, host, request, fileResource, hide } = await fixture(undefined, file);
    try {
      expect(await app.readServerResource({ uri: file.uri })).toMatchObject({
        contents: [{ uri: file.uri }],
      });
      expect(
        await app.request(
          {
            method: 'openai/resources/write',
            params: { uri: file.uri, ifMatch: 'hash', blob: 'YWJj' },
          },
          z.record(z.string(), z.unknown()),
        ),
      ).toEqual({ outcome: 'saved', etag: 'updated' });
      expect(fileResource).toHaveBeenCalledWith(
        'write',
        expect.objectContaining({ uri: file.uri, ifMatch: 'hash' }),
        expect.any(AbortSignal),
      );
      expect(request).not.toHaveBeenCalled();
      hide();
      await expect(
        app.request(
          { method: 'openai/resources/write', params: { uri: file.uri } },
          z.record(z.string(), z.unknown()),
        ),
      ).rejects.toThrow('not interactive');
      expect(fileResource).toHaveBeenCalledTimes(2);
    } finally {
      host.dispose();
      await app.close();
    }
  });
  it('serves original historical results to an App fetching on mount without calling live tools', async () => {
    const read = vi.fn(async (name: string) => {
      if (name !== 'get-cohort-data') throw new Error('No matching historical result');
      return { content: [], structuredContent: { cohorts: [{ cohortId: '2026-01' }] } };
    });
    const { app, host, request } = await fixture(read);
    try {
      expect(app.getHostCapabilities()?.serverTools).toEqual({});
      expect(
        await app.callServerTool({ name: 'get-cohort-data', arguments: { metric: 'retention' } }),
      ).toMatchObject({ structuredContent: { cohorts: [{ cohortId: '2026-01' }] } });
      await expect(app.callServerTool({ name: 'write-data' })).rejects.toThrow(
        'No matching historical result',
      );
      expect(request).not.toHaveBeenCalled();
    } finally {
      host.dispose();
      await app.close();
    }
  });
  it('initializes the standard SDK and routes tool calls through the native facade', async () => {
    const { app, host, request, hide } = await fixture();
    try {
      expect(app.getHostCapabilities()?.serverTools).toEqual({});
      expect(app.getHostContext()?.theme).toBe('dark');
      expect(await app.callServerTool({ name: 'edit', arguments: { value: 1 } })).toMatchObject({
        content: [{ text: 'updated' }],
      });
      expect(request).toHaveBeenCalledWith(
        McpAppMethod.CallTool,
        { toolName: 'edit', arguments: { value: 1 } },
        expect.any(AbortSignal),
      );
      hide();
      await expect(app.callServerTool({ name: 'edit' })).rejects.toThrow('not interactive');
    } finally {
      host.dispose();
      await app.close();
    }
  });

  it('keeps ETags and native context, and rejects unconfirmed follow-up messages', async () => {
    const { app, host, request, confirmDraft, contextChanged } = await fixture();
    try {
      expect(
        await app.readServerResource({
          uri: 'openclaw-file://model',
          _meta: { 'openai/resource': { representation: 'text' } },
        }),
      ).toMatchObject({
        contents: [{ _meta: { 'openai/resource': { writable: true, etag: 'revision-1' } } }],
      });
      expect(request).toHaveBeenCalledWith(
        McpAppMethod.ReadResource,
        { uri: 'openclaw-file://model', _meta: { 'openai/resource': { representation: 'text' } } },
        expect.any(AbortSignal),
      );
      await app.updateModelContext({ structuredContent: { selected: 1 } });
      expect(contextChanged).toHaveBeenCalledWith(
        expect.objectContaining({ updateId: 'selection-1' }),
      );
      expect(
        await app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'continue' }] }),
      ).toEqual({ isError: true });
      expect(confirmDraft).toHaveBeenCalledWith([{ type: 'text', text: 'continue' }], 'active');
      expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    } finally {
      host.dispose();
      await app.close();
    }
  });

  it('propagates SDK request cancellation into the native operation signal', async () => {
    const { app, host, request } = await fixture();
    let nativeSignal: AbortSignal | undefined;
    request.mockImplementation(
      async (_method, _params, signal) =>
        new Promise((_resolve, reject) => {
          nativeSignal = signal;
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const controller = new AbortController();
    try {
      const pending = app.callServerTool({ name: 'slow' }, { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(nativeSignal).toBeDefined());
      controller.abort();
      await rejected;
      await vi.waitFor(() => expect(nativeSignal?.aborted).toBe(true));
    } finally {
      host.dispose();
      await app.close();
    }
  });

  it('preserves the confirmed new-conversation target and rejects unknown message targets', async () => {
    const { app, host, confirmDraft, request } = await fixture();
    confirmDraft.mockResolvedValue(true);
    const message = (target: string, text: string) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      _meta: { 'openai/message': { target } },
    });
    try {
      await expect(app.sendMessage(message('new', 'New draft'))).resolves.toEqual({});
      expect(confirmDraft).toHaveBeenLastCalledWith([{ type: 'text', text: 'New draft' }], 'new');
      await expect(app.sendMessage(message('unknown', 'Invalid target'))).resolves.toEqual({
        isError: true,
      });
      expect(confirmDraft).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveBeenCalled();
    } finally {
      host.dispose();
      await app.close();
    }
  });

  it('opens the exact authorized absolute path when Gateway returns a relative display path', async () => {
    const { app, host, confirmFile, openFile, request } = await fixture();
    confirmFile.mockResolvedValue(true);
    openFile.mockResolvedValue(true);
    try {
      await expect(
        app.request(
          { method: 'openai/files/open', params: { path: '/workspace/fixture.txt' } },
          z.record(z.string(), z.unknown()),
        ),
      ).resolves.toEqual({});
      expect(request).toHaveBeenCalledWith(
        McpAppMethod.OpenFile,
        { path: '/workspace/fixture.txt' },
        expect.any(AbortSignal),
      );
      expect(openFile).toHaveBeenCalledWith({
        path: '/workspace/fixture.txt',
        name: 'fixture.txt',
      });
      confirmFile.mockResolvedValue(false);
      await expect(
        app.request(
          { method: 'openai/files/open', params: { path: '/workspace/fixture.txt' } },
          z.record(z.string(), z.unknown()),
        ),
      ).resolves.toEqual({ isError: true });
      expect(openFile).toHaveBeenCalledTimes(1);
    } finally {
      host.dispose();
      await app.close();
    }
  });

  it('does not open a file when its confirmed authorization returns after the App is hidden', async () => {
    const { app, host, confirmFile, openFile, request, hide } = await fixture();
    confirmFile.mockResolvedValue(true);
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(
      async () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    try {
      const pending = app.request(
        { method: 'openai/files/open', params: { path: '/workspace/fixture.txt' } },
        z.record(z.string(), z.unknown()),
      );
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      hide();
      finish({ path: 'fixture.txt', name: 'fixture.txt' });

      await expect(pending).resolves.toEqual({ isError: true });
      expect(openFile).not.toHaveBeenCalled();
    } finally {
      host.dispose();
      await app.close();
    }
  });
});
