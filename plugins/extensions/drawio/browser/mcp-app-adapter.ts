import type { McpAppAdapter, McpAppAdapterPayload } from '@app-plugin/sdk/mcp-app';

import {
  DRAWIO_CANVAS_METHOD,
  DRAWIO_CURRENT_METHOD,
  DRAWIO_EDIT_TOOL,
  DRAWIO_ENTRY_TOOLS,
  DRAWIO_OPEN_EDITOR_TOOL,
  DRAWIO_RESOURCE,
  DRAWIO_RESTORE_METHOD,
  DRAWIO_SEND_METHOD,
  DRAWIO_SEND_NOT_ISSUED,
  DRAWIO_SERVER,
} from '../contracts';
import { readDiagramReference } from '../update-result';
import { connectCurrentDiagram } from './current-canvas';

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function content(toolResult: unknown) {
  const diagram = record(record(toolResult)?.structuredContent);
  if (typeof diagram?.diagramId !== 'string') return;
  return {
    id: diagram.diagramId,
    title: typeof diagram.title === 'string' ? diagram.title.slice(0, 160) : undefined,
  };
}

export const mcpAppAdapter: McpAppAdapter = {
  namespace: 'drawio/editor',
  serverName: DRAWIO_SERVER,
  uiResourceUri: DRAWIO_RESOURCE,
  entryTools: DRAWIO_ENTRY_TOOLS,
  referenceTool: DRAWIO_EDIT_TOOL,
  viewMethods: [DRAWIO_CANVAS_METHOD, DRAWIO_CURRENT_METHOD],
  restoreMethod: DRAWIO_RESTORE_METHOD,
  sendMethod: DRAWIO_SEND_METHOD,
  sendNotIssuedCode: DRAWIO_SEND_NOT_ISSUED,
  ownsReadOnlyNotice: true,
  blankLaunch: { pluginId: DRAWIO_SERVER, toolName: DRAWIO_OPEN_EDITOR_TOOL },
  content,
  readReference(result, toolCallId) {
    const receipt = readDiagramReference(result, toolCallId);
    if (!receipt) return;
    return {
      contentId: receipt.diagramId,
      title: receipt.title,
      originViewId: receipt.source.originViewId,
      sessionKey: receipt.source.sessionKey,
      sessionId: receipt.source.sessionId,
      agentId: receipt.source.agentId,
      operationId: receipt.operationId,
      toolCallId: receipt.toolCallId,
      runId: receipt.runId,
    };
  },
  sendParams(send, canvases) {
    return { send, canvases };
  },
  restoreReferenceParams(diagramId, operationId) {
    return { diagramId, operationId };
  },
  async prepareView({ source, payload, request, releaseOnClose }) {
    const diagramId = content(payload.toolResult)?.id;
    if (diagramId === undefined) return payload;
    if (payload.messageSupported === true) {
      // Closing this view also releases an admission whose response never arrived.
      releaseOnClose(DRAWIO_CANVAS_METHOD, { action: 'detach', token: '', forgetSource: true });
      const admitted = await request<{ admitted: boolean }>(DRAWIO_CANVAS_METHOD, {
        action: 'admit',
        diagramId,
        source,
      });
      if (admitted?.admitted !== true) throw new Error('Diagram source admission failed');
    }
    const current = await request<{
      diagram: Record<string, unknown> | null;
      readOnly?: boolean;
      editorResource?: Pick<
        McpAppAdapterPayload,
        'html' | 'csp' | 'sandboxUrl' | 'sandboxPort' | 'sandboxOrigin'
      >;
    }>(
      DRAWIO_CURRENT_METHOD,
      payload.messageSupported === true ? { editorResource: true, diagramId } : {},
    );
    let prepared = payload;
    if (payload.messageSupported === true) {
      const editor = current.editorResource;
      if (
        typeof editor?.html !== 'string' ||
        typeof editor.sandboxUrl !== 'string' ||
        typeof editor.sandboxPort !== 'number'
      )
        throw new Error('Diagram editor resource unavailable');
      prepared = {
        ...prepared,
        html: editor.html,
        csp: editor.csp,
        sandboxUrl: editor.sandboxUrl,
        sandboxPort: editor.sandboxPort,
        sandboxOrigin: editor.sandboxOrigin,
        // Current-canvas preparation uses separate authenticated RPCs.
        updateModelContextSupported: false,
        richModelContextSupported: false,
      };
    }
    if (current?.diagram)
      prepared = { ...prepared, toolResult: { content: [], structuredContent: current.diagram } };
    if (current?.readOnly)
      prepared = {
        ...prepared,
        messageSupported: false,
        updateModelContextSupported: false,
        richModelContextSupported: false,
        fileResourcesSupported: false,
        openFilesSupported: false,
      };
    return prepared;
  },
  connect(host) {
    return connectCurrentDiagram({
      source: host.source,
      diagramId: host.contentId,
      bridge: host.bridge,
      viewId: host.viewId,
      current: host.current,
      canPrepare: host.canPrepare,
      priority: host.priority,
      request: (params, signal) =>
        (params.action === 'next' || params.action === 'ack' ? host.retainedRequest : host.request)(
          DRAWIO_CANVAS_METHOD,
          params,
          signal,
        ),
      release: token => host.release(DRAWIO_CANVAS_METHOD, { action: 'detach', token }),
      subscribe: host.subscribe,
      onSuspend: host.onSuspend,
      register: host.registerPreparation,
    });
  },
};
