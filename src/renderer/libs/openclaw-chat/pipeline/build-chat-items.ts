// Control UI chat module implements build chat items behavior.
import type { ChatItem, MessageGroup, NormalizedMessage, ToolCard } from '../types';
import type { ChatQueueItem } from '../types';
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from './heartbeat-display';
import { CHAT_HISTORY_RENDER_CHAR_BUDGET, CHAT_HISTORY_RENDER_LIMIT } from './history-limits';
import { extractTextCached } from './message-extract';
import { normalizeMessage, stripMessageDisplayMetadataText } from './message-normalizer';
import { normalizeRoleForGrouping } from './role-normalizer';
import { messageMatchesSearchQuery } from './search-match';
import { trimAccumulatedStreamPrefix } from './stream-text';
import { extractToolCardsCached, extractToolPreview } from './tool-cards';
import { buildUserChatMessageContentBlocks } from './user-message-content';

export type BuildChatItemsProps = {
  sessionKey: string;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: Array<{ text: string; ts: number }>;
  stream: string | null;
  streamStartedAt: number | null;
  queue?: ChatQueueItem[];
  showToolCalls: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
  historyRenderLimit?: number;
};

function appendCanvasBlockToAssistantMessage(
  message: unknown,
  preview: Extract<NonNullable<ToolCard['preview']>, { kind: 'canvas' }>,
  rawText: string | null,
) {
  const raw = message as Record<string, unknown>;
  const existingContent = Array.isArray(raw.content)
    ? [...raw.content]
    : typeof raw.content === 'string'
      ? [{ type: 'text', text: raw.content }]
      : typeof raw.text === 'string'
        ? [{ type: 'text', text: raw.text }]
        : [];
  const alreadyHasArtifact = existingContent.some(block => {
    if (!block || typeof block !== 'object') {
      return false;
    }
    const typed = block as {
      type?: unknown;
      preview?: { kind?: unknown; viewId?: unknown; url?: unknown };
    };
    return (
      typed.type === 'canvas' &&
      typed.preview?.kind === 'canvas' &&
      ((preview.viewId && typed.preview.viewId === preview.viewId) ||
        (preview.url && typed.preview.url === preview.url))
    );
  });
  if (alreadyHasArtifact) {
    return message;
  }
  return {
    ...raw,
    content: [
      ...existingContent,
      {
        type: 'canvas',
        preview,
        ...(rawText ? { rawText } : {}),
      },
    ],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeNormalizeMessage(message: unknown): NormalizedMessage | null {
  if (!asRecord(message)) {
    return null;
  }
  try {
    return normalizeMessage(message);
  } catch {
    return null;
  }
}

function extractChatMessagePreview(toolMessage: unknown): {
  preview: Extract<NonNullable<ToolCard['preview']>, { kind: 'canvas' }>;
  text: string | null;
  timestamp: number | null;
} | null {
  const normalized = safeNormalizeMessage(toolMessage);
  if (!normalized) {
    return null;
  }
  const cards = extractToolCardsCached(toolMessage, 'preview');
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (card?.preview?.kind === 'canvas') {
      return {
        preview: card.preview,
        text: card.outputText ?? null,
        timestamp: normalized.timestamp ?? null,
      };
    }
  }
  const text = extractTextCached(toolMessage) ?? undefined;
  const toolRecord = toolMessage as Record<string, unknown>;
  const toolName =
    typeof toolRecord.toolName === 'string'
      ? toolRecord.toolName
      : typeof toolRecord.tool_name === 'string'
        ? toolRecord.tool_name
        : undefined;
  const preview = extractToolPreview(text, toolName);
  if (preview?.kind !== 'canvas') {
    return null;
  }
  return { preview, text: text ?? null, timestamp: normalized.timestamp ?? null };
}

function findNearestAssistantMessageIndex(
  items: ChatItem[],
  toolTimestamp: number | null,
): number | null {
  const assistantEntries = items
    .map((item, index) => {
      if (item.kind !== 'message') {
        return null;
      }
      const message = item.message as Record<string, unknown>;
      const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
      if (role !== 'assistant') {
        return null;
      }
      return {
        index,
        timestamp: safeNormalizeMessage(item.message)?.timestamp ?? null,
      };
    })
    .filter(Boolean) as Array<{ index: number; timestamp: number | null }>;
  if (assistantEntries.length === 0) {
    return null;
  }
  if (toolTimestamp == null) {
    return assistantEntries[assistantEntries.length - 1]?.index ?? null;
  }
  let previous: { index: number; timestamp: number } | null = null;
  let next: { index: number; timestamp: number } | null = null;
  for (const entry of assistantEntries) {
    if (entry.timestamp == null) {
      continue;
    }
    if (entry.timestamp <= toolTimestamp) {
      previous = { index: entry.index, timestamp: entry.timestamp };
      continue;
    }
    next = { index: entry.index, timestamp: entry.timestamp };
    break;
  }
  if (previous && next) {
    const previousDelta = toolTimestamp - previous.timestamp;
    const nextDelta = next.timestamp - toolTimestamp;
    return nextDelta < previousDelta ? next.index : previous.index;
  }
  if (previous) {
    return previous.index;
  }
  if (next) {
    return next.index;
  }
  return assistantEntries[assistantEntries.length - 1]?.index ?? null;
}

function findPreviousAssistantMessageIndex(
  items: ChatItem[],
  toolTimestamp: number | null,
): number | null {
  let fallbackIndex: number | null = null;
  let previousIndex: number | null = null;
  let previousTimestamp = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind !== 'message') {
      continue;
    }
    const message = item.message as Record<string, unknown>;
    const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
    if (role !== 'assistant') {
      continue;
    }
    fallbackIndex = index;
    if (toolTimestamp == null) {
      continue;
    }
    const timestamp = safeNormalizeMessage(item.message)?.timestamp ?? null;
    if (timestamp != null && timestamp <= toolTimestamp && timestamp >= previousTimestamp) {
      previousIndex = index;
      previousTimestamp = timestamp;
    }
  }

  return previousIndex ?? fallbackIndex;
}

