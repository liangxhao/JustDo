import type { ChatTranscriptState, HistorySource } from './chat-transcript-state';
import { isLocallyOptimisticHistoryTail } from './optimistic-history-tail';
import { readTranscriptIdentity } from './transcript-identity';

export interface HistoryRequestIdentity {
  sessionKey: string;
  sessionId: string | null;
  historyGeneration: number;
}

export interface HistoryReconciliationResult {
  accepted: boolean;
  messages: unknown[];
  persistedToolCallIds: Set<string>;
  preservedOptimisticTailCount: number;
  activeTurnTakeover: 'retained' | 'retired';
  catchUp: 'none' | 'deferred';
  reason?:
    | 'stale-request'
    | 'lower-authority'
    | 'active-run'
    | 'materialized-fallback'
    | 'stale-concurrent-update'
    | 'regressive-tail';
}

const SOURCE_AUTHORITY: Record<HistorySource, number> = {
  optimistic: 0,
  gateway: 1,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageRole(message: unknown): string {
  const record = asRecord(message);
  return typeof record?.role === 'string' ? record.role.toLowerCase() : '';
}

function messageText(message: unknown): string {
  const record = asRecord(message);
  if (!record) return typeof message === 'string' ? message : '';
  if (typeof record.content === 'string') return record.content.trim();
  if (typeof record.text === 'string') return record.text.trim();
  if (!Array.isArray(record.content)) return '';
  return record.content
    .map(block => {
      const value = asRecord(block);
      return typeof value?.text === 'string' ? value.text : '';
    })
    .join('')
    .trim();
}

function messageTimestampMs(message: unknown): number | null {
  const record = asRecord(message);
  const timestamp = record?.timestamp ?? record?.ts;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : null;
}

function messageDisplaySignature(message: unknown): string | null {
  const role = messageRole(message);
  if (!role) return null;
  const text = messageText(message);
  if (text) return `${role}:text:${text}`;
  const record = asRecord(message);
  try {
    return `${role}:content:${JSON.stringify(record?.content ?? record?.text ?? null)}`;
  } catch {
    return null;
  }
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hasSimilarDisplayText(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return true;
  }
  const shorterLength = Math.min(normalizedLeft.length, normalizedRight.length);
  if (shorterLength < 60) return false;
  let prefixLength = 0;
  while (
    prefixLength < shorterLength &&
    normalizedLeft[prefixLength] === normalizedRight[prefixLength]
  ) {
    prefixLength += 1;
  }
  return prefixLength / shorterLength >= 0.8 || prefixLength >= 160;
}

function messagesDisplayEquivalent(left: unknown, right: unknown): boolean {
  const leftIdentity = readTranscriptIdentity(left);
  const rightIdentity = readTranscriptIdentity(right);
  if (leftIdentity && rightIdentity) {
    return leftIdentity.kind === rightIdentity.kind && leftIdentity.value === rightIdentity.value;
  }
  if (messageRole(left) !== messageRole(right)) return false;
  return hasSimilarDisplayText(messageText(left), messageText(right));
}

function isLikelyPersistedOptimisticReplacement(
  historyMessage: unknown,
  localMessage: unknown,
): boolean {
  if (!messagesDisplayEquivalent(historyMessage, localMessage)) return false;
  const historyTimestamp = messageTimestampMs(historyMessage);
  const localTimestamp = messageTimestampMs(localMessage);
  if (historyTimestamp == null || localTimestamp == null) return true;
  return Math.abs(historyTimestamp - localTimestamp) <= 10 * 60 * 1000;
}

function historyHasSameOrNewerMessage(historyMessages: unknown[], localMessage: unknown): boolean {
  const localTimestamp = messageTimestampMs(localMessage);
  const localIdentity = readTranscriptIdentity(localMessage);
  return historyMessages.some(historyMessage => {
    if (!messagesDisplayEquivalent(historyMessage, localMessage)) return false;
    const historyIdentity = readTranscriptIdentity(historyMessage);
    if (
      localIdentity &&
      historyIdentity &&
      localIdentity.kind === historyIdentity.kind &&
      localIdentity.value === historyIdentity.value
    ) {
      return true;
    }
    const historyTimestamp = messageTimestampMs(historyMessage);
    if (
      localTimestamp != null &&
      historyTimestamp != null &&
      historyTimestamp >=
        localTimestamp - (isLocallyOptimisticHistoryTail(localMessage) ? 60_000 : 10_000)
    ) {
      return true;
    }
    return (
      isLocallyOptimisticHistoryTail(localMessage) &&
      isLikelyPersistedOptimisticReplacement(historyMessage, localMessage)
    );
  });
}

function latestMessageTimestampMs(messages: unknown[]): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    const timestamp = messageTimestampMs(message);
    if (timestamp == null) continue;
    latest = latest == null ? timestamp : Math.max(latest, timestamp);
  }
  return latest;
}

