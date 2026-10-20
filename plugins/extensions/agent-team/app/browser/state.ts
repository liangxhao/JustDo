import { useSyncExternalStore } from 'react';

import type { AppStateSnapshot } from '@app-plugin/sdk/application';
import { application, browserHost } from './ports';
import { toAppQuote, type MessageQuote } from './quote';

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
export const addDraftMessageQuote = (input: { draftKey: string; quote: MessageQuote }) => ({
  kind: 'quote' as const,
  input: { ...input, quote: toAppQuote(input.quote) },
});
export const setDraftPrompt = (input: Parameters<typeof application.drafts.setPrompt>[0]) => ({
  kind: 'prompt' as const,
  input,
});
export const store = {
  getState: () => application.metadata.getSnapshot(),
  dispatch: (
    action: ReturnType<typeof addDraftMessageQuote> | ReturnType<typeof setDraftPrompt>,
  ) => {
    if (action.kind === 'quote') application.drafts.addQuote(action.input);
    else application.drafts.setPrompt(action.input);
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
