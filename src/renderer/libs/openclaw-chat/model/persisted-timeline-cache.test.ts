import { describe, expect, test, vi } from 'vitest';

import { PersistedTimelineCache } from './persisted-timeline-cache';

describe('PersistedTimelineCache', () => {
  test('does not rebuild persisted history for live-only revisions', () => {
    const cache = new PersistedTimelineCache();
    const messages = [{ role: 'assistant', content: 'persisted' }];
    const project = vi.fn(() => []);
    const key = {
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'session-1',
      historyGeneration: 3,
      messages,
      pendingMessage: null,
      projectionVariant: 'running',
    };

    cache.get(key, project);
    cache.get(key, project);
    cache.get(key, project);

    expect(project).toHaveBeenCalledOnce();
  });

  test('invalidates for history, session, optimistic, or terminal projection changes', () => {
    const cache = new PersistedTimelineCache();
    const messages = [{ role: 'assistant', content: 'persisted' }];
    const project = vi.fn(() => []);
    const base = {
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'session-1',
      historyGeneration: 3,
      messages,
      pendingMessage: null,
      projectionVariant: 'running',
    };

    cache.get(base, project);
    cache.get({ ...base, historyGeneration: 4 }, project);
    cache.get({ ...base, messages: [...messages] }, project);
    cache.get({ ...base, projectionVariant: 'final:answer' }, project);

    expect(project).toHaveBeenCalledTimes(4);
  });
});