function getAttachedToolMessages(message: unknown): unknown[] {
  const attached = asRecord(message)?.__justdoAttachedToolMessages;
  return Array.isArray(attached) ? attached : [];
}

function extractToolCallId(message: unknown): string | null {
  const raw = asRecord(message);
  if (!raw) {
    return null;
  }
  const direct = [
    raw.toolCallId,
    raw.tool_call_id,
    raw.toolUseId,
    raw.tool_use_id,
  ].find(value => typeof value === 'string' && value.trim()) as string | undefined;
  if (direct) {
    return direct.trim();
  }

  const content = Array.isArray(raw.content) ? raw.content : [];
  for (const block of content) {
    const item = asRecord(block);
    if (!item) {
      continue;
    }
    const nested = [item.toolCallId, item.tool_call_id, item.toolUseId, item.tool_use_id, item.id]
      .find(value => typeof value === 'string' && value.trim()) as string | undefined;
    if (nested) {
      return nested.trim();
    }
  }
  return null;
}

function findAssistantWithAttachedToolIndex(items: ChatItem[], toolMessage: unknown): number | null {
  const toolCallId = extractToolCallId(toolMessage);
  if (!toolCallId) {
    return null;
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind !== 'message') {
      continue;
    }
    const attached = getAttachedToolMessages(item.message);
    if (attached.some(message => extractToolCallId(message) === toolCallId)) {
      return index;
    }
  }
  return null;
}

function findAssistantWithToolCallContentIndex(items: ChatItem[], toolMessage: unknown): number | null {
  const toolCallId = extractToolCallId(toolMessage);
  if (!toolCallId) {
    return null;
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind !== 'message') {
      continue;
    }
    const raw = asRecord(item.message);
    if (!raw || typeof raw.role !== 'string' || raw.role.toLowerCase() !== 'assistant') {
      continue;
    }
    const content = Array.isArray(raw.content) ? raw.content : [];
    const hasMatchingToolCall = content.some(block => {
      const itemRecord = asRecord(block);
      if (!itemRecord) return false;
      const type = typeof itemRecord.type === 'string' ? itemRecord.type.toLowerCase() : '';
      if (!['toolcall', 'tool_call', 'tooluse', 'tool_use'].includes(type)) return false;
      const nestedId = [
        itemRecord.id,
        itemRecord.toolCallId,
        itemRecord.tool_call_id,
        itemRecord.toolUseId,
        itemRecord.tool_use_id,
      ].find(value => typeof value === 'string' && value.trim()) as string | undefined;
      return nestedId?.trim() === toolCallId;
    });
    if (hasMatchingToolCall) {
      return index;
    }
  }
  return null;
}

function hasActiveToolTimeline(toolMessages: unknown[]): boolean {
  const activeByToolId = new Map<string, boolean>();
  let anonymousActive = false;

  for (const message of toolMessages) {
    const toolCallId = extractToolCallId(message);
    const isActive = isLiveToolMessage(message);
    if (toolCallId) {
      activeByToolId.set(toolCallId, isActive);
    } else if (isActive) {
      anonymousActive = true;
    }
  }

  return anonymousActive || [...activeByToolId.values()].some(Boolean);
}

function withAttachedToolMessage(
  message: unknown,
  toolMessage: unknown,
  options: { keepTimelineOpen?: boolean } = {},
): unknown {
  const raw = asRecord(message) ?? {};
  const { __justdoToolTimelineOpen: _ignoredTimelineOpen, ...rest } = raw;
  const attachedToolMessages = [...getAttachedToolMessages(raw), toolMessage];
  const keepTimelineOpen =
    options.keepTimelineOpen === true || hasActiveToolTimeline(attachedToolMessages);
  return {
    ...rest,
    __justdoAttachedToolMessages: attachedToolMessages,
    ...(keepTimelineOpen ? { __justdoToolTimelineOpen: true } : {}),
  };
}

