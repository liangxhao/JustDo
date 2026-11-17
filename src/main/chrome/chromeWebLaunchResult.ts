import {
  publicWebLaunchArtifact,
  type WebLaunchArtifact,
  WebLaunchLimits,
  type WebLaunchOutputStatus,
} from '../../../plugins/chrome-extensions/chrome-assistant/contracts/webLaunch';
import { getAssistantDeliverables, unwrapAssistantDeliverableSource } from '../../shared/openclaw/assistantDeliverables';
import { filterMediaDirectiveLines } from '../../shared/openclaw/mediaDirectives';
import type { GatewayClientLike } from '../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../engine/openclaw/openclawRuntimeAdapter';
import type { WebLaunchNativeBinding, WebLaunchResultReference } from './chromeWebLaunchStore';
import { webLaunchDigest } from './chromeWebLaunchValidation';

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

function deliveryManifest(messages: Record<string, unknown>[]): Set<string> {
  const sources = new Set<string>();
  for (const message of messages) {
    const values = record(message.openclawDelivery)?.mediaUrls;
    if (!Array.isArray(values)) continue;
    for (const value of values.slice(0, WebLaunchLimits.resultArtifacts)) {
      if (typeof value === 'string' && value.trim() && value.length <= 4096)
        sources.add(unwrapAssistantDeliverableSource(value.trim()));
    }
  }
  return sources;
}

/** History may remove a MEDIA directive that the whole-run terminal still shows. */
function terminalTextMatches(text: string, terminalText: string, nativeSources: Set<string>): boolean {
  if (!terminalText) return !text.trim();
  if (text === terminalText) return true;
  if (!nativeSources.size) return false;
  let removed = false;
  const visible = filterMediaDirectiveLines(terminalText, source => {
    const matched = nativeSources.has(unwrapAssistantDeliverableSource(source));
    if (matched) removed = true;
    return matched;
  });
  return removed && visible.trim() === text.trim();
}

function projectMedia(messages: Record<string, unknown>[], nativeSources = deliveryManifest(messages)) {
  const deliveries = new Map<string, WebLaunchArtifact>();
  // Only fragments already grouped by the same native message ID reach here.
  // Reunite the manifest with its managed blocks before choosing source aliases.
  const rows = nativeSources.size && messages.length > 1 ? [{
    ...messages[0],
    content: messages.flatMap(item => Array.isArray(item.content) ? item.content : []),
    openclawDelivery: { mediaUrls: [...nativeSources] },
    __openclaw: { media: messages.flatMap(item => {
      const media = record(item.__openclaw)?.media;
      return Array.isArray(media) ? media : [];
    }) },
  }] : messages;
  for (const message of rows) {
    for (const delivery of getAssistantDeliverables(message)) {
      if (deliveries.size === WebLaunchLimits.resultArtifacts) break;
      if (deliveries.has(delivery.source)) continue;
      const artifact = publicWebLaunchArtifact(delivery);
      if (artifact) deliveries.set(delivery.source, artifact);
    }
  }
  const artifacts = [...deliveries.values()];
  // The native alias is stable if a managed attachment block enriches this row
  // after chat.history. Without a manifest, retain full source identity.
  const mediaIdentity = nativeSources.size
    ? { sources: [...nativeSources].sort(), artifacts }
    : [...deliveries.entries()];
  return { artifacts, mediaDigest: webLaunchDigest(JSON.stringify(mediaIdentity)) };
}

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
    const nativeSources = deliveryManifest(group);
    if (!terminalTextMatches(text, terminalText, nativeSources)) return [];
    const { artifacts, mediaDigest } = projectMedia(group, nativeSources);
    if (!text.trim() && !artifacts.length) return [];
    return [{ messageId, text, digest: webLaunchDigest(text), mediaDigest }];
  });
  return matching.length === 1 ? matching[0] : null;
}

export interface WebLaunchResultCandidate {
  text?: string;
  disposition?: string;
  emptyWithReason?: boolean;
  agentSeq: number;
}
export interface WebLaunchFinalOutput {
  text?: string;
  artifacts?: WebLaunchArtifact[];
}
export interface WebLaunchResultRead {
  status: WebLaunchOutputStatus;
  output?: WebLaunchFinalOutput;
  reference?: WebLaunchResultReference;
}

export async function readWebLaunchFinal(options: {
  runtime: OpenClawRuntimeAdapter;
  client: GatewayClientLike;
  binding: WebLaunchNativeBinding;
  candidate?: WebLaunchResultCandidate;
  reference?: WebLaunchResultReference;
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
  const hasReference = Boolean(reference);
  if (!reference) {
    const candidate = options.candidate;
    const terminalText =
      candidate?.disposition === 'visible' && candidate.text ? candidate.text
        : candidate?.disposition === 'empty' && !candidate.emptyWithReason ? ''
        : undefined;
    if (terminalText === undefined) return { status: 'unavailable' };
    if (Buffer.byteLength(terminalText) > WebLaunchLimits.resultBytes) return { status: 'unsupported' };
    const history = await runtime.fetchSessionHistoryByKey(binding.sessionKey, undefined, { forceFullSnapshot: true, includePendingInputs: true });
    assertCurrent();
    await describe();
    if (!history) return { status: 'pending' };
    const selected = selectWebLaunchFinal(history.messages, binding.nativeRunId, terminalText);
    if (!selected) return { status: 'pending' };
    reference = { messageId: selected.messageId, digest: selected.digest, mediaDigest: selected.mediaDigest };
  }
  const raw = await client.request('chat.message.get', {
    sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId,
    messageId: reference.messageId, maxChars: WebLaunchLimits.resultBytes,
  });
  assertCurrent();
  await describe();
  const result = record(raw);
  const message = record(result?.message);
  if (result?.ok !== true || !message || message.role !== 'assistant' || message.display === false || idOf(message) !== reference.messageId
    || record(message.__openclaw)?.runId !== binding.nativeRunId || record(message.__openclaw)?.truncated === true
    || hasTool(message) || message.stopReason !== 'stop') return { status: 'unavailable' };
  const text = textOf(message);
  if (webLaunchDigest(text) !== reference.digest) return { status: 'unavailable' };
  if (Buffer.byteLength(text) > WebLaunchLimits.resultBytes) return { status: 'unsupported' };
  const { artifacts, mediaDigest } = projectMedia([message]);
  if (reference.mediaDigest !== undefined && reference.mediaDigest !== mediaDigest) {
    return { status: hasReference ? 'unavailable' : 'pending' };
  }
  if (!text.trim() && !artifacts.length) return { status: 'unavailable' };
  return {
    status: 'available',
    output: { ...(text.trim() ? { text } : {}), ...(artifacts.length ? { artifacts } : {}) },
    reference: { ...reference, mediaDigest },
  };
}
