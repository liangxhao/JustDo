import type { WebLaunchOutputStatus } from '../../../../plugins/browser-extensions/browser-assistant/contracts/webLaunch';
import { WebLaunchLimits } from '../../../../plugins/browser-extensions/browser-assistant/contracts/webLaunch';
import type { GatewayClientLike } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import type { WebLaunchNativeBinding } from './browserWebLaunchStore';
import { webLaunchDigest } from './browserWebLaunchValidation';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const idOf = (value: Record<string, unknown>): string | undefined => {
  const id = record(value.__openclaw)?.id ?? value.id ?? value.messageId ?? value.eventId;
  return typeof id === 'string' && id ? id : undefined;
};
const textOf = (value: Record<string, unknown>): string => {
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return value.content.flatMap(block => {
    const item = record(block);
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  }).join('\n');
  return typeof value.text === 'string' ? value.text : '';
};
const hasTool = (value: Record<string, unknown>): boolean => value.stopReason === 'toolUse'
  || Array.isArray(value.content) && value.content.some(block => ['toolCall', 'toolUse', 'functionCall'].includes(String(record(block)?.type)));

/** Preserve source groups: a tool-bearing native row can become several display rows. */
export function selectWebLaunchFinal(messages: unknown[], runId: string, terminalText: string) {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const raw of messages) {
    const item = record(raw);
    if (!item || item.role !== 'assistant' || item.display === false || record(item.__openclaw)?.runId !== runId) continue;
    const id = idOf(item);
    if (!id) continue;
    const group = groups.get(id) ?? [];
    group.push(item);
    groups.set(id, group);
  }
  const matching = [...groups].flatMap(([messageId, group]) => {
    if (group.some(item => hasTool(item) || ['error', 'aborted'].includes(String(item.stopReason)) || record(item.__openclaw)?.truncated === true)
      || !group.some(item => item.stopReason === 'stop')) return [];
    const text = group.map(textOf).filter(Boolean).join('\n');
    return text === terminalText ? [{ messageId, text, digest: webLaunchDigest(text) }] : [];
  });
  return matching.length === 1 ? matching[0] : null;
}

export interface WebLaunchResultCandidate {
  text?: string;
  disposition?: string;
  agentSeq: number;
}
export interface WebLaunchResultRead {
  status: WebLaunchOutputStatus;
  text?: string;
  reference?: { messageId: string; digest: string };
}

export async function readWebLaunchFinal(options: {
  runtime: OpenClawRuntimeAdapter;
  client: GatewayClientLike;
  binding: WebLaunchNativeBinding;
  candidate?: WebLaunchResultCandidate;
  reference?: { messageId: string; digest: string };
  assertCurrent: () => void;
}): Promise<WebLaunchResultRead> {
  const { runtime, client, binding, assertCurrent } = options;
  const describe = async () => {
    assertCurrent();
    const raw = await client.request('sessions.describe', { key: binding.sessionKey });
    assertCurrent();
    const session = record(record(raw)?.session);
    if (session?.sessionId !== binding.nativeSessionId || session.lifecycleRevision !== binding.lifecycleRevision
      || session.key !== binding.sessionKey) throw new Error('RESULT_IDENTITY_CHANGED');
  };
  await describe();
  let reference = options.reference;
  if (!reference) {
    const candidate = options.candidate;
    if (!candidate || candidate.disposition !== 'visible' || typeof candidate.text !== 'string') return { status: 'unavailable' };
    if (!candidate.text) return { status: 'unavailable' }; // No proved successful-empty contract yet.
    if (Buffer.byteLength(candidate.text) > WebLaunchLimits.resultBytes) return { status: 'unsupported' };
    const history = await runtime.fetchSessionHistoryByKey(binding.sessionKey, undefined, { forceFullSnapshot: true, includePendingInputs: true });
    assertCurrent();
    await describe();
    if (!history) return { status: 'pending' };
    const selected = selectWebLaunchFinal(history.messages, binding.nativeRunId, candidate.text);
    if (!selected) return { status: 'pending' };
    reference = { messageId: selected.messageId, digest: selected.digest };
  }
  const raw = await client.request('chat.message.get', {
    sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId,
    messageId: reference.messageId, maxChars: WebLaunchLimits.resultBytes,
  });
  assertCurrent();
  await describe();
  const result = record(raw);
  const message = record(result?.message);
  if (result?.ok !== true || !message || idOf(message) !== reference.messageId
    || record(message.__openclaw)?.runId !== binding.nativeRunId || record(message.__openclaw)?.truncated === true
    || hasTool(message) || message.stopReason !== 'stop') return { status: 'unavailable' };
  const text = textOf(message);
  if (!text || webLaunchDigest(text) !== reference.digest) return { status: 'unavailable' };
  if (Buffer.byteLength(text) > WebLaunchLimits.resultBytes) return { status: 'unsupported' };
  return { status: 'available', text, reference };
}