function isNewerThanHistoryTail(message: unknown, latestHistoryTimestamp: number | null): boolean {
  if (latestHistoryTimestamp == null) return true;
  const timestamp = messageTimestampMs(message);
  return timestamp != null && timestamp >= latestHistoryTimestamp - 10_000;
}

function isProtectableOptimisticMessage(
  message: unknown,
  isVisibleMessage: (message: unknown) => boolean,
): boolean {
  return (
    isLocallyOptimisticHistoryTail(message) &&
    Boolean(messageDisplaySignature(message)) &&
    isVisibleMessage(message)
  );
}

function preserveOptimisticTailMessages(
  historyMessages: unknown[],
  previousMessages: unknown[],
  isVisibleMessage: (message: unknown) => boolean,
): unknown[] {
  if (previousMessages.length === 0) return historyMessages;
  if (historyMessages.length === 0) {
    const optimisticMessages = previousMessages.filter(message =>
      isProtectableOptimisticMessage(message, isVisibleMessage),
    );
    // An empty Gateway snapshot can be observed between chat.send and the
    // transcript append. Keep the whole locally known prefix when it owns any
    // optimistic tail; dropping the prefix would also detach that tail from
    // the conversation it belongs to.
    return optimisticMessages.length > 0 ? previousMessages : historyMessages;
  }

  let sharedPreviousIndex = -1;
  let sharedHistoryIndex = -1;
  for (let previousIndex = previousMessages.length - 1; previousIndex >= 0; previousIndex -= 1) {
    const historyIndex = historyMessages.findIndex(historyMessage =>
      messagesDisplayEquivalent(historyMessage, previousMessages[previousIndex]),
    );
    if (historyIndex >= 0) {
      sharedPreviousIndex = previousIndex;
      sharedHistoryIndex = historyIndex;
      break;
    }
  }

  const latestHistoryTimestamp = latestMessageTimestampMs(historyMessages);
  if (sharedPreviousIndex < 0 || sharedHistoryIndex < historyMessages.length - 1) {
    const optimisticTail = previousMessages.filter(
      message =>
        isProtectableOptimisticMessage(message, isVisibleMessage) &&
        isNewerThanHistoryTail(message, latestHistoryTimestamp) &&
        !historyHasSameOrNewerMessage(historyMessages, message),
    );
    return optimisticTail.length > 0 ? [...historyMessages, ...optimisticTail] : historyMessages;
  }

  const optimisticTail: unknown[] = [];
  for (const message of previousMessages.slice(sharedPreviousIndex + 1)) {
    if (!isProtectableOptimisticMessage(message, isVisibleMessage)) return historyMessages;
    if (!isNewerThanHistoryTail(message, latestHistoryTimestamp)) return historyMessages;
    if (historyHasSameOrNewerMessage(historyMessages, message)) return historyMessages;
    optimisticTail.push(message);
  }
  return optimisticTail.length > 0 ? [...historyMessages, ...optimisticTail] : historyMessages;
}

function restoreMissingOptimisticMessages(
  historyMessages: unknown[],
  previousMessages: unknown[],
  isVisibleMessage: (message: unknown) => boolean,
): unknown[] {
  const latestHistoryTimestamp = latestMessageTimestampMs(historyMessages);
  const missing = previousMessages.flatMap((message, previousIndex) =>
    isProtectableOptimisticMessage(message, isVisibleMessage) &&
    isNewerThanHistoryTail(message, latestHistoryTimestamp) &&
    !historyHasSameOrNewerMessage(historyMessages, message)
      ? [{ message, previousIndex }]
      : [],
  );
  if (missing.length === 0) return historyMessages;

  const restored = [...historyMessages];
  for (const { message, previousIndex } of missing) {
    const nextKnownMessage = previousMessages
      .slice(previousIndex + 1)
      .find(candidate => historyHasSameOrNewerMessage(restored, candidate));
    const nextKnownIndex = nextKnownMessage
      ? restored.findIndex(candidate => messagesDisplayEquivalent(candidate, nextKnownMessage))
      : -1;
    const timestamp = messageTimestampMs(message);
    const insertAt =
      nextKnownIndex >= 0
        ? nextKnownIndex
        : timestamp == null
          ? -1
          : restored.findIndex(candidate => {
              const candidateTimestamp = messageTimestampMs(candidate);
              return candidateTimestamp != null && candidateTimestamp > timestamp;
            });
    if (insertAt < 0) restored.push(message);
    else restored.splice(insertAt, 0, message);
  }
  return restored;
}