function attachToolToAssistantAtIndex(
  items: ChatItem[],
  assistantIndex: number,
  toolMessage: unknown,
  options: { keepTimelineOpen?: boolean } = {},
): boolean {
  const item = items[assistantIndex];
  if (item?.kind !== 'message') {
    return false;
  }
  items[assistantIndex] = {
    ...item,
    message: withAttachedToolMessage(item.message, toolMessage, options),
  };
  return true;
}

function withStreamToolMessage(item: Extract<ChatItem, { kind: 'stream' }>, toolMessage: unknown) {
  return {
    ...item,
    toolMessages: [...(item.toolMessages ?? []), toolMessage],
  };
}

function isLiveToolMessage(toolMessage: unknown): boolean {
  return asRecord(toolMessage)?.__justdoToolActive === true;
}

function isToolMessageRole(message: unknown): boolean {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return false;
  }
  if (normalizeRoleForGrouping(normalized.role).toLowerCase() === 'tool') {
    return true;
  }

  const raw = asRecord(message);
  if (!raw) {
    return false;
  }
  const role = typeof raw?.role === 'string' ? raw.role.toLowerCase() : '';
  if (role !== 'assistant') {
    return false;
  }
  const content = Array.isArray(raw.content) ? raw.content : [];
  if (content.length === 0) {
    return false;
  }
  let hasToolBlock = false;
  for (const block of content) {
    const item = asRecord(block);
    if (!item) {
      continue;
    }
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
    if (['toolcall', 'tool_call', 'tooluse', 'tool_use', 'toolresult', 'tool_result'].includes(type)) {
      hasToolBlock = true;
      continue;
    }
    if (type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      return false;
    }
    if (type === 'thinking' && typeof item.thinking === 'string' && item.thinking.trim()) {
      return false;
    }
  }
  return hasToolBlock;
}

function appendSyntheticAssistantToolMessage(
  items: ChatItem[],
  toolMessage: unknown,
  options: { keepTimelineOpen?: boolean } = {},
): void {
  const normalized = safeNormalizeMessage(toolMessage);
  items.push({
    kind: 'message',
    key: `assistant-tools:${messageKey(toolMessage, items.length)}`,
    message: {
      role: 'assistant',
      content: [],
      timestamp: normalized?.timestamp ?? Date.now(),
      __justdoAttachedToolMessages: [toolMessage],
      ...(options.keepTimelineOpen ? { __justdoToolTimelineOpen: true } : {}),
    },
  });
}

function attachToolToNearestAssistant(items: ChatItem[], toolMessage: unknown): void {
  const existingToolIndex = findAssistantWithAttachedToolIndex(items, toolMessage);
  if (
    existingToolIndex != null &&
    attachToolToAssistantAtIndex(items, existingToolIndex, toolMessage)
  ) {
    return;
  }

  const ownerToolIndex = findAssistantWithToolCallContentIndex(items, toolMessage);
  if (
    ownerToolIndex != null &&
    attachToolToAssistantAtIndex(items, ownerToolIndex, toolMessage)
  ) {
    return;
  }

  const timestamp = safeNormalizeMessage(toolMessage)?.timestamp ?? null;
  const assistantIndex = findPreviousAssistantMessageIndex(items, timestamp);
  if (assistantIndex == null) {
    appendSyntheticAssistantToolMessage(items, toolMessage);
    return;
  }
  if (!attachToolToAssistantAtIndex(items, assistantIndex, toolMessage)) {
    appendSyntheticAssistantToolMessage(items, toolMessage);
  }
}

