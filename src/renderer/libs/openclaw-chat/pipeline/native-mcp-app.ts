import {
  type McpAppDescriptor,
  type McpAppPreview,
  mcpAppRecord as record,
  readMcpAppDescriptor,
} from '@shared/plugins/mcpApps';

const admitted = new WeakSet<object>();
const nativeToolRoles = new Set(['tool', 'toolresult', 'tool_result', 'function']);
const nativeNestedToolActivityType = 'openclaw.nested-tool.v1';
const failed = (value: Record<string, unknown> | undefined) =>
  value?.isError === true ||
  value?.ok === false ||
  value?.status === 'error' ||
  value?.status === 'failed';

export function isNativeMcpAppPreview(value: unknown): value is McpAppPreview {
  return Boolean(value && typeof value === 'object' && admitted.has(value));
}

/** Hide only native history's duplicate Canvas for an already admitted App. */
export function isNativeMcpAppFallbackPreview(
  value: unknown,
  apps: ReadonlyMap<string, McpAppPreview>,
): boolean {
  const fallback = record(value);
  const descriptor = readMcpAppDescriptor(fallback?.mcpApp);
  const app = descriptor ? apps.get(descriptor.viewId) : undefined;
  const expected = app?.descriptor;
  return Boolean(
    fallback?.kind === 'canvas' &&
    fallback.render === 'url' &&
    fallback.surface === 'assistant_message' &&
    fallback.url === undefined &&
    descriptor &&
    fallback.viewId === descriptor.viewId &&
    isNativeMcpAppPreview(app) &&
    expected &&
    (
      [
        'viewId',
        'serverName',
        'toolName',
        'toolCallId',
        'uiResourceUri',
        'originSessionKey',
        'resultMetaState',
      ] as const
    ).every(key => descriptor[key] === expected[key]),
  );
}

function preview(
  value: unknown,
  toolCallId: string,
): (McpAppPreview & { descriptor: McpAppDescriptor }) | undefined {
  const native = record(value);
  const descriptor = readMcpAppDescriptor(native?.mcpApp);
  const view = record(native?.view);
  const presentation = record(native?.presentation);
  if (
    !descriptor ||
    native?.kind !== 'canvas' ||
    view?.id !== descriptor.viewId ||
    presentation?.target !== 'assistant_message' ||
    presentation.sandbox !== 'scripts'
  )
    return;
  const title = typeof view.title === 'string' ? view.title.slice(0, 200) : descriptor.serverName;
  const result: McpAppPreview & { descriptor: McpAppDescriptor } = {
    kind: 'mcp-app',
    viewId: descriptor.viewId,
    descriptor,
    toolCallId,
    title: title === `${descriptor.toolName} UI` ? descriptor.serverName : title,
  };
  admitted.add(result);
  return result;
}

/** Only call for canonical Tool events or native tool-role history records. */
export function decodeNativeMcpAppResult(
  output: string | undefined,
  toolName: string | undefined,
  toolCallId: string | undefined,
): McpAppPreview | undefined {
  if (!output || output.length > 4 * 1024 * 1024 || !toolName || !toolCallId) return;
  let result: Record<string, unknown> | undefined;
  try {
    result = record(JSON.parse(output));
  } catch {
    return;
  }
  if (failed(result)) return;
  let details = record(result?.details) ?? result;
  let dispatcher = false;
  let dispatchedIdentity: Record<string, unknown> | undefined;
  if (toolName === 'tool_call') {
    const tool = record(result?.tool);
    const nested = record(result?.result);
    dispatchedIdentity = record(tool?.mcp);
    if (tool?.source !== 'mcp' || !dispatchedIdentity || failed(nested)) return;
    details = record(nested?.details);
    dispatcher = true;
  } else if (!/^[A-Za-z0-9_-]+__.+$/.test(toolName)) return;
  if (failed(details)) return;
  const candidate = preview(details?.mcpAppPreview, toolCallId);
  if (
    !candidate ||
    details?.mcpServer !== candidate.descriptor.serverName ||
    details?.mcpTool !== candidate.descriptor.toolName
  )
    return;
  if (!dispatcher && candidate.descriptor.toolCallId !== toolCallId) return;
  if (
    dispatcher &&
    (dispatchedIdentity?.serverName !== candidate.descriptor.serverName ||
      dispatchedIdentity?.toolName !== candidate.descriptor.toolName)
  )
    return;
  return candidate;
}

