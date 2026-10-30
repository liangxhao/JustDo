import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { SessionMcpRuntime } from 'openclaw/plugin-sdk/agent-harness-runtime';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';

import {
  type DiagramSource,
  DRAWIO_CURRENT_METHOD,
  DRAWIO_RESOURCE,
  DRAWIO_RESTORE_METHOD,
  DRAWIO_SERVER,
  DRAWIO_TOOL,
} from './contracts';
import { getDiagramEditingState, readAdmittedDiagramSource } from './editing';
import { selectDiagramResult } from './restore-result';
import { selectConfirmedDiagramUpdate } from './update-result';

type Resource = { read: () => Promise<unknown>; close: () => void };
type ResourceModule = {
  createEditorResource: (directory: string) => Promise<Resource>;
  validateDiagram: (value: unknown) => { xml: string; title: string };
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export function registerDiagramRecovery(api: OpenClawPluginApi) {
  let resource: Promise<Resource> | undefined;
  let serviceEpoch = 0;
  let active = false;
  const directory = path.join(path.dirname(api.source), 'assets');
  const load = () =>
    createRequire(api.source)(path.join(directory, 'editor-resource.cjs')) as ResourceModule;
  const editorResource = () => {
    if (!resource) {
      const pending = load().createEditorResource(directory).catch(error => {
        if (resource === pending) resource = undefined;
        throw error;
      });
      resource = pending;
    }
    return resource;
  };
  const resourceRuntime = (
    sessionId: string,
    sessionKey: string,
    assertCurrent: () => void,
    editor: Resource,
  ): SessionMcpRuntime => {
    const catalog = { version: 1, generatedAt: Date.now(), servers: {}, tools: [] };
    return {
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
        throw new Error('Diagram editor resources cannot call tools');
      },
      readResource: async (server, uri) => {
        assertCurrent();
        if (server !== DRAWIO_SERVER || uri !== DRAWIO_RESOURCE)
          throw new Error('Unknown resource');
        return editor.read();
      },
    };
  };
  api.registerService({
    id: 'drawio-recovery-assets',
    start() {
      active = true;
      serviceEpoch++;
    },
    async stop() {
      active = false;
      serviceEpoch++;
      const previous = resource;
      resource = undefined;
      (await previous?.catch(() => undefined))?.close();
    },
  });
  for (const method of [DRAWIO_RESTORE_METHOD, DRAWIO_CURRENT_METHOD])
    api.registerGatewayMethod(
      method,
      async ({ params, respond, client, hasCurrentClientAuthority }) => {
        try {
          const epoch = serviceEpoch;
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
          if (
            !history.ok ||
            identity?.sessionId !== sessionId ||
            identity.sessionKey !== sessionKey
          )
            throw new Error('Diagram session unavailable');
          const initial = getSessionEntry({ sessionKey, agentId, readConsistency: 'latest' });
          if (initial?.sessionId !== sessionId) throw new Error('Diagram session changed');
          const lifecycleRevision = initial.lifecycleRevision;
          const assertCurrent = () => {
            const cfg = api.runtime.config.current();
            const entry = getSessionEntry({ sessionKey, agentId, readConsistency: 'latest' });
            if (
              !active || serviceEpoch !== epoch ||
              client?.connectionSignal?.aborted ||
              hasCurrentClientAuthority?.() === false ||
              cfg.mcp?.apps?.enabled !== true ||
              cfg.plugins?.enabled === false ||
              cfg.plugins?.entries?.drawio?.enabled === false ||
              entry?.sessionId !== sessionId || entry.lifecycleRevision !== lifecycleRevision
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
          const messages = entries.map(entry => entry.message);
          const editing = getDiagramEditingState();
          const recoveredSource = editing.recovered.get(viewId)?.source;
          const originalViewId = recoveredSource?.originViewId ?? viewId;
          const confirmed = selectConfirmedDiagramUpdate(messages, {
            viewId: originalViewId,
            sessionKey,
            sessionId,
            agentId,
            ...(typeof params.diagramId === 'string' ? { diagramId: params.diagramId } : {}),
          });
          if (method === DRAWIO_CURRENT_METHOD) {
            let editorPayload: Record<string, unknown> | undefined;
            if (params.editorResource === true) {
              if (typeof params.diagramId !== 'string' || !client?.connId)
                throw new Error('Diagram source is required');
              const owner = { connectionId: client.connId, sessionKey, sessionId, agentId, viewId };
              const assertSourceCurrent = () => {
                assertCurrent();
                readAdmittedDiagramSource(owner, params.diagramId as string);
              };
              assertSourceCurrent();
              const editor = await editorResource();
              assertSourceCurrent();
              const { prepareHarnessNativeMcpAppPreview } =
                await import('openclaw/plugin-sdk/agent-harness-runtime');
              assertSourceCurrent();
              const preview = await prepareHarnessNativeMcpAppPreview({
                runtime: resourceRuntime(sessionId, sessionKey, assertSourceCurrent, editor),
                agentId,
                serverName: DRAWIO_SERVER,
                toolName: DRAWIO_TOOL,
                uiResourceUri: DRAWIO_RESOURCE,
                toolCallId: `${viewId}-editor-resource`,
                toolInput: {},
                toolResult: { content: [] },
                allowedAppToolNames: new Set(),
              });
              assertSourceCurrent();
              const resourceViewId = record(record(preview?.mcpAppPreview).mcpApp).viewId;
              if (typeof resourceViewId !== 'string') throw new Error('Diagram UI unavailable');
              const result = await dispatchGatewayMethod('mcp.app.view', {
                sessionKey, agentId, viewId: resourceViewId,
              });
              assertSourceCurrent();
              if (!result.ok) throw new Error('Diagram UI unavailable');
              const payload = record(result.payload);
              if (typeof payload.html !== 'string' || typeof payload.sandboxUrl !== 'string' ||
                !Number.isInteger(payload.sandboxPort))
                throw new Error('Diagram UI unavailable');
              // Only the native-generated immutable editor shell and its matching
              // sandbox/CSP are substituted. The admitted diagram and all host
              // capabilities remain those of the original view.
              editorPayload = {
                html: payload.html,
                csp: payload.csp,
                sandboxUrl: payload.sandboxUrl,
                sandboxPort: payload.sandboxPort,
                ...(payload.sandboxOrigin ? { sandboxOrigin: payload.sandboxOrigin } : {}),
              };
            }
            respond(true, {
              diagram: confirmed
                ? { xml: confirmed.xml, title: confirmed.title, diagramId: confirmed.diagramId }
                : null,
              readOnly: Boolean(recoveredSource),
              ...(editorPayload ? { editorResource: editorPayload } : {}),
            });
            return;
          }
          const selected = confirmed
            ? {
                toolCallId: confirmed.toolCallId,
                diagram: {
                  xml: confirmed.xml,
                  title: confirmed.title,
                  diagramId: confirmed.diagramId,
                },
              }
            : selectDiagramResult(messages, originalViewId, sessionKey);
          if (!selected) throw new Error('Original diagram result unavailable');
          if (
            typeof params.diagramId === 'string' &&
            (!confirmed || params.diagramId !== confirmed.diagramId)
          )
            throw new Error('Diagram reference unavailable');
          const module = load();
          const validated = module.validateDiagram(selected.diagram);
          const diagramId =
            confirmed?.diagramId ??
            (typeof selected.diagram.diagramId === 'string'
              ? selected.diagram.diagramId
              : `diagram-${createHash('sha256').update(`${sessionId}/${originalViewId}`).digest('hex').slice(0, 32)}`);
          const diagram = { ...validated, diagramId };
          const source: DiagramSource = confirmed?.source ?? {
            kind: 'native-history-recovery',
            diagramId,
            serverName: DRAWIO_SERVER,
            toolName: DRAWIO_TOOL,
            uiResourceUri: DRAWIO_RESOURCE,
            originViewId: originalViewId,
            sessionKey,
            sessionId,
            agentId,
          };
          const editor = await editorResource();
          assertCurrent();
          // This plugin-owned adapter serves its own immutable UI only. It never
          // reconnects MCP, executes create_diagram, or reinstates old tool grants.
          const runtime = resourceRuntime(sessionId, sessionKey, assertCurrent, editor);
          const { prepareHarnessNativeMcpAppPreview } =
            await import('openclaw/plugin-sdk/agent-harness-runtime');
          assertCurrent();
          const preview = await prepareHarnessNativeMcpAppPreview({
            runtime,
            agentId,
            serverName: DRAWIO_SERVER,
            toolName: source.toolName,
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
          editing.recovered.set(newViewId, { source, diagramId });
          if (editing.recovered.size > 128)
            editing.recovered.delete(editing.recovered.keys().next().value!);
          // The public preview helper can grant an empty tool set but has no
          // readOnly lease flag. Context is revoked in the runtime; additionally
          // restrict the desktop UI's message/file capabilities for this snapshot.
          const payload = {
            ...(result.payload as Record<string, unknown>),
            messageSupported: false,
            updateModelContextSupported: false,
            richModelContextSupported: false,
            fileResourcesSupported: false,
            openFilesSupported: false,
          };
          respond(true, { viewId: newViewId, payload, preview: preview!.mcpAppPreview });
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