function attachLiveToolToVisibleTail(items: ChatItem[], toolMessage: unknown): void {
  const keepTimelineOpen = isLiveToolMessage(toolMessage);
  const existingToolIndex = findAssistantWithAttachedToolIndex(items, toolMessage);
  if (
    existingToolIndex != null &&
    attachToolToAssistantAtIndex(items, existingToolIndex, toolMessage, { keepTimelineOpen })
  ) {
    return;
  }

  const timestamp = safeNormalizeMessage(toolMessage)?.timestamp ?? null;
  const assistantIndex = findPreviousAssistantMessageIndex(items, timestamp);
  if (
    assistantIndex != null &&
    attachToolToAssistantAtIndex(items, assistantIndex, toolMessage, { keepTimelineOpen })
  ) {
    return;
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    if (item.kind === 'stream') {
      items[index] = withStreamToolMessage(item, toolMessage);
      return;
    }
    if (item.kind === 'message') {
      const raw = asRecord(item.message);
      if (raw?.__justdoToolTimelineOpen === true) {
        items[index] = {
          ...item,
          message: withAttachedToolMessage(item.message, toolMessage, { keepTimelineOpen }),
        };
        return;
      }
    }
  }
  appendSyntheticAssistantToolMessage(items, toolMessage, { keepTimelineOpen });
}

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== 'message') {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const modelName = role.toLowerCase() === 'assistant' ? (normalized.modelName ?? null) : null;
    const senderLabel =
      role.toLowerCase() === 'user' || role.toLowerCase() === 'assistant'
        ? (modelName ?? normalized.senderLabel ?? null)
        : null;
    const timestamp = normalized.timestamp || Date.now();
    const shouldSplitBySender = role.toLowerCase() === 'user' || role.toLowerCase() === 'assistant';
    const activeGroup = currentGroup as MessageGroup | null;
    const assistantBlockKind =
      role.toLowerCase() === 'assistant' ? resolveAssistantGroupingBlockKind(item.message) : null;
    const currentAssistantBlockKind =
      activeGroup?.role.toLowerCase() === 'assistant'
        ? resolveAssistantGroupingBlockKind(
            activeGroup.messages[activeGroup.messages.length - 1]?.message,
          )
        : null;
    const shouldSplitByAssistantBlock =
      role.toLowerCase() === 'assistant' &&
      activeGroup?.role === role &&
      (assistantBlockKind !== currentAssistantBlockKind || assistantBlockKind !== 'text');
    const toolBlockKey =
      role.toLowerCase() === 'tool' ? resolveToolGroupingBlockKey(item.message) : null;
    const currentToolBlockKey =
      activeGroup?.role.toLowerCase() === 'tool'
        ? resolveToolGroupingBlockKey(
            activeGroup.messages[activeGroup.messages.length - 1]?.message,
          )
        : null;
    const shouldSplitByToolBlock =
      role.toLowerCase() === 'tool' &&
      activeGroup?.role === role &&
      (toolBlockKey !== currentToolBlockKey || Boolean(toolBlockKey));

    if (
      !currentGroup ||
      currentGroup.role !== role ||
      (shouldSplitBySender && currentGroup.senderLabel !== senderLabel) ||
      shouldSplitByAssistantBlock ||
      shouldSplitByToolBlock
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: 'group',
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        modelName,
        messages: [{ message: item.message, key: item.key, duplicateCount: item.duplicateCount }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({
        message: item.message,
        key: item.key,
        duplicateCount: item.duplicateCount,
      });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function isPendingSendMessage(message: unknown): boolean {
  return asRecord(asRecord(message)?.['__openclaw'])?.kind === 'pending-send';
}

function sourceMessageId(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) {
    return null;
  }
  const openclawId = asRecord(record['__openclaw'])?.id;
  if (typeof openclawId === 'string' && openclawId.trim()) {
    return openclawId.trim();
  }
  const messageId = typeof record.messageId === 'string' ? record.messageId.trim() : '';
  if (messageId) {
    return messageId;
  }
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  return id || null;
}

function collapseDuplicateSourceKey(message: unknown): string | null {
  if (isPendingSendMessage(message)) {
    return null;
  }
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return null;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (role !== 'assistant') {
    return null;
  }
  const id = sourceMessageId(message);
  return id ? `${role}:${id}` : null;
}

function prefersNativeChatSurface(message: unknown): boolean {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return false;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  return (role === 'user' || role === 'assistant') && !(normalized.senderLabel ?? '').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripSenderLabelPrefix(text: string, senderLabel: string): string {
  const label = senderLabel.trim();
  if (!label) {
    return text;
  }
  return text.replace(new RegExp(`^${escapeRegExp(label)}(?::|：|-|—)?[ \\t]+`), '');
}

function sourceDuplicateDisplayParts(message: unknown): {
  role: string;
  senderLabel: string;
  text: string;
} | null {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return null;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (role !== 'assistant') {
    return null;
  }
  const textParts: string[] = [];
  for (const block of normalized.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      return null;
    }
    textParts.push(block.text);
  }
  const text = textParts.join('\n');
  if (!text.trim()) {
    return null;
  }
  return {
    role,
    senderLabel: (normalized.senderLabel ?? '').trim(),
    text,
  };
}

function isSameSourceRelayNativeDuplicate(previousMessage: unknown, nextMessage: unknown): boolean {
  const previous = sourceDuplicateDisplayParts(previousMessage);
  const next = sourceDuplicateDisplayParts(nextMessage);
  if (!previous || !next || previous.role !== next.role) {
    return false;
  }
  if (Boolean(previous.senderLabel) === Boolean(next.senderLabel)) {
    return false;
  }
  const labeled = previous.senderLabel ? previous : next;
  const native = previous.senderLabel ? next : previous;
  return (
    labeled.text === native.text ||
    stripSenderLabelPrefix(labeled.text, labeled.senderLabel) === native.text
  );
}

function collapseDuplicateDisplaySignature(message: unknown): string | null {
  if (isPendingSendMessage(message)) {
    return null;
  }
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return null;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (!role || role === 'tool') {
    return null;
  }
  if (normalized.content.length === 0) {
    return null;
  }
  const textParts: string[] = [];
  for (const block of normalized.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      return null;
    }
    textParts.push(block.text);
  }
  const text = textParts.join('\n').trim().replace(/\s+/g, ' ');
  if (!text) {
    return null;
  }
  const senderLabel =
    role === 'user' || role === 'assistant' ? (normalized.senderLabel ?? '').trim() : '';
  return `${role}:${senderLabel}:${text}`;
}

function collapseSequentialDuplicateMessages(items: ChatItem[]): ChatItem[] {
  const collapsed: ChatItem[] = [];
  let previousSignature: string | null = null;
  let previousSourceKey: string | null = null;

  for (const item of items) {
    if (item.kind !== 'message') {
      collapsed.push(item);
      previousSignature = null;
      previousSourceKey = null;
      continue;
    }
    const signature = collapseDuplicateDisplaySignature(item.message);
    const sourceKey = collapseDuplicateSourceKey(item.message);
    const previous = collapsed[collapsed.length - 1];
    if (
      sourceKey &&
      previousSourceKey === sourceKey &&
      previous?.kind === 'message' &&
      isSameSourceRelayNativeDuplicate(previous.message, item.message)
    ) {
      if (!prefersNativeChatSurface(previous.message) && prefersNativeChatSurface(item.message)) {
        collapsed[collapsed.length - 1] = item;
        previousSignature = signature;
      }
      continue;
    }
    if (
      signature &&
      previousSignature === signature &&
      previous?.kind === 'message' &&
      !(sourceKey && previousSourceKey && sourceKey !== previousSourceKey)
    ) {
      previous.duplicateCount = (previous.duplicateCount ?? 1) + 1;
      continue;
    }
    collapsed.push(item);
    previousSignature = signature;
    previousSourceKey = sourceKey;
  }

  return collapsed;
}

function hasRenderableNormalizedMessage(message: unknown): boolean {
  if (getAttachedToolMessages(message).length > 0) {
    return true;
  }
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return false;
  }
  const role = normalizeRoleForGrouping(normalized.role);
  const hasVisibleSenderLabel = role === 'assistant' && Boolean(normalized.senderLabel?.trim());
  return normalized.content.length > 0 || Boolean(normalized.replyTarget) || hasVisibleSenderLabel;
}

