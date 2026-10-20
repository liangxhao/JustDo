import { addDraftMessageQuote, setDraftPrompt } from '../state';
import { i18nService } from '../ui';
import { store } from '../state';

import { type DiscussionQuote, MESSAGE_QUOTE_KIND } from '../quote';

export function buildDiscussionReference(
  roomId: string,
  discussionId: string,
  title: string,
): DiscussionQuote {
  return {
    kind: MESSAGE_QUOTE_KIND.DISCUSSION,
    id: `discussion:${roomId}:${discussionId}`,
    roomId,
    discussionId,
    text: title,
  };
}

export function appendDiscussionReference(sessionId: string, quote: DiscussionQuote): void {
  if (store.getState().cowork.currentSession?.id !== sessionId)
    throw new Error('teamDiscussionNotFound');
  const quotes = store.getState().cowork.draftMessageQuotes?.[sessionId] ?? [];
  if (quotes.some(item => item.id === quote.id)) return;
  if (quotes.length >= 8) throw new Error('teamReferenceLimit');
  store.dispatch(addDraftMessageQuote({ draftKey: sessionId, quote }));
}

/** Only user-authored request text and native locators, never a transcript copy. */
export function buildTeamResultDraft(roomId: string, discussionId: string): string {
  const locator = JSON.stringify({ action: 'read', roomId, discussionIds: [discussionId] });
  return `${i18nService.t('teamResultDraftInstruction')}\nteam_discussion(${locator})`;
}

/** Called after guarded navigation. Never overwrite a draft edited while navigation awaited. */
export function appendTeamResultDraft(sessionId: string, draft: string): void {
  if (store.getState().cowork.currentSession?.id !== sessionId)
    throw new Error('teamDiscussionNotFound');
  if (!draft) return;
  // A mounted composer owns the freshest (not yet debounced) user text.
  const event = new CustomEvent('cowork:append-draft', {
    cancelable: true,
    detail: { sessionId, text: draft },
  });
  if (!window.dispatchEvent(event)) return;
  const existing = store.getState().cowork.draftPrompts[sessionId] ?? '';
  if (existing.includes(draft)) return;
  store.dispatch(
    setDraftPrompt({ sessionId, draft: existing ? `${existing}\n\n${draft}` : draft }),
  );
}
