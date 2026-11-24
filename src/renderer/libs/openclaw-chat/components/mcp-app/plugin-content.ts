import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type {
  McpAppContentIdentity,
  McpAppContentReference,
} from '@shared/plugins/mcpAppReferences';
import { sameMcpAppContent } from '@shared/plugins/mcpAppReferences';
import { type McpAppPreview, mcpAppRecord, type McpAppViewPayload } from '@shared/plugins/mcpApps';

import type { McpAppSession, McpAppSessionView } from '../../gateway/mcp-app/mcp-app-session';
import { findMcpAppViewAdapter } from '../../pipeline/mcp-app-adapters';
import { readAppReferenceAdapter } from '../../pipeline/native-app-reference';
import { decodeMcpAppLaunch, readNativeMcpAppIdentity } from '../../pipeline/native-mcp-app';
import type { McpAppViewContext } from './view';

const recovered = new WeakMap<
  McpAppPreview,
  { binding: McpAppSessionView; content: Readonly<McpAppContentIdentity> }
>();
const recovering = new WeakMap<
  McpAppSession,
  Array<{
    binding: McpAppSessionView;
    content: Readonly<McpAppContentIdentity>;
    promise: Promise<McpAppPreview>;
  }>
>();

/** An alias is recorded only after the plugin's authenticated read-only recovery. */
export function readRecoveredAppContent(preview: McpAppPreview, binding: McpAppSessionView) {
  const item = recovered.get(preview);
  return readNativeMcpAppIdentity(preview) && item?.binding.sameNativeIdentity(binding)
    ? item.content
    : undefined;
}

export function restrictRecoveredAppPayload(
  preview: McpAppPreview,
  binding: McpAppSessionView,
  payload: McpAppViewPayload,
): McpAppViewPayload {
  if (!readRecoveredAppContent(preview, binding)) return payload;
  return {
    ...payload,
    messageSupported: false,
    updateModelContextSupported: false,
    richModelContextSupported: false,
    fileResourcesSupported: false,
    openFilesSupported: false,
  };
}

/** Connect only the adapter chosen for the authenticated view during preparation. */
export function connectAppContent(input: {
  payload: McpAppViewPayload;
  preview: McpAppPreview;
  session: McpAppSessionView;
  context: McpAppViewContext;
  bridge: AppBridge;
  current: () => boolean;
  operationCurrent: () => boolean;
  priority: () => number;
}) {
  const { payload, preview, session, context, bridge, current, priority } = input;
  const identity = readNativeMcpAppIdentity(preview);
  const registered = session.contentAdapter;
  if (
    !identity ||
    !registered ||
    identity.originSessionKey !== context.sessionKey ||
    !session.sessionId ||
    !session.agentId
  )
    return;
  const { adapter, source } = registered;
  if (
    identity.viewId !== session.viewId ||
    identity.serverName !== source.serverName ||
    identity.toolName !== source.toolName ||
    identity.uiResourceUri !== source.uiResourceUri ||
    identity.originSessionKey !== source.originSessionKey
  )
    return;
  const item = adapter.content(payload.toolResult);
  if (!item) return;
  const content: Readonly<McpAppContentIdentity> =
    readRecoveredAppContent(preview, session) ??
    Object.freeze({
      namespace: adapter.namespace,
      contentId: item.id,
      serverName: identity.serverName,
      uiResourceUri: identity.uiResourceUri,
      originViewId: identity.viewId,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      agentId: session.agentId,
    });
  const dispose =
    payload.messageSupported === true
      ? adapter.connect({
          ...session.editorTransport(adapter),
          source,
          contentId: item.id,
          bridge,
          viewId: () => session.nativeViewId!,
          current: input.operationCurrent,
          canPrepare: current,
          priority,
          subscribe: listener => session.subscribeRetainedEditor(listener),
          onSuspend: listener => session.onSuspend(listener),
          registerPreparation: prepare =>
            context.apps.registerCanvasPreparation(
              adapter,
              preview.viewId,
              prepare,
              current,
              runId => session.retainPreparedRun(runId),
            ),
        })
      : () => undefined;
  return {
    content,
    dispose,
    retainOnNavigation: payload.messageSupported === true,
    ownsReadOnlyNotice: adapter.ownsReadOnlyNotice,
    title: item.title,
  };
}

export async function restoreAppReference(
  reference: McpAppContentReference,
  context: McpAppViewContext,
) {
  const adapter = readAppReferenceAdapter(reference);
  if (
    !adapter ||
    !context.isCurrent() ||
    !context.apps.ready ||
    context.sessionKey !== reference.content.sessionKey
  )
    throw new Error('App reference unavailable');
  const source = reference.content;
  const session = context.apps.bind(source.originViewId);
  if (session.sessionId !== source.sessionId || session.agentId !== source.agentId)
    throw new Error('App reference source changed');
  const pending = recovering.get(context.apps) ?? [];
  const existing = pending.find(
    item => item.binding.sameNativeIdentity(session) && sameMcpAppContent(item.content, source),
  );
  if (existing) return existing.promise;
  const promise = (async () => {
    const result = await session.restoreContentReference(reference);
    if (!context.isCurrent() || !session.isCurrent()) throw new Error('App reference changed');
    const preview = decodeMcpAppLaunch(result);
    const identity = readNativeMcpAppIdentity(preview);
    const payload = mcpAppRecord(mcpAppRecord(result)?.payload);
    if (
      !preview ||
      !identity ||
      findMcpAppViewAdapter(identity) !== adapter ||
      identity.originSessionKey !== source.sessionKey ||
      adapter.content(payload?.toolResult)?.id !== source.contentId ||
      payload?.messageSupported !== false
    )
      throw new Error('App reference unavailable');
    recovered.set(preview, { binding: session, content: source });
    return preview;
  })();
  const item = { binding: session, content: source, promise };
  pending.push(item);
  recovering.set(context.apps, pending);
  try {
    return await promise;
  } finally {
    const index = pending.indexOf(item);
    if (index >= 0) pending.splice(index, 1);
    if (!pending.length) recovering.delete(context.apps);
  }
}