function sanitizeStreamText(text: string): string {
  const stripped = stripMessageDisplayMetadataText(text);
  return stripped.trim().length > 0 ? stripped : '';
}

function shouldRenderQueuedSendInThread(item: ChatQueueItem): boolean {
  if (typeof item.sendSubmittedAtMs !== 'number' || item.sendState === 'failed') {
    return false;
  }
  return (
    item.sendState === 'waiting-model' ||
    item.sendState === 'sending' ||
    item.sendState === 'waiting-reconnect'
  );
}

function queuedSendThreadMessage(item: ChatQueueItem): Record<string, unknown> | null {
  const content = buildUserChatMessageContentBlocks(item.text, item.attachments);
  if (content.length === 0) {
    return null;
  }
  return {
    role: 'user',
    content,
    timestamp: item.createdAt,
    __openclaw: {
      kind: 'pending-send',
      id: item.id,
      state: item.sendState,
    },
  };
}

function rawMessageTimestamp(message: unknown): number | null {
  const timestamp = asRecord(message)?.timestamp;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : null;
}

function chatItemTimestamp(item: ChatItem): number | null {
  switch (item.kind) {
    case 'message':
      return item.key === 'chat:history:notice'
        ? Number.NEGATIVE_INFINITY
        : rawMessageTimestamp(item.message);
    case 'divider':
      return item.timestamp;
    case 'stream':
      return item.startedAt;
    case 'reading-indicator':
      return null;
  }
  return null;
}

function timestampAfterVisibleItems(items: ChatItem[], desiredTimestamp: number): number {
  const latestTimestamp = items.reduce<number | null>((latest, item) => {
    const timestamp = chatItemTimestamp(item);
    if (timestamp == null) {
      return latest;
    }
    return latest == null || timestamp > latest ? timestamp : latest;
  }, null);
  return latestTimestamp != null && desiredTimestamp <= latestTimestamp
    ? latestTimestamp + 1
    : desiredTimestamp;
}

function sortChatItemsByVisibleTime(items: ChatItem[]): ChatItem[] {
  return items
    .map((item, index) => ({ item, index, timestamp: chatItemTimestamp(item) }))
    .slice()
    .sort(
      (
        a: { item: ChatItem; index: number; timestamp: number | null },
        b: { item: ChatItem; index: number; timestamp: number | null },
      ) => {
        if (a.timestamp == null && b.timestamp == null) {
          return a.index - b.index;
        }
        if (a.timestamp == null) {
          return 1;
        }
        if (b.timestamp == null) {
          return -1;
        }
        if (a.timestamp !== b.timestamp) {
          return a.timestamp - b.timestamp;
        }
        return a.index - b.index;
      },
    )
    .map(({ item }) => item);
}

type RawContentEstimateState = {
  visited: WeakSet<object>;
  nodes: number;
};

const RAW_CONTENT_ESTIMATE_MAX_DEPTH = 8;
const RAW_CONTENT_ESTIMATE_MAX_NODES = 400;

function addCapped(total: number, amount: number, limit: number): number {
  return Math.min(limit, total + Math.max(0, amount));
}

