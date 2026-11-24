import type { McpAppAdapter, McpAppAdapterReceipt } from '@app-plugin/sdk/mcp-app';

export const EDITOR_ADMIT = 'fixture.editor.admit';
export const EDITOR_REFRESH = 'fixture.editor.refresh';
export const EDITOR_OPERATION = 'fixture.editor.run';
export const EDITOR_RESTORE = 'fixture.editor.restore';
export const EDITOR_SEND = 'fixture.editor.send';
export const EDITOR_SEND_NOT_ISSUED = 'FIXTURE_EDITOR_SEND_NOT_ISSUED';

export const editorSource = {
  serverName: 'fixture-editor',
  toolName: 'open_editor',
  uiResourceUri: 'ui://fixture/editor',
};

export const editorAdapter: McpAppAdapter = {
  ...editorSource,
  namespace: 'fixture/editor',
  entryTools: [editorSource.toolName],
  referenceTool: 'edit_document',
  viewMethods: [EDITOR_ADMIT, EDITOR_REFRESH, EDITOR_OPERATION],
  restoreMethod: EDITOR_RESTORE,
  sendMethod: EDITOR_SEND,
  sendNotIssuedCode: EDITOR_SEND_NOT_ISSUED,
  content(result) {
    const data = (result as { structuredContent?: { id?: unknown } } | undefined)
      ?.structuredContent;
    return typeof data?.id === 'string' ? { id: data.id } : undefined;
  },
  readReference(result) {
    return result as McpAppAdapterReceipt;
  },
  sendParams(send, canvases) {
    return { send, canvases };
  },
  restoreReferenceParams(contentId, operationId) {
    return { contentId, operationId };
  },
  async prepareView({ source, payload, request, releaseOnClose }) {
    const document = editorAdapter.content(payload.toolResult);
    if (!document) return payload;
    releaseOnClose(EDITOR_ADMIT, { release: true });
    const result = await request<{ admitted: boolean }>(EDITOR_ADMIT, {
      source,
      contentId: document.id,
    });
    if (!result.admitted) throw new Error('Missing admission');
    const refreshed = await request<Partial<typeof payload>>(EDITOR_REFRESH, {});
    return { ...payload, ...refreshed };
  },
  connect() {
    return () => undefined;
  },
};