function collectLateOptimisticTailMessages(
  previousMessages: unknown[],
  currentMessages: unknown[],
  historyMessages: unknown[],
  isVisibleMessage: (message: unknown) => boolean,
): unknown[] {
  if (currentMessages === previousMessages || currentMessages.length <= previousMessages.length) {
    return [];
  }
  if (previousMessages.some((message, index) => currentMessages[index] !== message)) return [];

  const latestHistoryTimestamp = latestMessageTimestampMs(historyMessages);
  const lateTail: unknown[] = [];
  for (const message of currentMessages.slice(previousMessages.length)) {
    if (!isProtectableOptimisticMessage(message, isVisibleMessage)) return [];
    if (!isNewerThanHistoryTail(message, latestHistoryTimestamp)) return [];
    if (!historyHasSameOrNewerMessage(historyMessages, message)) lateTail.push(message);
  }
  return lateTail;
}

function hasConcurrentVisibleUpdate(
  historyMessages: unknown[],
  previousMessages: unknown[],
  currentMessages: unknown[],
  isVisibleMessage: (message: unknown) => boolean,
): boolean {
  if (currentMessages === previousMessages || currentMessages.length <= previousMessages.length) {
    return false;
  }
  if (previousMessages.some((message, index) => currentMessages[index] !== message)) return false;
  return currentMessages
    .slice(previousMessages.length)
    .some(
      message =>
        isVisibleMessage(message) && !historyHasSameOrNewerMessage(historyMessages, message),
    );
}

function isDisplayPrefixOfCurrent(historyMessages: unknown[], currentMessages: unknown[]): boolean {
  if (historyMessages.length === 0 || historyMessages.length >= currentMessages.length) {
    return false;
  }
  return historyMessages.every((message, index) =>
    messagesDisplayEquivalent(message, currentMessages[index]),
  );
}

function isStableIdentityPrefix(historyMessages: unknown[], currentMessages: unknown[]): boolean {
  return historyMessages.every((message, index) => {
    const historyIdentity = readTranscriptIdentity(message);
    const currentIdentity = readTranscriptIdentity(currentMessages[index]);
    return Boolean(
      historyIdentity &&
      currentIdentity &&
      historyIdentity.kind === currentIdentity.kind &&
      historyIdentity.value === currentIdentity.value,
    );
  });
}

function hasMissingProtectableTail(
  historyMessages: unknown[],
  currentMessages: unknown[],
  isVisibleMessage: (message: unknown) => boolean,
): boolean {
  return currentMessages.slice(historyMessages.length).some(message => {
    if (!isVisibleMessage(message)) return false;
    const record = asRecord(message);
    if (!isLocallyOptimisticHistoryTail(message) && !record?.__openclawStreamFallback) {
      return false;
    }
    return !historyHasSameOrNewerMessage(historyMessages, message);
  });
}

export function deterministicHistoryKey(message: unknown, index: number): string {
  const identity = readTranscriptIdentity(message);
  if (identity) return `history:${identity.kind}:${identity.value}`;
  const text = messageText(message);
  let hash = 2166136261;
  const source = `${messageRole(message)}\0${text}`;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `history:fallback:${(hash >>> 0).toString(36)}:${index}`;
}

export function extractToolCallIds(messages: unknown[]): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const key of ['toolCallId', 'tool_call_id', 'tool_use_id']) {
      const id = record[key];
      if (typeof id === 'string' && id) ids.add(id);
    }
    if (record.content !== value) visit(record.content);
    if (record.tool_calls !== value) visit(record.tool_calls);
  };
  messages.forEach(visit);
  return ids;
}

