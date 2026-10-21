import type { McpAppContentReference } from '@shared/plugins/mcpAppReferences';

import { readDiagramReference } from '../../../../../openclaw-extensions/drawio/update-result';

const admitted = new WeakSet<object>();
export const isNativeAppReference = (value: unknown): value is McpAppContentReference =>
  Boolean(value && typeof value === 'object' && admitted.has(value));

/** Explicit trusted plugin adapter. Never scan assistant prose or self-declared plugin IDs. */
export function decodeNativeAppReference(
  value: unknown,
  toolName?: string,
  toolCallId?: string,
  runId?: string,
): McpAppContentReference | undefined {
  let result = value;
  if (typeof result === 'string') {
    if (result.length > 4 * 1024 * 1024) return;
    try {
      result = JSON.parse(result);
    } catch {
      return;
    }
  }
  const receipt = readDiagramReference(result, toolName, toolCallId);
  if (!receipt || (runId && receipt.runId !== runId)) return;
  const nativeRun =
    result && typeof result === 'object' ? (result as Record<string, unknown>).runId : undefined;
  if (typeof nativeRun === 'string' && nativeRun !== receipt.runId) return;
  const reference: McpAppContentReference = Object.freeze({
    content: Object.freeze({
      namespace: 'drawio/editor',
      contentId: receipt.diagramId,
      serverName: receipt.source.serverName,
      uiResourceUri: receipt.source.uiResourceUri,
      originViewId: receipt.source.originViewId,
      sessionKey: receipt.source.sessionKey,
      sessionId: receipt.source.sessionId,
      agentId: receipt.source.agentId,
    }),
    title: receipt.title,
    operationId: receipt.operationId,
    toolCallId: receipt.toolCallId,
    runId: receipt.runId,
    status: 'updated',
  });
  admitted.add(reference);
  return reference;
}
