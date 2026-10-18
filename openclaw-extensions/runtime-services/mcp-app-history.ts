import { randomUUID } from 'node:crypto';

import { resolveAgentDir } from 'openclaw/plugin-sdk/agent-scope-runtime';
import {
  getPluginToolMeta,
  prepareHarnessNativeMcpAppPreview,
  type SessionMcpRuntime,
} from 'openclaw/plugin-sdk/agent-harness-runtime';
import { materializeStaticMcpToolsForHarnessRun } from 'openclaw/plugin-sdk/codex-mcp-projection';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';

import { MCP_APP_HISTORY_TOOL_METHOD, MCP_APP_HISTORY_VIEW_METHOD } from './contracts/mcp-apps';
import { matchesMcpAppHistoryInput } from './mcp-app-history-input';
import { selectMcpAppHistoryResult } from './mcp-app-history-result';

export function registerMcpAppHistory(api: OpenClawPluginApi) {
  for (const method of [MCP_APP_HISTORY_VIEW_METHOD, MCP_APP_HISTORY_TOOL_METHOD])
    api.registerGatewayMethod(
      method,
      async ({ params, respond, client, signal, hasCurrentClientAuthority }) => {
        let tools: Awaited<ReturnType<typeof materializeStaticMcpToolsForHarnessRun>> | undefined;
        try {
          const { sessionKey, sessionId, agentId, viewId } = params;
          if (
            typeof sessionKey !== 'string' ||
            sessionKey.length > 512 ||
            typeof sessionId !== 'string' ||
            !sessionId ||
            typeof agentId !== 'string' ||
            !/^[a-z0-9_-]{1,64}$/i.test(agentId) ||
            !sessionKey.startsWith(`agent:${agentId}:`) ||
            typeof viewId !== 'string' ||
            !/^mcp-app-[a-z0-9-]{1,100}$/i.test(viewId)
          )
            throw new Error('Invalid App history identity');
          if (
            method === MCP_APP_HISTORY_TOOL_METHOD &&
            (typeof params.toolName !== 'string' ||
              params.toolName.length > 256 ||
              (params.arguments !== undefined &&
                (params.arguments === null ||
                  typeof params.arguments !== 'object' ||
                  Array.isArray(params.arguments))) ||
              JSON.stringify(params.arguments ?? {}).length > 65536)
          )
            throw new Error('Invalid historical App tool input');
          const initial = getSessionEntry({ sessionKey, agentId, readConsistency: 'latest' });
          const policyFingerprint = () => {
            const cfg = api.runtime.config.current();
            return JSON.stringify([
              cfg.mcp,
              cfg.tools,
              cfg.agents,
              cfg.plugins,
              cfg.gateway?.roles,
            ]);
          };
          const initialPolicy = policyFingerprint();
          const assertCurrent = () => {
            const cfg = api.runtime.config.current();
            const entry = getSessionEntry({ sessionKey, agentId, readConsistency: 'latest' });
            if (
              signal?.aborted ||
              client?.connectionSignal?.aborted ||
              hasCurrentClientAuthority?.() === false ||
              cfg.mcp?.apps?.enabled !== true ||
              cfg.plugins?.enabled === false ||
              cfg.plugins?.entries?.['runtime-services']?.enabled === false ||
              initial?.sessionId !== sessionId ||
              entry?.sessionId !== sessionId ||
              initial.lifecycleRevision !== entry.lifecycleRevision ||
              initial.spawnedCwd !== entry.spawnedCwd ||
              initial.sessionRoot !== entry.sessionRoot ||
              initial.permissionMode !== entry.permissionMode ||
              initial.sandboxMode !== entry.sandboxMode ||
              policyFingerprint() !== initialPolicy ||
              JSON.stringify(initial.toolOverrides) !== JSON.stringify(entry.toolOverrides)
            )
              throw new Error('App history session changed');
          };
          const dispatch = async (method: string, input: Record<string, unknown>) => {
            assertCurrent();
            const result = await dispatchGatewayMethod(method, input);
            assertCurrent();
            if (!result.ok) throw new Error('App history access unavailable');
            return result.payload as Record<string, unknown>;
          };
          const identity = await dispatch('sessions.describe', { key: sessionKey, agentId });
          if ((identity.session as { sessionId?: string } | null)?.sessionId !== sessionId)
            throw new Error('App history session unavailable');
          const entries = await readVisibleSessionTranscriptMessageEntries({
            sessionKey,
            sessionId,
            agentId,
          });
          assertCurrent();
          const original = selectMcpAppHistoryResult(
            entries.map(entry => entry.message),
            viewId,
            sessionKey,
          );
          if (!original) throw new Error('Original App result unavailable');
          const cfg = structuredClone(api.runtime.config.current()) as OpenClawConfig;
          const files = await dispatch('sessions.files.list', { sessionKey, agentId, path: '.' });
          if (typeof files.root !== 'string' || initial?.execNode || initial?.repositoryWorkspaceId)
            throw new Error('App workspace unavailable');
          // Public SDK borrows the native MCP manager and applies current tool policy.
          // Only its resources_read operation is used; business tools are never called.
          tools = await materializeStaticMcpToolsForHarnessRun({
            sessionKey,
            sessionId,
            agentId,
            cfg,
            workspaceDir: files.root,
            agentDir: resolveAgentDir(cfg, agentId),
            toolOverrides: initial.toolOverrides,
            ...(method === MCP_APP_HISTORY_TOOL_METHOD
              ? {
                  // Retain policy-visible schemas without granting approval or ever
                  // executing their tool wrappers. An accidental execution fails shut.
                  requestInteractiveCodexApproval: async () => {
                    throw new Error('Historical Apps cannot execute tools');
                  },
                }
              : {}),
            policyContext: {
              config: cfg,
              sessionKey,
              sessionId,
              agentId,
              workspaceDir: files.root,
              preparedSessionEntry: initial,
              modelProvider: initial.modelProvider,
              modelId: initial.model,
            },
          });
          assertCurrent();
          const reader = tools.tools.find(tool => {
            const mcp = getPluginToolMeta(tool)?.mcp;
            return mcp?.serverName === original.serverName && mcp.operation === 'resources_read';
          });
          if (!reader) throw new Error('App resource reading is not allowed');
          if (method === MCP_APP_HISTORY_TOOL_METHOD) {
            const originalTool = tools.tools.find(tool => {
              const mcp = getPluginToolMeta(tool)?.mcp;
              return (
                mcp?.serverName === original.serverName &&
                mcp.toolName === original.toolName &&
                mcp.operation === 'tool'
              );
            });
            if (
              params.toolName !== original.toolName ||
              !originalTool ||
              !matchesMcpAppHistoryInput(
                original.toolInput,
                params.arguments ?? {},
                originalTool.parameters,
              )
            )
              throw new Error('Only the original App result can be read');
            const borrowed = tools;
            tools = undefined;
            await borrowed.dispose();
            assertCurrent();
            respond(true, original.toolResult);
            return;
          }
          const resource = await reader.execute(
            `app-history-${randomUUID()}`,
            { uri: original.uiResourceUri },
            signal,
          );
          assertCurrent();
          const text = resource.content.find(item => item.type === 'text');
          if (!text || text.type !== 'text' || text.text.length > 4 * 1024 * 1024)
            throw new Error('App resource unavailable');
          const htmlResource: unknown = JSON.parse(text.text);
          const catalog = { version: 1, generatedAt: Date.now(), servers: {}, tools: [] };
          const denied = async (): Promise<never> => {
            throw new Error('Historical Apps cannot execute operations');
          };
          const runtime: SessionMcpRuntime = {
            sessionKey,
            sessionId,
            workspaceDir: files.root,
            configFingerprint: 'mcp-app-history',
            mcpAppsEnabled: true,
            mcpAppModelContextRevoked: true,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            assertOwnerCurrent: assertCurrent,
            getCatalog: async () => catalog,
            peekCatalog: () => catalog,
            markUsed: assertCurrent,
            callTool: denied,
            dispose: async () => {},
            canReadLocalFiles: () => false,
            readResource: async (server, uri) => {
              assertCurrent();
              if (server !== original.serverName || uri !== original.uiResourceUri) return denied();
              return htmlResource;
            },
          };
          const prepared = await prepareHarnessNativeMcpAppPreview({
            runtime,
            agentId,
            ...original,
            toolResult: original.toolResult as Parameters<
              typeof prepareHarnessNativeMcpAppPreview
            >[0]['toolResult'],
            allowedAppToolNames: new Set(),
          });
          const descriptor = (prepared?.mcpAppPreview as { mcpApp?: { viewId?: string } })?.mcpApp;
          if (!descriptor?.viewId) throw new Error('App history preview unavailable');
          const payload = await dispatch('mcp.app.view', {
            sessionKey,
            agentId,
            viewId: descriptor.viewId,
          });
          const borrowed = tools;
          tools = undefined;
          await borrowed.dispose();
          assertCurrent();
          respond(true, {
            viewId: descriptor.viewId,
            payload: {
              ...payload,
              messageSupported: false,
              updateModelContextSupported: false,
              fileResourcesSupported: false,
              openFilesSupported: false,
            },
          });
        } catch {
          respond(false, undefined, {
            code: 'UNAVAILABLE',
            message: 'Original App view could not be restored.',
          });
        } finally {
          if (tools)
            await tools
              .dispose()
              .catch(() =>
                api.logger.warn(
                  '[RuntimeServices] App history resource cleanup was not confirmed.',
                ),
              );
        }
      },
      { scope: 'operator.admin' },
    );
}