function estimateRawContentChars(
  value: unknown,
  limit: number,
  state: RawContentEstimateState,
  depth = 0,
): number {
  if (limit <= 0) {
    return 0;
  }
  if (typeof value === 'string') {
    return Math.min(value.length, limit);
  }
  if (!value || typeof value !== 'object') {
    return 0;
  }
  if (depth >= RAW_CONTENT_ESTIMATE_MAX_DEPTH || state.nodes >= RAW_CONTENT_ESTIMATE_MAX_NODES) {
    return 0;
  }
  if (state.visited.has(value)) {
    return 0;
  }
  state.visited.add(value);
  state.nodes += 1;

  if (Array.isArray(value)) {
    let chars = 0;
    for (const item of value) {
      chars = addCapped(
        chars,
        estimateRawContentChars(item, limit - chars, state, depth + 1),
        limit,
      );
      if (chars >= limit) {
        break;
      }
    }
    return chars;
  }

  const record = value as Record<string, unknown>;
  let chars = 0;
  for (const key of ['text', 'content', 'args', 'arguments', 'input'] as const) {
    chars = addCapped(
      chars,
      estimateRawContentChars(record[key], limit - chars, state, depth + 1),
      limit,
    );
    if (chars >= limit) {
      break;
    }
  }
  return chars;
}

function estimateMessageRenderChars(message: unknown, limit: number): number {
  const record = asRecord(message);
  if (!record) {
    return 1;
  }
  const state: RawContentEstimateState = { visited: new WeakSet<object>(), nodes: 0 };
  let chars = 0;
  for (const key of ['content', 'text', 'args', 'arguments', 'input'] as const) {
    chars = addCapped(chars, estimateRawContentChars(record[key], limit - chars, state), limit);
    if (chars >= limit) {
      break;
    }
  }
  return Math.max(chars, 1);
}

function isHiddenToolMessage(message: unknown, showToolCalls: boolean): boolean {
  if (showToolCalls) {
    return false;
  }
  return safeNormalizeMessage(message)?.role.toLowerCase() === 'toolresult';
}

function countVisibleHistoryMessages(messages: unknown[], showToolCalls: boolean): number {
  let count = 0;
  for (const message of messages) {
    if (!isHiddenToolMessage(message, showToolCalls)) {
      count += 1;
    }
  }
  return count;
}

function resolveHistoryRenderLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return CHAT_HISTORY_RENDER_LIMIT;
  }
  return Math.max(1, Math.min(CHAT_HISTORY_RENDER_LIMIT, Math.floor(limit)));
}

function resolveHistoryStartIndex(
  messages: unknown[],
  showToolCalls: boolean,
  renderLimit: number,
): number {
  let visibleCount = 0;
  let renderChars = 0;
  let startIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isHiddenToolMessage(message, showToolCalls)) {
      continue;
    }
    if (visibleCount >= renderLimit) {
      break;
    }
    const remainingBudget = Math.max(1, CHAT_HISTORY_RENDER_CHAR_BUDGET - renderChars + 1);
    const messageChars = estimateMessageRenderChars(message, remainingBudget);
    if (visibleCount > 0 && renderChars + messageChars > CHAT_HISTORY_RENDER_CHAR_BUDGET) {
      break;
    }
    renderChars += messageChars;
    visibleCount += 1;
    startIndex = index;
  }
  return startIndex;
}

