import {
  type DiagramReference,
  DRAWIO_EDIT_TOOL,
} from '../../../../../openclaw-extensions/drawio/contracts';
import { readDiagramUpdate } from '../../../../../openclaw-extensions/drawio/update-result';

const admitted = new WeakSet<object>();
export const isNativeDiagramReference = (value: unknown): value is DiagramReference =>
  Boolean(value && typeof value === 'object' && admitted.has(value));

/** Only native tool events/roles may call this; no assistant text admission. */
export function decodeNativeDiagramReference(
  value: unknown,
  toolName?: string,
  toolCallId?: string,
): DiagramReference | undefined {
  if (toolName !== DRAWIO_EDIT_TOOL) return;
  let result = value;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      return;
    }
  }
  const receipt = readDiagramUpdate(result, toolName, toolCallId);
  if (!receipt) return;
  const reference = Object.freeze({
    diagramId: receipt.diagramId,
    operationId: receipt.operationId,
    toolCallId: receipt.toolCallId,
    originViewId: receipt.source.originViewId,
    sessionId: receipt.source.sessionId,
    title: receipt.title,
  });
  admitted.add(reference);
  return reference;
}
