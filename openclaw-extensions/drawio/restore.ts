import { createRequire } from 'node:module';
import path from 'node:path';

import type { SessionMcpRuntime } from 'openclaw/plugin-sdk/agent-harness-runtime';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';

import { DRAWIO_RESOURCE, DRAWIO_RESTORE_METHOD, DRAWIO_SERVER, DRAWIO_TOOL } from './contracts';
import { selectDiagramResult } from './restore-result';

type Resource = { read: () => Promise<unknown>; close: () => void };
type ResourceModule = {
  createEditorResource: (directory: string) => Promise<Resource>;
  validateDiagram: (value: unknown) => { xml: string; title: string };
};

export function registerDiagramRecovery(api: OpenClawPluginApi) {
  let resource: Promise<Resource> | undefined;
  const directory = path.join(path.dirname(api.source), 'assets');
  const load = () =>
    createRequire(api.source)(path.join(directory, 'editor-resource.cjs')) as ResourceModule;
  api.registerService({
    id: 'drawio-recovery-assets',
    start() {},
    async stop() {
      (await resource?.catch(() => undefined))?.close();
      resource = undefined;
    },
  });
  api.registerGatewayMethod(
    DRAWIO_RESTORE_METHOD,
    async ({ params, respond, client }) => {
      try {
        const { sessionKey, sessionId, viewId, agentId } = params;
        if (
          typeof sessionKey !== 'string' ||
          typeof sessionId !== 'string' ||
          typeof agentId !== 'string' ||
          typeof viewId !== 'string' ||
          !/^mcp-app-[A-Za-z0-9-]{1,100}$/.test(viewId) ||
          !sessionKey.startsWith(`agent:${agentId}:`)
        )
          throw new Error('Invalid diagram identity');
        const history = await dispatchGatewayMethod('chat.history', { sessionKey, limit: 1 });
        const identity = history.payload as { sessionKey?: string; sessionId?: string };
        if (!history.ok || identity?.sessionId !== sessionId || identity.sessionKey !== sessionKey)
          throw new Error('Diagram session unavailable');
        const assertCurrent = () => {
          const cfg = api.runtime.config.current();
          if (
            client?.connectionSignal?.aborted ||
            cfg.mcp?.apps?.enabled !== true ||
            cfg.plugins?.enabled === false ||
            cfg.plugins?.entries?.drawio?.enabled === false ||
            getSessionEntry({ sessionKey, agentId, readConsistency: 'latest' })?.sessionId !==
              sessionId
          )
            throw new Error('Diagram session changed');
        };
        assertCurrent();
        const entries = await readVisibleSessionTranscriptMessageEntries({
          sessionKey,
          sessionId,
          agentId,
        });
        assertCurrent();
        const selected = selectDiagramResult(
          entries.map(entry => entry.message),
          viewId,
          sessionKey,
        );
        if (!selected) throw new Error('Original diagram result unavailable');
        const module = load();
        const diagram = module.validateDiagram(selected.diagram);
        resource ??= module.createEditorResource(directory).catch(error => {
          resource = undefined;
          throw error;
        });
        const editor = await resource;
        assertCurrent();
        const catalog = { version: 1, generatedAt: Date.now(), servers: {}, tools: [] };
        // This plugin-owned adapter serves its own immutable UI only. It never
        // reconnects MCP, executes create_diagram, or reinstates old tool grants.
        const runtime: SessionMcpRuntime = {
          sessionId,
          sessionKey,
          workspaceDir: '',
          configFingerprint: 'drawio-recovery',
          mcpAppsEnabled: true,
          mcpAppModelContextRevoked: true,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          assertOwnerCurrent: assertCurrent,
          getCatalog: async () => catalog,
          peekCatalog: () => catalog,
          markUsed: assertCurrent,
          dispose: async () => {},
          callTool: async () => {
            throw new Error('Recovered diagrams cannot call tools');
          },
          readResource: async (server, uri) => {
            assertCurrent();
            if (server !== DRAWIO_SERVER || uri !== DRAWIO_RESOURCE)
              throw new Error('Unknown resource');
            return editor.read();
          },
        };
        const { prepareHarnessNativeMcpAppPreview } =
          await import('openclaw/plugin-sdk/agent-harness-runtime');
        assertCurrent();
        const preview = await prepareHarnessNativeMcpAppPreview({
          runtime,
          agentId,
          serverName: DRAWIO_SERVER,
          toolName: DRAWIO_TOOL,
          uiResourceUri: DRAWIO_RESOURCE,
          toolCallId: selected.toolCallId,
          toolInput: diagram,
          toolResult: { content: [], structuredContent: diagram },
          allowedAppToolNames: new Set(),
        });
        const newViewId = (preview?.mcpAppPreview as { mcpApp?: { viewId?: string } })?.mcpApp
          ?.viewId;
        if (!newViewId) throw new Error('Diagram UI unavailable');
        const result = await dispatchGatewayMethod('mcp.app.view', {
          sessionKey,
          agentId,
          viewId: newViewId,
        });
        assertCurrent();
        if (!result.ok) throw new Error('Diagram UI unavailable');
        respond(true, { viewId: newViewId, payload: result.payload });
      } catch {
        respond(false, undefined, {
          code: 'UNAVAILABLE',
          message: 'Original diagram could not be restored.',
        });
      }
    },
    { scope: 'operator.admin' },
  );
}