function enrichToolResultsWithInputs(messages: unknown[]): unknown[] {
  const calls = new Map<string, { name?: string; input: unknown }>();

  const hasMeaningfulToolInput = (value: unknown): boolean => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim().length > 0 && value.trim() !== '{}';
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  };

  const coerceToolInput = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  };

  const resolveToolInput = (source: Record<string, unknown>): unknown => {
    for (const value of [source.toolInput, source.tool_input, source.arguments, source.args, source.input]) {
      const coerced = coerceToolInput(value);
      if (hasMeaningfulToolInput(coerced)) return coerced;
    }
    return coerceToolInput(source.partialArgs);
  };

  const unwrapHistoryEnvelope = (message: unknown): Record<string, unknown> | null => {
    const raw = asRecord(message);
    if (!raw) return null;
    const nested = asRecord(raw.message);
    return nested ?? raw;
  };

  for (const message of messages) {
    const raw = unwrapHistoryEnvelope(message);
    if (!raw) continue;

    const directToolUseId = [raw.toolCallId, raw.tool_call_id, raw.toolUseId, raw.tool_use_id].find(
      value => typeof value === 'string' && value.trim(),
    ) as string | undefined;
    const metadata = asRecord(raw.metadata);
    const metadataToolUseId = [
      metadata?.toolCallId,
      metadata?.tool_call_id,
      metadata?.toolUseId,
      metadata?.tool_use_id,
    ].find(value => typeof value === 'string' && value.trim()) as string | undefined;
    const directId = directToolUseId ?? metadataToolUseId;
    const directInput = resolveToolInput({
      ...raw,
      ...(metadata ?? {}),
    });
    if (directId && directInput !== undefined) {
      calls.set(directId, {
        name:
          typeof raw.toolName === 'string'
            ? raw.toolName
            : typeof raw.tool_name === 'string'
              ? raw.tool_name
              : typeof metadata?.toolName === 'string'
                ? metadata.toolName
                : typeof metadata?.tool_name === 'string'
                  ? metadata.tool_name
                  : undefined,
        input: directInput,
      });
    }

    if (!Array.isArray(raw.content)) continue;
    for (const block of raw.content) {
      const item = asRecord(block);
      if (!item) continue;
      const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
      if (!['toolcall', 'tool_call', 'tooluse', 'tool_use'].includes(type)) continue;
      const id = [item.id, item.toolCallId, item.tool_call_id, item.tool_use_id].find(
        value => typeof value === 'string' && value.trim(),
      ) as string | undefined;
      if (!id) continue;
      calls.set(id, {
        name: typeof item.name === 'string' ? item.name : undefined,
        input: resolveToolInput(item),
      });
    }
  }

  return messages.map(message => {
    const raw = asRecord(message);
    if (!raw) return message;
    const nested = asRecord(raw.message);
    const target = nested ?? raw;
    const id = [target.toolCallId, target.tool_call_id, target.toolUseId, target.tool_use_id].find(
      value => typeof value === 'string' && value.trim(),
    ) as string | undefined;
    const call = id ? calls.get(id) : undefined;
    if (!call || target.toolInput !== undefined || target.tool_input !== undefined) return message;
    if (nested) {
      return {
        ...raw,
        message: {
          ...nested,
          toolName: nested.toolName ?? nested.tool_name ?? call.name,
          toolInput: call.input,
        },
      };
    }
    return {
      ...raw,
      toolName: raw.toolName ?? raw.tool_name ?? call.name,
      toolInput: call.input,
    };
  });
}

