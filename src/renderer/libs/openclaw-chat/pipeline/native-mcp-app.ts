import {
  type McpAppDescriptor,
  type McpAppPreview,
  mcpAppRecord as record,
  readMcpAppDescriptor,
} from '@shared/plugins/mcpApps';

import { stripEmbedShortcodes } from './embed-shortcodes';

const admitted = new WeakSet<object>();
const admittedIdentities = new WeakMap<object, Readonly<McpAppDescriptor>>();
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

/** Captured at native admission; a mutable descriptor cannot swap plugin identity later. */
export function readNativeMcpAppIdentity(value: unknown): Readonly<McpAppDescriptor> | undefined {
  if (!isNativeMcpAppPreview(value)) return;
  const identity = admittedIdentities.get(value);
  if (
    !identity ||
    value.viewId !== identity.viewId ||
    !value.descriptor ||
    (Object.keys(identity) as Array<keyof McpAppDescriptor>).some(
      key => value.descriptor?.[key] !== identity[key],
    )
  )
    return;
  return identity;
}

/** MCP references do not authorize or suppress a Canvas document URL. */
export function stripNativeMcpAppFallbacks(
  text: string,
  appIds: ReadonlySet<string>,
  widgetIds: ReadonlySet<string> = new Set(),
): string {
  if (!appIds.size || !text.toLowerCase().includes('[embed')) return text;
  return stripEmbedShortcodes(text, attributes =>
    isNativeMcpAppFallbackAttributes(attributes, appIds, widgetIds),
  );
}

export function isNativeMcpAppFallbackAttributes(
  attributes: Readonly<Record<string, string>>,
  appIds: ReadonlySet<string>,
  widgetIds: ReadonlySet<string>,
): boolean {
  const ref = attributes.ref ?? attributes.viewid;
  return attributes.url === undefined && Boolean(ref && appIds.has(ref) && !widgetIds.has(ref));
}

/** Hide exact native placeholders for admitted Apps or confirmed failed calls. */
export function isNativeMcpAppFallbackPreview(
  value: unknown,
  apps: ReadonlyMap<string, McpAppPreview>,
  failedApps?: ReadonlyMap<string, McpAppDescriptor>,
): boolean {
  const fallback = record(value);
  const descriptor = readMcpAppDescriptor(fallback?.mcpApp);
  const app = descriptor ? apps.get(descriptor.viewId) : undefined;
  const expected = isNativeMcpAppPreview(app)
    ? app.descriptor
    : descriptor && failedApps?.get(descriptor.viewId);
  return Boolean(
    fallback?.kind === 'canvas' &&
    fallback.render === 'url' &&
    fallback.surface === 'assistant_message' &&
    fallback.url === undefined &&
    descriptor &&
    fallback.viewId === descriptor.viewId &&
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

function previewDescriptor(value: unknown): McpAppDescriptor | undefined {
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
  return descriptor;
}

function preview(
  value: unknown,
  toolCallId: string,
): (McpAppPreview & { descriptor: McpAppDescriptor }) | undefined {
  const descriptor = previewDescriptor(value);
  if (!descriptor) return;
  const viewTitle = record(record(value)?.view)?.title;
  const title = typeof viewTitle === 'string' ? viewTitle.slice(0, 200) : descriptor.serverName;
  const result: McpAppPreview & { descriptor: McpAppDescriptor } = {
    kind: 'mcp-app',
    viewId: descriptor.viewId,
    descriptor,
    toolCallId,
    title: title === `${descriptor.toolName} UI` ? descriptor.serverName : title,
  };
  admitted.add(result);
  admittedIdentities.set(result, Object.freeze({ ...descriptor }));
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
function readNativeMcpAppHistoryPreview(
  value: unknown,
  toolName: string | undefined,
  toolCallId: string | undefined,
) {
  const source = record(value);
  if (
    !source ||
    typeof source.role !== 'string' ||
    !nativeToolRoles.has(source.role.toLowerCase()) ||
    !toolName ||
    !/^[A-Za-z0-9_-]+__.+$/.test(toolName) ||
    !toolCallId
  )
    return;
  const details = record(source.details);
  const descriptor = previewDescriptor(details?.mcpAppPreview);
  if (
    !descriptor ||
    descriptor.toolCallId !== toolCallId ||
    (details?.mcpServer !== undefined && details.mcpServer !== descriptor.serverName) ||
    (details?.mcpTool !== undefined && details.mcpTool !== descriptor.toolName)
  )
    return;
  return { source, details, descriptor, toolCallId };
}

export function decodeNativeMcpAppHistoryResult(
  value: unknown,
  toolName: string | undefined,
  toolCallId: string | undefined,
): McpAppPreview | undefined {
  const history = readNativeMcpAppHistoryPreview(value, toolName, toolCallId);
  if (!history || failed(history.source) || failed(history.details)) return;
  return preview(history.details?.mcpAppPreview, history.toolCallId);
}

/** Suppression evidence only: a failed call never admits a view or grants reads. */
export function readFailedNativeMcpAppHistoryDescriptor(
  value: unknown,
  toolName: string | undefined,
  toolCallId: string | undefined,
): McpAppDescriptor | undefined {
  const history = readNativeMcpAppHistoryPreview(value, toolName, toolCallId);
  if (!history || (!failed(history.source) && !failed(history.details))) return;
  return history.descriptor;
}

/** Native ToolSearch persists each target as its own authenticated activity. */
function readNativeNestedMcpAppHistoryResult(value: unknown, result: unknown) {
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
  return { child, toolName: child.toolName, toolCallId: child.toolCallId };
}

export function decodeNativeNestedMcpAppHistoryResult(
  value: unknown,
  result: unknown,
): McpAppPreview | undefined {
  const nested = readNativeNestedMcpAppHistoryResult(value, result);
  if (!nested) return;
  return decodeNativeMcpAppHistoryResult(nested.child, nested.toolName, nested.toolCallId);
}

export function readFailedNativeNestedMcpAppHistoryDescriptor(
  value: unknown,
  result: unknown,
): McpAppDescriptor | undefined {
  const nested = readNativeNestedMcpAppHistoryResult(value, result);
  if (!nested) return;
  return readFailedNativeMcpAppHistoryDescriptor(nested.child, nested.toolName, nested.toolCallId);
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
