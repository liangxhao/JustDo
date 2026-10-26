import {
  decodeNativeWidgetPayload,
  isNativeCanvasPreview,
  type NativeCanvasPreview,
} from './native-canvas';

export type NativeBoardWidgetReference = {
  kind: 'native-board';
  name: string;
  toolCallId: string;
  title?: string;
  /** Identifies only an inline duplicate to suppress, never the board identity. */
  suppressedInlineDocId?: string;
};

const admitted = new WeakSet<object>();
type LiveOwner = { client: object; generation: number; sessionKey: string; sessionId: string };
type LiveProof = LiveOwner & { order: number };
const realtimeTools = new WeakMap<object, LiveProof>();
const realtimeReferences = new WeakMap<object, LiveProof>();
let realtimeSequence = 0;
export const BOARD_WIDGET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export type NativeWidgetReference = NativeCanvasPreview | NativeBoardWidgetReference;
export function isNativeWidgetReference(value: unknown): value is NativeWidgetReference {
  return isNativeCanvasPreview(value) || isNativeBoardWidgetReference(value);
}
export function widgetReferenceId(value: NativeWidgetReference): string {
  return value.kind === 'canvas' ? value.docId : `board:${value.name}`;
}

export function isNativeBoardWidgetReference(value: unknown): value is NativeBoardWidgetReference {
  return Boolean(value && typeof value === 'object' && admitted.has(value));
}

/** Only the authenticated chat controller's accepted live tool result calls this. */
export function markNativeBoardRealtime(tool: object, owner: LiveOwner): void {
  realtimeTools.set(tool, { ...owner, order: ++realtimeSequence });
}

export function boardReferenceIsRealtime(
  reference: NativeBoardWidgetReference,
  owner: LiveOwner,
): boolean {
  const proof = realtimeReferences.get(reference);
  return Boolean(
    proof &&
    proof.client === owner.client &&
    proof.generation === owner.generation &&
    proof.sessionKey === owner.sessionKey &&
    proof.sessionId === owner.sessionId,
  );
}

export function nativeBoardReferenceOrder(reference: NativeBoardWidgetReference): number {
  return realtimeReferences.get(reference)?.order ?? 0;
}

/** No arbitrary JSON, assistant text, nested process record or title grants authority. */
export function decodeNativeBoardResult(
  output: string | undefined,
  toolName: string | undefined,
  toolCallId: string | undefined,
  liveTool?: object,
): NativeBoardWidgetReference | undefined {
  const payload = decodeNativeWidgetPayload(output, toolName, toolCallId);
  if (!payload) return;
  const view =
    payload.view && typeof payload.view === 'object' && !Array.isArray(payload.view)
      ? (payload.view as Record<string, unknown>)
      : undefined;
  const name = payload.boardWidgetName ?? view?.boardWidgetName;
  if (
    typeof name !== 'string' ||
    !BOARD_WIDGET_NAME.test(name) ||
    (payload.boardWidgetName !== undefined &&
      view?.boardWidgetName !== undefined &&
      payload.boardWidgetName !== view.boardWidgetName)
  )
    return;
  const presentation = payload.presentation as Record<string, unknown> | undefined;
  const reference: NativeBoardWidgetReference = {
    kind: 'native-board',
    name,
    toolCallId: toolCallId!,
    ...(typeof presentation?.title === 'string' ? { title: presentation.title.slice(0, 200) } : {}),
    ...(payload.kind === 'canvas' &&
    typeof view?.id === 'string' &&
    /^[A-Za-z0-9._-]{1,256}$/.test(view.id)
      ? { suppressedInlineDocId: view.id }
      : {}),
  };
  admitted.add(reference);
  const owner = liveTool && realtimeTools.get(liveTool);
  if (owner) realtimeReferences.set(reference, owner);
  return reference;
}
