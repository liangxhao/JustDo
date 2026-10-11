import { expect, it } from 'vitest';

import reducer, {
  clearSubmittedAgentTeamMode,
  deleteSession,
  deleteSessions,
  setDraftAgentTeamMode,
  setDraftPrompt,
} from '@/features/cowork/coworkSlice';

it('keeps mode alongside its draft across composer lifetimes without leaking into other sessions', () => {
  let state = reducer(undefined, setDraftPrompt({ sessionId: '__home__', draft: 'Review this' }));
  state = reducer(
    state,
    setDraftAgentTeamMode({ draftKey: '__home__', draft: { id: 'home-selection', mode: 'group' } }),
  );
  state = reducer(
    state,
    setDraftAgentTeamMode({ draftKey: 'other', draft: { id: 'other-selection', mode: 'task' } }),
  );
  expect(state.draftAgentTeamModes.__home__.mode).toBe('group');
  expect(state.draftPrompts.__home__).toBe('Review this');
  state = reducer(state, clearSubmittedAgentTeamMode({ draftKey: 'other', id: 'other-selection' }));
  expect(state.draftAgentTeamModes.other).toBeUndefined();
  expect(state.draftAgentTeamModes.__home__.mode).toBe('group');
});

it('clears only the accepted selection and retains a later same-mode selection', () => {
  let state = reducer(
    undefined,
    setDraftAgentTeamMode({ draftKey: 'source', draft: { id: 'old', mode: 'group' } }),
  );
  state = reducer(
    state,
    setDraftAgentTeamMode({ draftKey: 'source', draft: { id: 'new', mode: 'group' } }),
  );
  state = reducer(state, clearSubmittedAgentTeamMode({ draftKey: 'source', id: 'old' }));
  expect(state.draftAgentTeamModes.source.id).toBe('new');
  state = reducer(state, setDraftAgentTeamMode({ draftKey: 'source' }));
  expect(state.draftAgentTeamModes.source).toBeUndefined();
});

it('cleans up modes when their sessions are deleted', () => {
  let state = reducer(
    undefined,
    setDraftAgentTeamMode({ draftKey: 'one', draft: { id: '1', mode: 'task' } }),
  );
  state = reducer(
    state,
    setDraftAgentTeamMode({ draftKey: 'two', draft: { id: '2', mode: 'group' } }),
  );
  state = reducer(state, deleteSession('one'));
  state = reducer(state, deleteSessions(['two']));
  expect(state.draftAgentTeamModes).toEqual({});
});
