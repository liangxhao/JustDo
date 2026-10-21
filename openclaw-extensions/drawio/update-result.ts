import {
  type DiagramUpdateReceipt,
  DRAWIO_EDIT_TOOL,
  DRAWIO_ENTRY_TOOLS,
  DRAWIO_RESOURCE,
  DRAWIO_SERVER,
  DRAWIO_UPDATE_KIND,
} from './contracts';

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** Only call with a real native tool result; no assistant-nested or prose admission. */
export function readDiagramUpdate(
  value: unknown,
  toolName: string | undefined,
  toolCallId: string | undefined,
): DiagramUpdateReceipt | undefined {
  if (toolName !== DRAWIO_EDIT_TOOL || !toolCallId) return;
  const result = object(value);
  const details = object(result.details);
  const receipt = object(details.diagramUpdate);
  const source = object(receipt.source);
  if (
    result.isError === true ||
    result.ok === false ||
    details.status === 'failed' ||
    details.status === 'error' ||
    receipt.kind !== DRAWIO_UPDATE_KIND ||
    receipt.status !== 'applied' ||
    receipt.toolCallId !== toolCallId ||
    !text(receipt.runId, 256) ||
    !text(receipt.operationId, 128) ||
    !text(receipt.contentStamp, 128) ||
    !text(receipt.baseContentStamp, 128) ||
    !text(receipt.xml, 1024 * 1024) ||
    typeof receipt.title !== 'string' ||
    receipt.title.length > 160 ||
    !/^diagram-[a-zA-Z0-9-]{1,100}$/.test(String(receipt.diagramId)) ||
    source.diagramId !== receipt.diagramId ||
    !['desktop-native-admission', 'native-history-recovery'].includes(String(source.kind)) ||
    source.serverName !== DRAWIO_SERVER ||
    source.uiResourceUri !== DRAWIO_RESOURCE ||
    !DRAWIO_ENTRY_TOOLS.includes(source.toolName as never) ||
    !text(source.sessionKey) ||
    !text(source.sessionId) ||
    !text(source.agentId, 128) ||
    !String(source.sessionKey).startsWith(`agent:${source.agentId}:`) ||
    !/^mcp-app-[A-Za-z0-9-]{1,100}$/.test(String(source.originViewId))
  )
    return;
  return receipt as unknown as DiagramUpdateReceipt;
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
