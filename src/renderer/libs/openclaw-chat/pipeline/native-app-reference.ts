import type { McpAppAdapter } from '@app-plugin/sdk/mcp-app';
import type { McpAppContentReference } from '@shared/plugins/mcpAppReferences';

import { findMcpAppReferenceAdapter } from './mcp-app-adapters';

const admitted = new WeakMap<object, McpAppAdapter>();
export const isNativeAppReference = (value: unknown): value is McpAppContentReference =>
  Boolean(value && typeof value === 'object' && admitted.has(value));

export function readAppReferenceAdapter(reference: McpAppContentReference) {
  return admitted.get(reference);
}

/** Explicit trusted plugin adapters. Never scan assistant prose or self-declared plugin IDs. */
export function decodeNativeAppReference(
  value: unknown,
  toolName?: string,
  toolCallId?: string,
  runId?: string,
): McpAppContentReference | undefined {
  const adapter = toolName ? findMcpAppReferenceAdapter(toolName) : undefined;
  if (!adapter || !toolCallId) return;
  let result = value;
  if (typeof result === 'string') {
    if (result.length > 4 * 1024 * 1024) return;
    try {
      result = JSON.parse(result);
    } catch {
      return;
    }
  }
  const receipt = adapter.readReference(result, toolCallId);
  if (!receipt || receipt.toolCallId !== toolCallId || (runId && receipt.runId !== runId)) return;
  const nativeRun =
    result && typeof result === 'object' ? (result as Record<string, unknown>).runId : undefined;
  if (typeof nativeRun === 'string' && nativeRun !== receipt.runId) return;
  const reference: McpAppContentReference = Object.freeze({
    content: Object.freeze({
      namespace: adapter.namespace,
      contentId: receipt.contentId,
      serverName: adapter.serverName,
      uiResourceUri: adapter.uiResourceUri,
      originViewId: receipt.originViewId,
      sessionKey: receipt.sessionKey,
      sessionId: receipt.sessionId,
      agentId: receipt.agentId,
    }),
    title: receipt.title,
    operationId: receipt.operationId,
    toolCallId: receipt.toolCallId,
    runId: receipt.runId,
    status: 'updated',
  });
  admitted.set(reference, adapter);
  return reference;
}
