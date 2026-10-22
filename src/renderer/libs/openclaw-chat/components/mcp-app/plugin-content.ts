import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type {
  McpAppContentIdentity,
  McpAppContentReference,
} from '@shared/plugins/mcpAppReferences';
import { sameMcpAppContent } from '@shared/plugins/mcpAppReferences';
import {
  type McpAppDescriptor,
  type McpAppPreview,
  mcpAppRecord,
  type McpAppViewPayload,
} from '@shared/plugins/mcpApps';

import { connectCurrentDiagram } from '../../../../../../plugins/extensions/drawio/browser/current-canvas';
import {
  DRAWIO_ENTRY_TOOLS,
  DRAWIO_RESOURCE,
  DRAWIO_SERVER,
} from '../../../../../../plugins/extensions/drawio/contracts';
import type { McpAppSession, McpAppSessionView } from '../../gateway/mcp-app/mcp-app-session';
import { isNativeAppReference } from '../../pipeline/native-app-reference';
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

/** Reviewed, optional plugin integration. The standard host has no business-content protocol. */
export function connectAppContent(input: {
  identity?: Readonly<McpAppDescriptor>;
  payload: McpAppViewPayload;
  previewViewId: string;
  preview: McpAppPreview;
  session: McpAppSessionView;
  context: McpAppViewContext;
  bridge: AppBridge;
  current: () => boolean;
  priority: () => number;
}) {
  const { identity, payload, session, context, bridge, current, priority } = input;
  const diagramId = mcpAppRecord(payload.toolResult?.structuredContent)?.diagramId;
  if (
    identity?.serverName !== DRAWIO_SERVER ||
    identity.uiResourceUri !== DRAWIO_RESOURCE ||
    !DRAWIO_ENTRY_TOOLS.includes(identity.toolName as never) ||
    identity.originSessionKey !== context.sessionKey ||
    typeof diagramId !== 'string' ||
    !session.sessionId ||
    !session.agentId
  )
    return;
  const content: Readonly<McpAppContentIdentity> =
    readRecoveredAppContent(input.preview, session) ??
    Object.freeze({
      namespace: 'drawio/editor',
      contentId: diagramId,
      serverName: identity.serverName,
      uiResourceUri: identity.uiResourceUri,
      originViewId: identity.viewId,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      agentId: session.agentId,
    });
  const dispose =
    payload.messageSupported === true
      ? connectCurrentDiagram({
          source: Object.freeze({
            serverName: identity.serverName,
            toolName: identity.toolName,
            uiResourceUri: identity.uiResourceUri,
            originSessionKey: identity.originSessionKey,
          }),
          diagramId,
          bridge,
          viewId: () => session.nativeViewId!,
          current,
          priority,
          request: value => session.diagramRequest(value),
          release: token => session.releaseDiagram(token),
          subscribe: listener => session.subscribe(listener),
          onSuspend: listener => session.onSuspend(listener),
          register: prepare =>
            context.apps.registerCanvasPreparation(input.previewViewId, prepare, current),
        })
      : () => undefined;
  const title = mcpAppRecord(payload.toolResult?.structuredContent)?.title;
  return {
    content,
    dispose,
    localNotice: 'mcpAppsDiagramLocal',
    title: typeof title === 'string' ? title.slice(0, 160) : undefined,
  };
}

export async function restoreAppReference(
  reference: McpAppContentReference,
  context: McpAppViewContext,
) {
  if (
    !isNativeAppReference(reference) ||
    !context.isCurrent() ||
    !context.apps.ready ||
    context.sessionKey !== reference.content.sessionKey
  )
    throw new Error('App reference unavailable');
  const source = reference.content;
  const session = context.apps.bind(source.originViewId);
  if (
    session.sessionId !== source.sessionId ||
    session.agentId !== source.agentId ||
    source.namespace !== 'drawio/editor' ||
    source.serverName !== DRAWIO_SERVER ||
    source.uiResourceUri !== DRAWIO_RESOURCE
  )
    throw new Error('App reference source changed');
  const pending = recovering.get(context.apps) ?? [];
  const existing = pending.find(
    item => item.binding.sameNativeIdentity(session) && sameMcpAppContent(item.content, source),
  );
  if (existing) return existing.promise;
  const promise = (async () => {
    const result = await session.restoreDiagramReference({
      diagramId: source.contentId,
      originViewId: source.originViewId,
      sessionId: source.sessionId,
      operationId: reference.operationId,
      toolCallId: reference.toolCallId,
      title: reference.title,
    });
    if (!context.isCurrent() || !session.isCurrent()) throw new Error('App reference changed');
    const preview = decodeMcpAppLaunch(result);
    const identity = readNativeMcpAppIdentity(preview);
    const payload = mcpAppRecord(mcpAppRecord(result)?.payload);
    const diagram = mcpAppRecord(mcpAppRecord(payload?.toolResult)?.structuredContent);
    if (
      !preview ||
      identity?.serverName !== source.serverName ||
      identity.uiResourceUri !== source.uiResourceUri ||
      identity.originSessionKey !== source.sessionKey ||
      diagram?.diagramId !== source.contentId ||
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
