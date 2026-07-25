import { extractTextCached } from '@/libs/openclaw-chat/pipeline/message-extract';

import type { VisibleTimelineItem } from './timeline-avatar-state';

export interface ChatMinimapEntry {
  key: string;
  anchorKey: string;
  userText: string;
  assistantText: string;
}

function historyMessagePayload(
  item: Extract<VisibleTimelineItem, { kind: 'history-message' }>,
): Record<string, unknown> {
  const outer = item.message as Record<string, unknown>;
  return outer.message && typeof outer.message === 'object' && !Array.isArray(outer.message)
    ? (outer.message as Record<string, unknown>)
    : outer;
}

function historyMessageRole(
  item: Extract<VisibleTimelineItem, { kind: 'history-message' }>,
): string {
  const payload = historyMessagePayload(item);
  return String(payload.role ?? item.message.role ?? '').toLowerCase();
}

function cleanPreviewText(text: string | null | undefined, limit: number): string {
  return (text ?? '')
    .replace(/^MEDIA\s*:\s*.+$/gim, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function appendAssistantText(entry: ChatMinimapEntry, text: string): void {
  const cleaned = cleanPreviewText(text, 320);
  if (!cleaned) return;
  entry.assistantText = cleanPreviewText(
    entry.assistantText ? `${entry.assistantText} ${cleaned}` : cleaned,
    320,
  );
}

/**
 * Projects one minimap entry per user turn. Thinking and Tool rows belong to
 * the assistant turn but do not appear in the compact text preview.
 */
export function projectChatMinimapEntries(
  items: readonly VisibleTimelineItem[],
  liveAssistantText?: string | null,
): ChatMinimapEntry[] {
  const entries: ChatMinimapEntry[] = [];
  let activeEntry: ChatMinimapEntry | null = null;

  for (const item of items) {
    if (item.kind === 'history-message') {
      const role = historyMessageRole(item);
      const message = historyMessagePayload(item);
      if (role === 'user') {
        activeEntry = {
          key: `minimap:${item.key}`,
          anchorKey: item.key,
          userText: cleanPreviewText(extractTextCached(message), 180),
          assistantText: '',
        };
        entries.push(activeEntry);
      } else if (role === 'assistant' && activeEntry) {
        appendAssistantText(activeEntry, extractTextCached(message) ?? '');
      }
      continue;
    }

    if (item.kind === 'content' && activeEntry) {
      appendAssistantText(activeEntry, item.item.text);
    }
  }

  if (activeEntry && liveAssistantText) {
    appendAssistantText(activeEntry, liveAssistantText);
  }

  return entries;
}