function isRegressive(
  previous: unknown[],
  next: unknown[],
  isVisibleMessage: (message: unknown) => boolean,
): boolean {
  if (next.length >= previous.length || next.length === 0) return false;
  if (!isDisplayPrefixOfCurrent(next, previous)) return false;
  if (isStableIdentityPrefix(next, previous)) return true;
  if (hasMissingProtectableTail(next, previous, isVisibleMessage)) return true;

  const latestNextTimestamp = latestMessageTimestampMs(next);
  const latestPreviousTimestamp = latestMessageTimestampMs(previous);
  if (
    latestNextTimestamp == null ||
    latestPreviousTimestamp == null ||
    latestPreviousTimestamp <= latestNextTimestamp + 10_000
  ) {
    return false;
  }
  return previous
    .slice(next.length)
    .some(message => isVisibleMessage(message) && !historyHasSameOrNewerMessage(next, message));
}

export function reconcileHistory(
  state: ChatTranscriptState,
  params: {
    request: HistoryRequestIdentity;
    source: HistorySource;
    messages: unknown[];
    requestStartMessages?: unknown[];
    currentMessages?: unknown[];
    activeRun?: boolean;
    isVisibleMessage?: (message: unknown) => boolean;
  },
): HistoryReconciliationResult {
  const currentMessages = params.currentMessages ?? state.persistedMessages;
  const requestStartMessages = params.requestStartMessages ?? currentMessages;
  const isVisibleMessage = params.isVisibleMessage ?? (() => true);
  const rejected = (
    reason: Exclude<HistoryReconciliationResult['reason'], undefined>,
    catchUp: HistoryReconciliationResult['catchUp'] = 'none',
  ): HistoryReconciliationResult => ({
    accepted: false,
    messages: currentMessages,
    persistedToolCallIds: extractToolCallIds(currentMessages),
    preservedOptimisticTailCount: 0,
    activeTurnTakeover: 'retained',
    catchUp,
    reason,
  });

  if (
    params.request.sessionKey !== state.sessionKey ||
    params.request.historyGeneration !== state.historyGeneration ||
    (params.request.sessionId && state.sessionId && params.request.sessionId !== state.sessionId)
  ) {
    return rejected('stale-request');
  }
  if (SOURCE_AUTHORITY[params.source] < SOURCE_AUTHORITY[state.historySource]) {
    return rejected('lower-authority');
  }
  if (params.activeRun) return rejected('active-run');
  if (
    params.messages.length === 0 &&
    currentMessages.some(message => Boolean(asRecord(message)?.__openclawStreamFallback))
  ) {
    return rejected('materialized-fallback', 'deferred');
  }

  let messages = preserveOptimisticTailMessages(
    params.messages,
    requestStartMessages,
    isVisibleMessage,
  );
  // Interrupted overlays can already be present while the immediately
  // preceding user prompt is still missing from Gateway history. Restore that
  // protected prompt at its chronological position instead of accepting a
  // transcript whose assistant result has lost its user turn.
  messages = restoreMissingOptimisticMessages(messages, requestStartMessages, isVisibleMessage);
  const lateOptimisticTail = collectLateOptimisticTailMessages(
    requestStartMessages,
    currentMessages,
    messages,
    isVisibleMessage,
  );
  if (lateOptimisticTail.length > 0) messages = [...messages, ...lateOptimisticTail];

  if (
    hasConcurrentVisibleUpdate(messages, requestStartMessages, currentMessages, isVisibleMessage)
  ) {
    return rejected('stale-concurrent-update', 'deferred');
  }
  if (params.source === 'gateway' && isRegressive(currentMessages, messages, isVisibleMessage)) {
    return rejected('regressive-tail', 'deferred');
  }

  state.persistedMessages = messages;
  state.historySource = params.source;
  state.revision += 1;
  let activeTurnTakeover: HistoryReconciliationResult['activeTurnTakeover'] = 'retained';
  if (
    state.activeTurn &&
    state.activeTurn.status !== 'running' &&
    !isLocallyOptimisticHistoryTail(messages[messages.length - 1])
  ) {
    state.activeTurn = null;
    state.revision += 1;
    activeTurnTakeover = 'retired';
  }
  return {
    accepted: true,
    messages,
    persistedToolCallIds: extractToolCallIds(messages),
    preservedOptimisticTailCount: messages.length - params.messages.length,
    activeTurnTakeover,
    catchUp: 'none',
  };
}
