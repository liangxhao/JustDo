export type MatchedTokenUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export interface HistoryAssistantUsage {
  text: string;
  usage?: MatchedTokenUsage;
}

export interface LocalAssistantUsageTarget {
  id: string;
  text: string;
  hasUsage: boolean;
}

/**
 * Match history usage to local assistant messages in occurrence order.
 * Existing local usage still consumes its corresponding history entry so a
 * later identical reply cannot receive the earlier turn's usage.
 */
export const matchAssistantUsageByOccurrence = (
  historyEntries: HistoryAssistantUsage[],
  localMessages: LocalAssistantUsageTarget[],
): Array<{ id: string; usage: MatchedTokenUsage }> => {
  const historyUsageByText = new Map<string, Array<MatchedTokenUsage | undefined>>();
  for (const entry of historyEntries) {
    const text = entry.text.trim();
    if (!text) continue;
    const values = historyUsageByText.get(text) ?? [];
    values.push(entry.usage);
    historyUsageByText.set(text, values);
  }

  const consumedByText = new Map<string, number>();
  const matches: Array<{ id: string; usage: MatchedTokenUsage }> = [];
  for (const message of localMessages) {
    const text = message.text.trim();
    if (!text) continue;
    const usageValues = historyUsageByText.get(text);
    const consumed = consumedByText.get(text) ?? 0;
    if (!usageValues || consumed >= usageValues.length) continue;
    const usage = usageValues[consumed];
    consumedByText.set(text, consumed + 1);
    if (usage && !message.hasUsage) matches.push({ id: message.id, usage });
  }
  return matches;
};
