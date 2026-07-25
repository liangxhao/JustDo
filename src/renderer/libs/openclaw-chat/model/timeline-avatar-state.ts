import type { PersistedTimelineItem } from './project-history-timeline';
import type { ActiveTurnTimelineItem } from './project-turn-items';

export type VisibleTimelineItem = PersistedTimelineItem | ActiveTurnTimelineItem;

export interface VisibleTimelineRow {
  item: VisibleTimelineItem;
  showAvatar: boolean;
}

function historyMessageRole(item: Extract<PersistedTimelineItem, { kind: 'history-message' }>) {
  const outer = item.message as Record<string, unknown>;
  const nested =
    outer.message && typeof outer.message === 'object' && !Array.isArray(outer.message)
      ? (outer.message as Record<string, unknown>)
      : outer;
  return String(nested.role ?? outer.role ?? '').toLowerCase();
}

/**
 * A user message starts a new conversational turn. All assistant timeline rows
 * after it share one avatar slot until the next user message.
 */
export function prepareVisibleTimelineRows(items: readonly VisibleTimelineItem[]) {
  let assistantTurnOpen = false;
  return items.map<VisibleTimelineRow>(item => {
    if (item.kind !== 'history-message') {
      const showAvatar = !assistantTurnOpen;
      assistantTurnOpen = true;
      return { item, showAvatar };
    }

    const role = historyMessageRole(item);
    if (role === 'user') {
      assistantTurnOpen = false;
      return { item, showAvatar: true };
    }
    if (role === 'assistant') {
      const showAvatar = !assistantTurnOpen;
      assistantTurnOpen = true;
      return { item, showAvatar };
    }
    return { item, showAvatar: true };
  });
}
