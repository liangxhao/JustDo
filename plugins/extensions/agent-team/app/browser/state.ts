import type { AppStateSnapshot } from '@app-plugin/sdk/application';
import { useSyncExternalStore } from 'react';

import { application, browserHost } from './ports';
import { MESSAGE_QUOTE_KIND, type MessageQuote, toAppQuote, validCollaborationQuote, validDiscussionQuote } from './quote';

export type RootState = AppStateSnapshot;
export type AgentResult<T> = { success: true; value: T } | { success: false; error: string };
export const OpenClawExtensionId = { AGENT_TEAM: 'agent-team' } as const;
export function useSelector<T>(select: (state: RootState) => T): T {
  const snapshot = useSyncExternalStore(
    application.metadata.subscribe,
    application.metadata.getSnapshot,
  );
  return select(snapshot);
}
export const addDraftMessageQuote = (input: { draftKey: string; quote: MessageQuote }) => {
  if (input.quote.kind === MESSAGE_QUOTE_KIND.COLLABORATION &&
      (!validCollaborationQuote(input.quote) || input.quote.sourceSessionId !== input.draftKey))
    throw new Error('collaborationInvalidRecipient');
  if (input.quote.kind === MESSAGE_QUOTE_KIND.DISCUSSION && !validDiscussionQuote(input.quote))
    throw new Error('teamDiscussionNotFound');
  return { kind: 'quote' as const, input: { ...input, quote: toAppQuote(input.quote) } };
};
export const setDraftPrompt = (input: Parameters<typeof application.drafts.setPrompt>[0]) => ({
  kind: 'prompt' as const,
  input,
});
export const store = {
  getState: () => application.metadata.getSnapshot(),
  dispatch: (
    action: ReturnType<typeof addDraftMessageQuote> | ReturnType<typeof setDraftPrompt>,
  ) => {
    if (action.kind === 'quote') {
      const { draftKey, quote } = action.input;
      const quotes = application.metadata.getSnapshot().cowork.draftMessageQuotes[draftKey] ?? [];
      if (quote.kind === 'extension' && quote.pluginId === 'agent-team' &&
          quotes.some(item => item.kind === 'extension' &&
            item.pluginId === quote.pluginId && item.context === quote.context)) return;
      application.drafts.addQuote(action.input);
    } else application.drafts.setPrompt(action.input);
  },
};
export const coworkService = {
  ensureSessionSummaries: (...args: Parameters<typeof application.sessions.ensureSummaries>) =>
    application.sessions.ensureSummaries(...args),
  loadSession: (...args: Parameters<typeof application.sessions.loadSession>) =>
    application.sessions.loadSession(...args),
  getSessionDetails: (...args: Parameters<typeof application.sessions.getDetails>) =>
    application.sessions.getDetails(...args),
};
export const useExtensionEnabled = (_id: string) => !browserHost().signal.aborted;
export const useExtensionAvailability = (_id: string) => ({
  loaded: true,
  enabled: !browserHost().signal.aborted,
  disabledRevision: 0,
});
