import type { PersistedTimelineItem } from './project-history-timeline';
import type { ActiveTurnTimelineItem } from './project-turn-items';

export type VisibleTimelineItem = PersistedTimelineItem | ActiveTurnTimelineItem;

export interface VisibleTimelineRow {
  item: VisibleTimelineItem;
  showAvatar: boolean;
  showFooter: boolean;
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
export function prepareVisibleTimelineRows(
  items: readonly VisibleTimelineItem[],
  options?: { suppressTrailingAssistantFooter?: boolean },
) {
  let assistantTurnOpen = false;
  const rows = items.map<VisibleTimelineRow>(item => {
    if (item.kind !== 'history-message') {
      const showAvatar = !assistantTurnOpen;
      assistantTurnOpen = true;
      return { item, showAvatar, showFooter: false };
    }

    const role = historyMessageRole(item);
    if (role === 'user') {
      assistantTurnOpen = false;
      return { item, showAvatar: true, showFooter: true };
    }
    if (role === 'assistant') {
      const showAvatar = !assistantTurnOpen;
      assistantTurnOpen = true;
      return { item, showAvatar, showFooter: true };
    }
    return { item, showAvatar: true, showFooter: true };
  });

  let laterAssistantMessageInTurn = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.item.kind !== 'history-message') continue;
    const role = historyMessageRole(row.item);
    if (role === 'user') {
      laterAssistantMessageInTurn = false;
      continue;
    }
    if (role !== 'assistant') continue;
    row.showFooter = !laterAssistantMessageInTurn;
    laterAssistantMessageInTurn = true;
  }

  if (options?.suppressTrailingAssistantFooter) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row.item.kind !== 'history-message') continue;
      const role = historyMessageRole(row.item);
      if (role === 'user') break;
      if (role === 'assistant') row.showFooter = false;
    }
  }

  return rows;
}
