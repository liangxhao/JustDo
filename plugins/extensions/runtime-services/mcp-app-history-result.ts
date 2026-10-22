type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;

/** Only exact successful native child activities, never assistant JSON or display text. */
export function selectMcpAppHistoryResult(messages: unknown[], viewId: string, sessionKey: string) {
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
      !activity ||
      !details ||
      activity.isError !== false ||
      typeof activity.runId !== 'string' ||
      !activity.runId ||
      typeof activity.parentToolCallId !== 'string' ||
      !activity.parentToolCallId ||
      typeof activity.toolCallId !== 'string' ||
      !activity.toolCallId ||
      activity.toolCallId.length > 512 ||
      activity.toolCallId !== descriptor.toolCallId ||
      typeof descriptor.serverName !== 'string' ||
      !/^[a-z0-9_-]{1,256}$/i.test(descriptor.serverName) ||
      typeof descriptor.toolName !== 'string' ||
      !descriptor.toolName ||
      descriptor.toolName.length > 256 ||
      typeof descriptor.uiResourceUri !== 'string' ||
      !descriptor.uiResourceUri.startsWith('ui://') ||
      descriptor.uiResourceUri.length > 2048 ||
      descriptor.originSessionKey !== sessionKey ||
      descriptor.resultMetaState !== undefined ||
      activity.toolName !== `${descriptor.serverName}__${descriptor.toolName}` ||
      details.mcpServer !== descriptor.serverName ||
      details.mcpTool !== descriptor.toolName ||
      result?.isError === true ||
      details.status === 'error' ||
      details.status === 'failed' ||
      !Array.isArray(result?.content) ||
      typeof activity.input !== 'object' ||
      activity.input === null
    )
      return;
    return {
      serverName: descriptor.serverName,
      toolName: descriptor.toolName,
      uiResourceUri: descriptor.uiResourceUri,
      toolCallId: activity.toolCallId,
      toolInput: activity.input,
      toolResult: {
        content: result.content,
        ...(record(details.structuredContent)
          ? { structuredContent: record(details.structuredContent) }
          : {}),
        ...(record(details._meta) ? { _meta: record(details._meta) } : {}),
      },
    };
  }
}
