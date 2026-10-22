// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

import type { MessageQuote } from '../composer/draft/messageQuote';
import {
  appendDiscussionReference,
  appendTeamResultDraft,
  buildDiscussionReference,
  buildTeamResultDraft,
} from './teamResultDraft';

const mock = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: {
    cowork: {
      currentSession: { id: 'source' },
      draftPrompts: {} as Record<string, string>,
      draftMessageQuotes: {} as Record<string, MessageQuote[]>,
    },
  },
}));
vi.mock('@/store', () => ({ store: { getState: () => mock.state, dispatch: mock.dispatch } }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
beforeEach(() => {
  mock.dispatch.mockClear();
  mock.state.cowork.currentSession.id = 'source';
  mock.state.cowork.draftPrompts = {};
  mock.state.cowork.draftMessageQuotes = {};
});

it('adds only a reference card without touching existing text and deduplicates repeated clicks', () => {
  mock.state.cowork.draftPrompts.source = 'My requirement';
  const quote = buildDiscussionReference('room', 'batch', 'Design');
  appendDiscussionReference('source', quote);
  expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: 'cowork/addDraftMessageQuote',
      payload: { draftKey: 'source', quote },
    }),
  );
  expect(mock.state.cowork.draftPrompts.source).toBe('My requirement');
  mock.state.cowork.draftMessageQuotes.source = [quote];
  appendDiscussionReference('source', quote);
  expect(mock.dispatch).toHaveBeenCalledOnce();
});

it('rejects stale source navigation and reports a full reference tray without replacing cards', () => {
  const quote = buildDiscussionReference('room', 'batch', 'Design');
  expect(() => appendDiscussionReference('other', quote)).toThrow('teamDiscussionNotFound');
  mock.state.cowork.draftMessageQuotes.source = Array.from({ length: 8 }, (_, index) =>
    buildDiscussionReference('room', `batch-${index}`, 'Design'),
  );
  expect(() => appendDiscussionReference('source', quote)).toThrow('teamReferenceLimit');
  expect(mock.dispatch).not.toHaveBeenCalled();
});

it('carries an exact native batch locator without copying discussion text', () => {
  expect(buildTeamResultDraft('room', 'batch')).toContain('"discussionIds":["batch"]');
  expect(buildTeamResultDraft('room', 'batch')).toContain('"action":"read"');
});

it('appends to the current user draft and avoids duplicate requests', () => {
  mock.state.cowork.draftPrompts.source = 'My newer requirement';
  appendTeamResultDraft('source', 'Summary request');
  expect(mock.dispatch.mock.calls[0][0].payload.draft).toBe(
    'My newer requirement\n\nSummary request',
  );
  mock.state.cowork.draftPrompts.source = 'My newer requirement\n\nSummary request';
  appendTeamResultDraft('source', 'Summary request');
  expect(mock.dispatch).toHaveBeenCalledOnce();
});

it('refuses a stale navigation to a different source', () => {
  mock.state.cowork.currentSession.id = 'other';
  expect(() => appendTeamResultDraft('source', 'Request')).toThrow('teamDiscussionNotFound');
  expect(mock.dispatch).not.toHaveBeenCalled();
});

it('lets a mounted composer consume the append event before the stale Redux fallback', () => {
  mock.state.cowork.draftPrompts.source = 'Older debounced text';
  const consume = vi.fn((event: Event) => event.preventDefault());
  window.addEventListener('cowork:append-draft', consume);
  try {
    appendTeamResultDraft('source', 'Summary request');
    expect(consume).toHaveBeenCalledOnce();
    const event = consume.mock.calls[0][0] as CustomEvent;
    expect(event.cancelable).toBe(true);
    expect(event.detail).toEqual({ sessionId: 'source', text: 'Summary request' });
    expect(mock.dispatch).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('cowork:append-draft', consume);
  }
});

it('does not emit an append event when merely viewing an existing summary', () => {
  const listener = vi.fn();
  window.addEventListener('cowork:append-draft', listener);
  try {
    appendTeamResultDraft('source', '');
    expect(listener).not.toHaveBeenCalled();
    expect(mock.dispatch).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('cowork:append-draft', listener);
  }
});
