import {
  type ListToolsRequest,
  type ListToolsResult,
  specTypeSchemas,
  type StandardSchemaV1Sync,
} from '@modelcontextprotocol/client';
import { AppBridge, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import {
  McpAppEvent,
  McpAppMethod,
  type McpAppModelContext,
  mcpAppRecord,
  type McpAppViewPayload,
} from '@shared/plugins/mcpApps';
import { z } from 'zod';

import type { McpAppSessionView } from '../../gateway/mcp-app-session';

const recordSchema = z.record(z.string(), z.unknown());
type AppRequestContext = Parameters<NonNullable<AppBridge['oncalltool']>>[1];
function result<T>(schema: StandardSchemaV1Sync<unknown, T>, value: unknown): T {
  const parsed = schema['~standard'].validate(value);
  if (parsed.issues) throw new Error('Invalid Gateway MCP result');
  return parsed.value;
}

export class McpAppHostBridge extends AppBridge {
  setMessages(handler: NonNullable<AppBridge['onmessage']>): void {
    Reflect.set(this, 'onmessage', handler);
  }

  setContextUpdates(handler: NonNullable<AppBridge['onupdatemodelcontext']>): void {
    Reflect.set(this, 'onupdatemodelcontext', handler);
  }

  setTools(
    handler: (
      params: ListToolsRequest['params'],
      extra: AppRequestContext,
    ) => Promise<ListToolsResult>,
  ): void {
    this.replaceRequestHandler('tools/list', (request, extra) => handler(request.params, extra));
  }

  setExtension(
    method:
      | 'openai/resources/write'
      | 'resources/subscribe'
      | 'resources/unsubscribe'
      | 'openai/files/open',
    handler: (
      params: Record<string, unknown>,
      extra: AppRequestContext,
    ) => Promise<Record<string, unknown>>,
  ): void {
    this.replaceRequestHandler(method, { params: recordSchema, result: recordSchema }, handler);
  }
}

export interface McpAppBridgeHost {
  session: McpAppSessionView;
  payload: McpAppViewPayload;
  hostContext: () => McpUiHostContext;
  canInteract: () => boolean;
  canRead?: () => boolean;
  confirmDraft: (content: unknown[], target: 'active' | 'new') => Promise<boolean>;
  confirmFile: (path: string) => Promise<boolean>;
  openFile: (file: { path: string; name: string }) => Promise<boolean>;
  contextChanged: (state: McpAppModelContext | null) => void;
  close: () => void;
}

export function createMcpAppBridge(host: McpAppBridgeHost): {
  bridge: McpAppHostBridge;
  dispose: () => void;
  refreshContext: (clearedUpdateId?: string) => Promise<void>;
} {
  const { session, payload } = host;
  const interactive = payload.messageSupported === true;
  let disposed = false;
  let context: McpAppModelContext | null = null;
  let revision = 0;
  const subscriptions = new Set<string>();
  const request = (
    method: Parameters<McpAppSessionView['request']>[0],
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) => {
    if (disposed || !host.canInteract()) throw new Error('MCP App is not interactive');
    return session.request(method, params, signal);
  };
  const fileRequest = (
    action: 'read' | 'write',
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    if (disposed || !host.canInteract()) throw new Error('MCP App is not interactive');
    return session.fileResource(action, params, signal);
  };
  const bridge = new McpAppHostBridge(
    null,
    { name: 'Desktop MCP Apps Host', version: '1.0.0' },
    {
      openLinks: {},
      downloadFile: {},
      sandbox: { csp: payload.csp ?? {} },
      ...(interactive || session.canReadHistoricalTool ? { serverTools: {} } : {}),
      ...(interactive ? { serverResources: {} } : {}),
      ...(interactive
        ? {
            message: {
              text: {},
              ...(payload.richModelContextSupported
                ? { image: {}, resource: {}, resourceLink: {} }
                : {}),
            },
          }
        : {}),
      ...(payload.updateModelContextSupported
        ? {
            updateModelContext: {
              text: {},
              ...(payload.richModelContextSupported
                ? {
                    image: {},
                    resource: {},
                    resourceLink: {},
                    structuredContent: {},
                  }
                : {}),
            },
          }
        : {}),
      experimental: {
        ...(payload.richModelContextSupported ? { 'openai/modelContext': {} } : {}),
        ...(interactive ? { 'openai/message': {} } : {}),
        ...(payload.fileResourcesSupported || payload.workspaceFile
          ? { 'openai/resource': {} }
          : {}),
        ...(payload.openFilesSupported ? { 'openai/files': {} } : {}),
      },
    },
    { hostContext: host.hostContext() },
  );

  bridge.oncalltool = async (params, extra) => {
    if (disposed) throw new Error('MCP App bridge is closed');
    if (session.canReadHistoricalTool) {
      if (!(host.canRead?.() ?? host.canInteract())) throw new Error('MCP App is unavailable');
      return result(
        specTypeSchemas.CallToolResult,
        await session.readHistoricalTool(params.name, params.arguments, extra.mcpReq.signal),
      );
    }
    return result(
      specTypeSchemas.CallToolResult,
      await request(
        McpAppMethod.CallTool,
        { toolName: params.name, arguments: params.arguments },
        extra.mcpReq.signal,
      ),
    );
  };
  bridge.setTools(async (params, extra) =>
    result(
      specTypeSchemas.ListToolsResult,
      await request(
        McpAppMethod.ListTools,
        params?.cursor !== undefined ? { cursor: params.cursor } : {},
        extra.mcpReq.signal,
      ),
    ),
  );
  bridge.onlistresources = async (params, extra) =>
    result(
      specTypeSchemas.ListResourcesResult,
      await request(
        McpAppMethod.ListResources,
        params?.cursor !== undefined ? { cursor: params.cursor } : {},
        extra.mcpReq.signal,
      ),
    );
  bridge.onlistresourcetemplates = async (params, extra) =>
    result(
      specTypeSchemas.ListResourceTemplatesResult,
      await request(
        McpAppMethod.ListResourceTemplates,
        params?.cursor !== undefined ? { cursor: params.cursor } : {},
        extra.mcpReq.signal,
      ),
    );
  bridge.onreadresource = async (params, extra) =>
    result(
      specTypeSchemas.ReadResourceResult,
      await (payload.workspaceFile?.uri === params.uri
        ? fileRequest('read', { uri: params.uri }, extra.mcpReq.signal)
        : request(
            McpAppMethod.ReadResource,
            {
              uri: params.uri,
              _meta: extra.mcpReq._meta ?? params._meta,
            },
            extra.mcpReq.signal,
          )),
    );

  const refreshContext = async (clearedUpdateId?: string) => {
    if (clearedUpdateId && context?.updateId !== clearedUpdateId) return;
    const current = ++revision;
    const next = clearedUpdateId
      ? null
      : (await session.request<{ state: McpAppModelContext | null }>(McpAppMethod.ModelContext))
          .state;
    if (disposed || current !== revision || !session.isCurrent()) return;
    context = next;
    bridge.setHostContext({ ...host.hostContext(), 'openai/modelContext': context });
    host.contextChanged(context);
  };
  if (interactive)
    bridge.setMessages(async (params, extra) => {
      const meta = mcpAppRecord(extra.mcpReq._meta);
      const message = mcpAppRecord(meta?.['openai/message']);
      if (
        params.role !== 'user' ||
        !params.content.length ||
        (!payload.richModelContextSupported &&
          params.content.some(block => block.type !== 'text')) ||
        !host.canInteract() ||
        (message?.target !== undefined &&
          message.target !== 'active' &&
          message.target !== 'new') ||
        JSON.stringify(params.content).length > 8 * 1024 * 1024
      )
        return { isError: true };
      return (await host.confirmDraft(params.content, message?.target === 'new' ? 'new' : 'active'))
        ? {}
        : { isError: true };
    });
  if (payload.updateModelContextSupported)
    bridge.setContextUpdates(async (params, extra) => {
      const response = recordSchema.parse(
        await request(McpAppMethod.UpdateModelContext, { ...params }, extra.mcpReq.signal),
      );
      await refreshContext();
      return response;
    });
  if (payload.fileResourcesSupported || payload.workspaceFile) {
    bridge.setExtension('openai/resources/write', async (params, extra) =>
      recordSchema.parse(
        await (payload.workspaceFile?.uri === params.uri
          ? fileRequest('write', params, extra.mcpReq.signal)
          : request(McpAppMethod.WriteResource, params, extra.mcpReq.signal)),
      ),
    );
  }
  if (payload.fileResourcesSupported) {
    bridge.setExtension('resources/subscribe', async (params, extra) => {
      const response = recordSchema.parse(
        await request(McpAppMethod.SubscribeResource, params, extra.mcpReq.signal),
      );
      if (typeof params.uri === 'string') subscriptions.add(params.uri);
      return response;
    });
    bridge.setExtension('resources/unsubscribe', async (params, extra) => {
      const response = recordSchema.parse(
        await request(McpAppMethod.UnsubscribeResource, params, extra.mcpReq.signal),
      );
      if (typeof params.uri === 'string') subscriptions.delete(params.uri);
      return response;
    });
  }
  if (payload.openFilesSupported)
    bridge.setExtension('openai/files/open', async (params, extra) => {
      const path = typeof params.path === 'string' ? params.path.trim() : '';
      if (!path || !host.canInteract() || !(await host.confirmFile(path)) || !host.canInteract())
        return { isError: true };
      const file = recordSchema.parse(
        await request(McpAppMethod.OpenFile, { ...params, path }, extra.mcpReq.signal),
      );
      if (
        disposed ||
        !host.canInteract() ||
        extra.mcpReq.signal.aborted ||
        typeof file.path !== 'string' ||
        typeof file.name !== 'string' ||
        !session.isCurrent()
      )
        return { isError: true };
      // Native returns a workspace-relative display path. The original absolute
      // path has just been authorized by Gateway and is unambiguous to desktop IPC.
      return (await host.openFile({ path, name: file.name })) ? {} : { isError: true };
    });
  bridge.onrequestteardown = () => {
    if (!disposed && (host.canRead?.() ?? host.canInteract())) host.close();
  };
  const stop = session.subscribe(event => {
    if (disposed) return;
    const value = mcpAppRecord(event.payload);
    if (event.event === McpAppEvent.HostContextChanged) {
      void refreshContext(
        value?.modelContext === null && typeof value.updateId === 'string'
          ? value.updateId
          : undefined,
      ).catch(() => undefined);
    }
    if (
      event.event === McpAppEvent.ResourceUpdated &&
      typeof value?.uri === 'string' &&
      subscriptions.has(value.uri)
    ) {
      void bridge
        .notification({
          method: 'notifications/resources/updated',
          params: { uri: value.uri },
        })
        .catch(() => undefined);
    }
  });
  return {
    bridge,
    refreshContext,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      for (const uri of subscriptions)
        void session.request(McpAppMethod.UnsubscribeResource, { uri }).catch(() => undefined);
      subscriptions.clear();
      void bridge.close();
    },
  };
}
