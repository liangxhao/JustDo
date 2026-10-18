import { DRAWIO_RESOURCE, DRAWIO_SERVER, DRAWIO_TOOL } from './contracts';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Accept only the exact native child result, never assistant text or a wrapper's prose. */
export function selectDiagramResult(messages: unknown[], viewId: string, sessionKey: string) {
  for (const value of messages.toReversed()) {
    const message = record(value);
    if (
      message?.role !== 'custom' ||
      message.customType !== 'openclaw.nested-tool.v1' ||
      message.display !== true ||
      message.excludeFromContext !== true
    )
      continue;
    const activity = record(message.details);
    const result = record(activity?.result);
    const details = record(result?.details);
    const descriptor = record(record(details?.mcpAppPreview)?.mcpApp);
    if (descriptor?.viewId !== viewId) continue;
    if (
      activity?.isError !== false ||
      typeof activity.runId !== 'string' ||
      !activity.runId.trim() ||
      typeof activity.toolCallId !== 'string' ||
      !activity.toolCallId.trim() ||
      activity.toolCallId.length > 512 ||
      typeof activity.parentToolCallId !== 'string' ||
      !activity.parentToolCallId ||
      activity.toolName !== `${DRAWIO_SERVER}__${DRAWIO_TOOL}` ||
      activity.toolCallId !== descriptor.toolCallId ||
      descriptor.serverName !== DRAWIO_SERVER ||
      descriptor.toolName !== DRAWIO_TOOL ||
      descriptor.uiResourceUri !== DRAWIO_RESOURCE ||
      descriptor.originSessionKey !== sessionKey ||
      descriptor.resultMetaState !== undefined ||
      details?.mcpServer !== DRAWIO_SERVER ||
      details.mcpTool !== DRAWIO_TOOL ||
      result?.isError === true ||
      details.status === 'error' ||
      details.status === 'failed'
    )
      return;
    const diagram = record(details.structuredContent);
    if (!diagram || typeof diagram.xml !== 'string' || typeof diagram.title !== 'string') return;
    return { toolCallId: activity.toolCallId, diagram };
  }
}