/**
 * Gateway projects the native preview separately from business result text.
 * Its public history projection omits mcpServer/mcpTool, so correlate the
 * retained descriptor with the exact native tool-role result and call ID.
 * The authenticated view read verifies the view's live session and requester.
 */
export function decodeNativeMcpAppHistoryResult(
  value: unknown,
  toolName: string | undefined,
  toolCallId: string | undefined,
): McpAppPreview | undefined {
  const source = record(value);
  if (
    !source ||
    typeof source.role !== 'string' ||
    !nativeToolRoles.has(source.role.toLowerCase()) ||
    failed(source) ||
    !toolName ||
    !/^[A-Za-z0-9_-]+__.+$/.test(toolName) ||
    !toolCallId
  )
    return;
  const details = record(source.details);
  if (failed(details)) return;
  const candidate = preview(details?.mcpAppPreview, toolCallId);
  if (
    !candidate ||
    candidate.descriptor.toolCallId !== toolCallId ||
    (details?.mcpServer !== undefined && details.mcpServer !== candidate.descriptor.serverName) ||
    (details?.mcpTool !== undefined && details.mcpTool !== candidate.descriptor.toolName)
  )
    return;
  return candidate;
}

/** Native ToolSearch persists each target as its own authenticated activity. */
export function decodeNativeNestedMcpAppHistoryResult(
  value: unknown,
  result: unknown,
): McpAppPreview | undefined {
  const source = record(value);
  const child = record(result);
  if (
    source?.role !== 'custom' ||
    source.customType !== nativeNestedToolActivityType ||
    source.display !== true ||
    source.excludeFromContext !== true ||
    !Array.isArray(source.content) ||
    !source.content.includes(result) ||
    child?.type !== 'toolResult' ||
    child.role !== 'toolResult' ||
    typeof child.toolCallId !== 'string' ||
    typeof child.toolName !== 'string' ||
    typeof child.runId !== 'string' ||
    !child.runId.trim() ||
    source.runId !== child.runId ||
    typeof child.parentToolCallId !== 'string' ||
    !child.parentToolCallId.trim()
  )
    return;
  const call = source.content.find(value => {
    const item = record(value);
    return (
      item?.type === 'toolCall' &&
      item.id === child.toolCallId &&
      item.name === child.toolName &&
      item.runId === child.runId &&
      item.parentToolCallId === child.parentToolCallId
    );
  });
  if (!call) return;
  return decodeNativeMcpAppHistoryResult(child, child.toolName, child.toolCallId);
}

/** A direct authenticated launch response uses the same descriptor admission. */
export function decodeMcpAppLaunch(value: unknown): McpAppPreview | undefined {
  const result = record(value);
  if (failed(result) || typeof result?.viewId !== 'string') return;
  const candidate = preview(result.preview, result.viewId);
  return candidate?.viewId === result.viewId ? candidate : undefined;
}

/** Used only for a native question preview returned by the typed Main bridge. */
export function decodeMcpAppQuestionPreview(value: unknown): McpAppPreview | undefined {
  const result = record(value);
  const viewId = record(result?.preview)?.viewId;
  if (
    failed(result) ||
    typeof viewId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(viewId) ||
    typeof result?.title !== 'string' ||
    !result.title.trim() ||
    result.title.length > 200
  )
    return;
  const candidate: McpAppPreview = {
    kind: 'mcp-app',
    viewId,
    title: result.title,
    descriptor: null,
    toolCallId: viewId,
  };
  admitted.add(candidate);
  return candidate;
}
