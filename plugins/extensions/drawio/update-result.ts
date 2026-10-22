import {
  type DiagramUpdateReceipt,
  DRAWIO_EDIT_TOOL,
  DRAWIO_ENTRY_TOOLS,
  DRAWIO_RESOURCE,
  DRAWIO_SERVER,
  DRAWIO_UPDATE_KIND,
} from './contracts';

export const DRAWIO_REFERENCE_KIND = 'drawio.diagram-reference.v1';

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max;
type ReferenceFields = Pick<
  DiagramUpdateReceipt,
  'status' | 'diagramId' | 'title' | 'operationId' | 'toolCallId' | 'runId' | 'source'
>;
function validReference(receipt: Record<string, unknown>, toolCallId: string): boolean {
  const source = object(receipt.source);
  return (
    receipt.status === 'applied' &&
    receipt.toolCallId === toolCallId &&
    text(receipt.runId, 256) &&
    text(receipt.operationId, 128) &&
    typeof receipt.title === 'string' &&
    receipt.title.length <= 160 &&
    /^diagram-[a-zA-Z0-9-]{1,100}$/.test(String(receipt.diagramId)) &&
    source.diagramId === receipt.diagramId &&
    ['desktop-native-admission', 'native-history-recovery'].includes(String(source.kind)) &&
    source.serverName === DRAWIO_SERVER &&
    source.uiResourceUri === DRAWIO_RESOURCE &&
    DRAWIO_ENTRY_TOOLS.includes(source.toolName as never) &&
    text(source.sessionKey) &&
    text(source.sessionId) &&
    text(source.agentId, 128) &&
    String(source.sessionKey).startsWith(`agent:${source.agentId}:`) &&
    /^mcp-app-[A-Za-z0-9-]{1,100}$/.test(String(source.originViewId))
  );
}
function failed(result: Record<string, unknown>) {
  const details = object(result.details);
  return (
    result.isError === true ||
    result.ok === false ||
    ['error', 'failed'].includes(String(result.status)) ||
    ['error', 'failed'].includes(String(details.status))
  );
}
/** Only call with a real native tool result; no assistant-nested or prose admission. */
export function readDiagramUpdate(
  value: unknown,
  toolName: string | undefined,
  toolCallId: string | undefined,
): DiagramUpdateReceipt | undefined {
  if (toolName !== DRAWIO_EDIT_TOOL || !toolCallId) return;
  const result = object(value);
  const receipt = object(object(result.details).diagramUpdate);
  if (
    failed(result) ||
    receipt.kind !== DRAWIO_UPDATE_KIND ||
    !validReference(receipt, toolCallId) ||
    !text(receipt.contentStamp, 128) ||
    !text(receipt.baseContentStamp, 128) ||
    !text(receipt.xml, 1024 * 1024)
  )
    return;
  return receipt as unknown as DiagramUpdateReceipt;
}

/** Compact, history-visible index. Full XML stays in the native result receipt. */
export function diagramUpdateReference(receipt: ReferenceFields) {
  return {
    kind: DRAWIO_REFERENCE_KIND,
    status: receipt.status,
    diagramId: receipt.diagramId,
    title: receipt.title,
    operationId: receipt.operationId,
    toolCallId: receipt.toolCallId,
    runId: receipt.runId,
    source: receipt.source,
  };
}

/** Call only for a native result of this exact plugin tool and invocation. */
export function readDiagramReference(value: unknown, toolName?: string, toolCallId?: string) {
  if (toolName !== DRAWIO_EDIT_TOOL || !toolCallId) return;
  const result = object(value);
  if (failed(result)) return;
  const full = readDiagramUpdate(result, toolName, toolCallId);
  if (full) return diagramUpdateReference(full);
  const content = result.content;
  if (!Array.isArray(content) || content.length !== 1) return;
  const block = object(content[0]);
  if (block.type !== 'text' || !text(block.text, 4096)) return;
  let compact: Record<string, unknown>;
  try {
    compact = object(JSON.parse(block.text as string));
  } catch {
    return;
  }
  if (compact.kind !== DRAWIO_REFERENCE_KIND) return;
  if (!validReference(compact, toolCallId)) return;
  return diagramUpdateReference(compact as unknown as ReferenceFields);
}

export function selectConfirmedDiagramUpdate(
  messages: unknown[],
  target: {
    viewId: string;
    sessionKey: string;
    sessionId: string;
    agentId: string;
    diagramId?: string;
  },
) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = object(messages[index]);
    if (
      !['tool', 'toolresult', 'tool_result', 'function'].includes(
        String(message.role).toLowerCase(),
      )
    )
      continue;
    const receipt = readDiagramUpdate(
      message,
      message.toolName as string,
      message.toolCallId as string,
    );
    if (
      !receipt ||
      receipt.source.originViewId !== target.viewId ||
      receipt.source.sessionKey !== target.sessionKey ||
      receipt.source.sessionId !== target.sessionId ||
      receipt.source.agentId !== target.agentId ||
      (target.diagramId && receipt.diagramId !== target.diagramId)
    )
      continue;
    return receipt;
  }
}
