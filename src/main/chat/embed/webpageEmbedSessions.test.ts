import { describe, expect, it, vi } from 'vitest';

import {
  captureWebpageEmbedSession,
  observeWebpageEmbedSessionEvent,
  retireWebpageEmbedSessions,
} from './webpageEmbedSessions';

describe('native webpage display ownership', () => {
  it.each(['reset', 'delete', 'new'])(
    'retires an exact live mount on %s without closing other sessions',
    reason => {
      const client = {} as never;
      const a = captureWebpageEmbedSession(client, 'a', 'sid-a');
      const b = captureWebpageEmbedSession(client, 'b', 'sid-b');
      expect(a.bind({ key: 'a', sessionId: 'sid-a', owner: { agentId: 'one' } })).toBe(true);
      const retired = vi.fn();
      a.onRetired(retired);
      observeWebpageEmbedSessionEvent(client, 'sessions.changed', {
        reason,
        session: { key: 'a', sessionId: 'sid-new' },
      });
      expect(a.isCurrent()).toBe(false);
      expect(b.isCurrent()).toBe(true);
      expect(retired).toHaveBeenCalledOnce();
      b.release();
    },
  );
  it('keeps the document through ordinary activity but revokes an incarnation or owner replacement', () => {
    const client = {} as never;
    const a = captureWebpageEmbedSession(client, 'a', 'sid-a');
    a.bind({ key: 'a', sessionId: 'sid-a', owner: { agentId: 'one' } });
    observeWebpageEmbedSessionEvent(client, 'sessions.changed', {
      reason: 'send',
      session: { key: 'a', sessionId: 'sid-a', owner: { agentId: 'one' } },
    });
    expect(a.isCurrent()).toBe(true);
    observeWebpageEmbedSessionEvent(client, 'sessions.changed', {
      reason: 'patch',
      session: { key: 'a', sessionId: 'sid-a', owner: { agentId: 'two' } },
    });
    expect(a.isCurrent()).toBe(false);
    const next = captureWebpageEmbedSession(client, 'a', 'sid-a');
    observeWebpageEmbedSessionEvent(client, 'sessions.changed', {
      session: { key: 'a', sessionId: 'different' },
    });
    expect(next.isCurrent()).toBe(false);
  });
  it('fences reset racing a pending read and rejects absent or mismatched physical identities', () => {
    const client = {} as never;
    const a = captureWebpageEmbedSession(client, 'a', 'sid-a');
    observeWebpageEmbedSessionEvent(client, 'sessions.changed', { reason: 'reset', key: 'a' });
    expect(a.bind({ key: 'a', sessionId: 'sid-a' })).toBe(false);
    const b = captureWebpageEmbedSession(client, 'b', 'sid-b');
    expect(b.bind({ key: 'b', sessionId: 'different' })).toBe(false);
    const c = captureWebpageEmbedSession(client, 'c');
    expect(c.bind({ key: 'c' })).toBe(false);
  });

  it('retires every owned display on disconnect without touching another connection', () => {
    const client = {} as never;
    const a = captureWebpageEmbedSession(client, 'a');
    const b = captureWebpageEmbedSession(client, 'b');
    const other = captureWebpageEmbedSession({} as never, 'a');
    a.onRetired(() => {
      throw new Error('fixture');
    });
    const close = vi.fn();
    b.onRetired(close);
    retireWebpageEmbedSessions(client);
    expect(a.isCurrent()).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(other.isCurrent()).toBe(true);
    other.release();
  });
});
