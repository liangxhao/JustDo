// @vitest-environment jsdom
import type { MessageQuote as AppMessageQuote } from '@app-plugin/sdk/metadata';
import { beforeEach, expect, it, vi } from 'vitest';

import { type CollaborationQuote, toAppQuote } from './quote';

const mock = vi.hoisted(() => ({ dispatch: vi.fn(), snapshot: {
  cowork: { currentSession: { id: 'source' }, draftPrompts: {}, draftMessageQuotes: {} as Record<string, AppMessageQuote[]> },
  agent: { agents: [] },
} }));
vi.mock('../../tests/fixtures/store', () => ({ store: {
  getState: () => mock.snapshot,
  dispatch: mock.dispatch,
  subscribe: () => () => undefined,
} }));

// Other component tests intentionally mock this adapter; this suite exercises its
// real public SDK conversion and source guard instead of the old Core reducer.
const { addDraftMessageQuote, store } = await vi.importActual<typeof import('./state')>('./state');
const quote: CollaborationQuote = {
  kind: 'collaboration', id: 'card', text: 'Worker', roomId: 'room',
  sourceSessionId: 'source', targetAgentId: 'worker', targetSessionId: 'peer',
  targetSessionKey: 'agent:worker:justdo:peer', priorRoundId: 'round', deliveryId: 'delivery',
};
beforeEach(() => {
  mock.dispatch.mockClear();
  mock.snapshot.cowork.draftMessageQuotes = {};
});

it('converts Team locators to the generic draft port with no transcript or execution request', () => {
  store.dispatch(addDraftMessageQuote({ draftKey: 'source', quote }));
  expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: 'cowork/addDraftMessageQuote',
    payload: {
      draftKey: 'source',
      quote: expect.objectContaining({ kind: 'extension', pluginId: 'agent-team', id: 'card', labelKey: 'teamCollaborationReference' }),
    },
  });
  const sent = JSON.stringify(mock.dispatch.mock.calls);
  expect(sent).not.toContain('inReplyTo');
  expect(sent).not.toContain('attachments');
});

it('rejects cross-source and malformed collaboration references before calling the generic host port', () => {
  expect(() => store.dispatch(addDraftMessageQuote({ draftKey: 'other', quote }))).toThrow('collaborationInvalidRecipient');
  expect(() => store.dispatch(addDraftMessageQuote({ draftKey: 'source', quote: {
    ...quote, targetSessionKey: 'agent:other:justdo:peer',
  } }))).toThrow('collaborationInvalidRecipient');
  expect(mock.dispatch).not.toHaveBeenCalled();
});

it('rejects missing discussion identity before conversion', () => {
  expect(() => addDraftMessageQuote({ draftKey: 'source', quote: {
    kind: 'discussion', id: 'discussion', text: 'Design', roomId: '', discussionId: 'round',
  } })).toThrow('teamDiscussionNotFound');
  expect(mock.dispatch).not.toHaveBeenCalled();
});

it('deduplicates every producer by Team locator when a create-task retry targets a draft before load', () => {
  const discussion = {
    kind: 'discussion' as const, id: 'first-card', text: 'Design', roomId: 'room', discussionId: 'round',
  };
  // The new task does not become the current session until its later load succeeds.
  store.dispatch(addDraftMessageQuote({ draftKey: 'new-task', quote: discussion }));
  expect(mock.dispatch).toHaveBeenCalledTimes(1);
  mock.snapshot.cowork.draftMessageQuotes['new-task'] = [toAppQuote(discussion)];
  store.dispatch(addDraftMessageQuote({ draftKey: 'new-task', quote: { ...discussion, id: 'retry-card' } }));
  expect(mock.dispatch).toHaveBeenCalledTimes(1);

  mock.snapshot.cowork.draftMessageQuotes.source = [toAppQuote(quote)];
  store.dispatch(addDraftMessageQuote({ draftKey: 'source', quote: { ...quote, id: 'another-card' } }));
  expect(mock.dispatch).toHaveBeenCalledTimes(1);
});