export function buildChatItems(props: BuildChatItemsProps): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const historyRenderLimit = resolveHistoryRenderLimit(props.historyRenderLimit);
  const history = enrichToolResultsWithInputs(
    (Array.isArray(props.messages) ? props.messages : []).filter(
      message => !isAssistantHeartbeatAckForDisplay(message),
    ),
  );
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const segments = props.streamSegments ?? [];

  const liftedCanvasSources = tools
    .map(tool => extractChatMessagePreview(tool))
    .filter(entry => Boolean(entry)) as Array<{
    preview: Extract<NonNullable<ToolCard['preview']>, { kind: 'canvas' }>;
    text: string | null;
    timestamp: number | null;
  }>;
  const historyStart = resolveHistoryStartIndex(history, props.showToolCalls, historyRenderLimit);
  const hiddenHistoryCount = countVisibleHistoryMessages(
    history.slice(0, historyStart),
    props.showToolCalls,
  );
  const visibleHistoryCount = countVisibleHistoryMessages(
    history.slice(historyStart),
    props.showToolCalls,
  );
  if (hiddenHistoryCount > 0) {
    items.push({
      kind: 'message',
      key: 'chat:history:notice',
      message: {
        role: 'system',
        content: `Showing last ${visibleHistoryCount} messages (${hiddenHistoryCount} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = safeNormalizeMessage(msg);
    if (!normalized) {
      continue;
    }
    const raw = asRecord(msg) ?? {};
    const marker = raw['__openclaw'] as Record<string, unknown> | undefined;
    if (marker && marker.kind === 'compaction') {
      items.push({
        kind: 'divider',
        key:
          typeof marker.id === 'string'
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: 'Compacted history',
        description:
          'The compacted transcript is preserved as a checkpoint. Open session checkpoints to branch or restore from that compacted view.',
        action: {
          kind: 'session-checkpoints',
          label: 'Open checkpoints',
        },
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (isToolMessageRole(msg)) {
      if (props.showToolCalls) {
        attachToolToNearestAssistant(items, msg);
      }
      continue;
    }

    const searchQuery = props.searchQuery ?? '';
    if (props.searchOpen && searchQuery.trim() && !messageMatchesSearchQuery(msg, searchQuery)) {
      continue;
    }
    if (!hasRenderableNormalizedMessage(msg) && normalized.role.toLowerCase() !== 'assistant') {
      continue;
    }

    items.push({
      kind: 'message',
      key: messageKey(msg, i),
      message: msg,
    });
  }
  const queuedSends = Array.isArray(props.queue) ? props.queue : [];
  for (const queued of queuedSends) {
    if (!shouldRenderQueuedSendInThread(queued)) {
      continue;
    }
    const message = queuedSendThreadMessage(queued);
    if (!message) {
      continue;
    }
    const searchQuery = props.searchQuery ?? '';
    if (
      props.searchOpen &&
      searchQuery.trim() &&
      !messageMatchesSearchQuery(message, searchQuery)
    ) {
      continue;
    }
    items.push({
      kind: 'message',
      key: `pending-send:${queued.id}`,
      message,
    });
  }
  for (const liftedCanvasSource of liftedCanvasSources) {
    const assistantIndex = findNearestAssistantMessageIndex(items, liftedCanvasSource.timestamp);
    if (assistantIndex == null) {
      continue;
    }
    const item = items[assistantIndex];
    if (!item || item.kind !== 'message') {
      continue;
    }
    items[assistantIndex] = {
      ...item,
      message: appendCanvasBlockToAssistantMessage(
        item.message as Record<string, unknown>,
        liftedCanvasSource.preview,
        liftedCanvasSource.text,
      ),
    };
  }
  items = items.filter(
    item => item.kind !== 'message' || hasRenderableNormalizedMessage(item.message),
  );
  const maxLen = Math.max(segments.length, tools.length);
  let previousAccumulatedStreamText: string | null = null;
  for (let i = 0; i < maxLen; i++) {
    if (i < segments.length) {
      const text = sanitizeStreamText(segments[i].text);
      const visibleText = trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText);
      if (text.length > 0) {
        previousAccumulatedStreamText = text;
      }
      if (visibleText.length > 0) {
        items.push({
          kind: 'message',
          key: `stream-seg:${props.sessionKey}:${i}`,
          message: {
            role: 'assistant',
            content: visibleText,
            timestamp: segments[i].ts,
          },
        });
      }
    }
    if (i < tools.length && props.showToolCalls) {
      attachLiveToolToVisibleTail(items, tools[i]);
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? 'live'}`;
    const text = sanitizeStreamText(props.stream);
    const visibleText = trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText);
    const startedAt = timestampAfterVisibleItems(items, props.streamStartedAt ?? Date.now());
    if (visibleText.length > 0) {
      if (!stripHeartbeatTokenForDisplay(visibleText).shouldSkip) {
        items.push({
          kind: 'stream',
          key,
          text: visibleText,
          startedAt,
          isStreaming: true,
        });
      }
    } else if (props.stream.trim().length === 0) {
      items.push({
        kind: 'stream',
        key,
        text: '',
        startedAt,
        isStreaming: true,
      });
    }
  }

  const collapsed = collapseSequentialDuplicateMessages(sortChatItemsByVisibleTime(items));
  const result = groupMessages(collapsed);

  return result;
}

function resolveAssistantGroupingBlockKind(
  message: unknown,
): 'text' | 'thinking' | 'tool' | 'mixed' {
  const raw = asRecord(message);
  if (!raw) return 'text';
  if (raw.__openclawLiveThinking === true) return 'thinking';
  if (typeof raw.toolCallId === 'string' || typeof raw.tool_call_id === 'string') return 'tool';

  const content = raw.content;
  if (!Array.isArray(content)) return 'text';

  let hasText = false;
  let hasThinking = false;
  let hasTool = false;
  for (const block of content) {
    const item = asRecord(block);
    if (!item) continue;
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
    if (type === 'thinking') {
      hasThinking = true;
    } else if (
      ['toolcall', 'tool_call', 'tooluse', 'tool_use', 'toolresult', 'tool_result'].includes(type)
    ) {
      hasTool = true;
    } else if (type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      hasText = true;
    }
  }

  const blockKinds = Number(hasText) + Number(hasThinking) + Number(hasTool);
  if (blockKinds > 1) return 'mixed';
  if (hasThinking) return 'thinking';
  if (hasTool) return 'tool';
  return 'text';
}

function resolveToolGroupingBlockKey(message: unknown): string | null {
  const raw = asRecord(message);
  if (!raw) return null;
  const toolCallId =
    typeof raw.toolCallId === 'string'
      ? raw.toolCallId
      : typeof raw.tool_call_id === 'string'
        ? raw.tool_call_id
        : '';
  if (toolCallId.trim()) return toolCallId.trim();
  const toolName =
    typeof raw.toolName === 'string'
      ? raw.toolName
      : typeof raw.tool_name === 'string'
        ? raw.tool_name
        : '';
  const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : null;
  return toolName.trim() && timestamp != null ? `${toolName.trim()}:${timestamp}` : null;
}

function messageKey(message: unknown, index: number): string {
  const m = asRecord(message) ?? {};
  const toolCallId = typeof m.toolCallId === 'string' ? m.toolCallId : '';
  if (toolCallId) {
    const role = typeof m.role === 'string' ? m.role : 'unknown';
    const id = typeof m.id === 'string' ? m.id : '';
    if (id) {
      return `tool:${role}:${toolCallId}:${id}`;
    }
    const messageId = typeof m.messageId === 'string' ? m.messageId : '';
    if (messageId) {
      return `tool:${role}:${toolCallId}:${messageId}`;
    }
    const timestamp = typeof m.timestamp === 'number' ? m.timestamp : null;
    if (timestamp != null) {
      return `tool:${role}:${toolCallId}:${timestamp}:${index}`;
    }
    return `tool:${role}:${toolCallId}:${index}`;
  }
  const id = typeof m.id === 'string' ? m.id : '';
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === 'string' ? m.messageId : '';
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === 'number' ? m.timestamp : null;
  const role = typeof m.role === 'string' ? m.role : 'unknown';
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
