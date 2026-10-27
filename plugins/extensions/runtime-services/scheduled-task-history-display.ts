const NESTED_TOOL_ACTIVITY_TYPE = 'openclaw.nested-tool.v1';
const ACTIVITY_FIELDS = new Set([
  'runId',
  'scopeId',
  'afterEntryId',
  'startOrder',
  'parentToolCallId',
  'toolCallId',
  'toolName',
  'input',
  'result',
  'isError',
  'startedAt',
  'timestamp',
]);

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const identifier = (value: unknown, limit = 1024): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit;
const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Keep inert display metadata; raw diagnostics cannot admit interactive views. */
function toolDisplayDetails(value: unknown): RecordValue | undefined {
  const details = record(value);
  if (!details) return;
  const projected: RecordValue = {};
  for (const key of ['exitCode', 'durationMs'] as const) {
    if (finiteNumber(details[key])) projected[key] = details[key];
  }
  for (const key of ['ok', 'changed', 'created'] as const) {
    if (typeof details[key] === 'boolean') projected[key] = details[key];
  }
  const tab = record(details.browserTab);
  const routeId = (value: unknown, limit: number): value is string =>
    identifier(value, limit) && value.trim() === value;
  if (
    tab &&
    routeId(tab.targetId, 128) &&
    routeId(tab.profile, 128) &&
    ((tab.target === 'host' && tab.node === undefined) ||
      (tab.target === 'node' && routeId(tab.node, 256)))
  ) {
    projected.browserTab = {
      targetId: tab.targetId,
      profile: tab.profile,
      target: tab.target,
      ...(tab.target === 'node' ? { node: tab.node } : {}),
      ...(typeof tab.url === 'string' ? { url: tab.url.slice(0, 2048) } : {}),
      ...(typeof tab.title === 'string' ? { title: tab.title.slice(0, 512) } : {}),
    };
  }
  return Object.keys(projected).length ? projected : undefined;
}

/** The public transcript SDK returns redacted entries, not chat display blocks. */
export function projectScheduledTaskHistoryMessage(message: RecordValue): RecordValue {
  const activity = record(message.details);
  const result = record(activity?.result);
  if (
    message.role !== 'custom' ||
    message.customType !== NESTED_TOOL_ACTIVITY_TYPE ||
    message.display !== true ||
    message.excludeFromContext !== true ||
    message.content !== '' ||
    !finiteNumber(message.timestamp) ||
    !activity ||
    !result ||
    Object.keys(activity).some(key => !ACTIVITY_FIELDS.has(key)) ||
    !identifier(activity.runId) ||
    !identifier(activity.scopeId) ||
    (activity.afterEntryId !== null && !identifier(activity.afterEntryId)) ||
    (activity.parentToolCallId !== undefined && !identifier(activity.parentToolCallId)) ||
    !identifier(activity.toolCallId) ||
    !identifier(activity.toolName, 256) ||
    !Number.isSafeInteger(activity.startOrder) ||
    (activity.startOrder as number) < 0 ||
    !finiteNumber(activity.startedAt) ||
    !finiteNumber(activity.timestamp) ||
    !Object.prototype.hasOwnProperty.call(activity, 'input') ||
    typeof activity.isError !== 'boolean' ||
    !Array.isArray(result.content)
  )
    return message;

  const correlation = {
    runId: activity.runId,
    toolCallId: activity.toolCallId,
    toolName: activity.toolName,
    ...(activity.parentToolCallId !== undefined
      ? { parentToolCallId: activity.parentToolCallId }
      : {}),
  };
  const details = toolDisplayDetails(result.details);
  // Retain the native custom role and entry identity; only project its display payload.
  const { details: _rawDetails, ...source } = message;
  return {
    ...source,
    runId: activity.runId,
    __openclaw: { ...record(message.__openclaw), runId: activity.runId },
    content: [
      {
        type: 'toolCall',
        id: activity.toolCallId,
        name: activity.toolName,
        runId: activity.runId,
        ...(activity.parentToolCallId !== undefined
          ? { parentToolCallId: activity.parentToolCallId }
          : {}),
        arguments: activity.input,
        timestamp: activity.startedAt,
      },
      {
        ...correlation,
        type: 'toolResult',
        role: 'toolResult',
        content: result.content,
        ...(details ? { details } : {}),
        isError: activity.isError,
        timestamp: activity.timestamp,
      },
    ],
  };
}
