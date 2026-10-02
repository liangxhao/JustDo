import { describe, expect, it, vi } from 'vitest';

import { ChatController } from './chat-controller';
import { readChatContextUsageSnapshot } from './chat-controller-support';

const sessionKey = 'agent:main:justdo:context-test';

function setup() {
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'sid-current';
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = 'sid-current';
  const notify = vi.fn();
  controller.subscribe(notify);
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);
  const row = {
    sessionKey,
    sessionId: 'sid-current',
    updatedAt: 100,
    totalTokens: 80_000,
    totalTokensFresh: true,
    contextTokens: 200_000,
    modelProvider: 'openai',
    model: 'gpt-test',
  };
  handleEvent({ event: 'sessions.changed', payload: row });
  notify.mockClear();
  return { controller, handleEvent, row, notify };
}

describe('Gateway context usage projections', () => {
  it('projects budget changes even when the token snapshot and timestamp stay the same', () => {
    const { controller, handleEvent, row, notify } = setup();
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        session: { ...row, contextBudgetStatus: { promptBudgetBeforeReserve: 100_000 } },
      },
    });
    expect(controller.state.contextUsage?.promptBudgetTokens).toBe(100_000);
    handleEvent({
      event: 'sessions.changed',
      payload: { ...row, contextBudgetStatus: { promptBudgetBeforeReserve: 120_000 } },
    });
    expect(controller.state.contextUsage?.promptBudgetTokens).toBe(120_000);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('drops a cleared prompt budget and restores the native context limit', () => {
    const { controller, handleEvent, row } = setup();
    handleEvent({
      event: 'sessions.changed',
      payload: { ...row, contextBudgetStatus: { promptBudgetBeforeReserve: 100_000 } },
    });
    handleEvent({
      event: 'sessions.changed',
      payload: { ...row, updatedAt: 200, contextBudgetStatus: null },
    });
    expect(controller.state.contextUsage?.promptBudgetTokens).toBeUndefined();
    expect(controller.state.contextUsage?.contextTokens).toBe(200_000);
  });

  it('retires accurate usage when Gateway projects unavailable usage without totalTokens', () => {
    const { controller, handleEvent, row } = setup();
    const { totalTokens: _totalTokens, ...unknownRow } = row;
    handleEvent({
      event: 'sessions.changed',
      payload: { ...unknownRow, updatedAt: 200, totalTokensFresh: false },
    });
    expect(controller.state.contextUsage?.totalTokens).toBeNull();
    handleEvent({ event: 'sessions.changed', payload: { ...row, updatedAt: 150 } });
    expect(controller.state.contextUsage?.totalTokens).toBeNull();
    handleEvent({
      event: 'sessions.changed',
      payload: { ...row, updatedAt: 300, totalTokens: 12_000 },
    });
    expect(controller.state.contextUsage?.totalTokens).toBe(12_000);
  });

  it('preserves usage for lifecycle patches that omit usage', () => {
    const { controller, handleEvent } = setup();
    handleEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey,
        sessionId: 'sid-current',
        updatedAt: 200,
        phase: 'lifecycle',
        status: 'running',
      },
    });
    expect(controller.state.contextUsage?.totalTokens).toBe(80_000);
  });

  it('rejects a late message usage snapshot from a previous native session', () => {
    const { controller, handleEvent, row, notify } = setup();
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        session: { ...row, sessionId: 'sid-old', updatedAt: 200, totalTokens: 190_000 },
      },
    });
    expect(controller.state.contextUsage?.sessionId).toBe('sid-current');
    expect(controller.state.contextUsage?.totalTokens).toBe(80_000);
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps approximate totals and ignores invalid budget fields', () => {
    expect(
      readChatContextUsageSnapshot(
        {
          totalTokens: 42_000,
          totalTokensFresh: false,
          contextBudgetStatus: { promptBudgetBeforeReserve: Infinity },
        },
        sessionKey,
      ),
    ).toMatchObject({ totalTokens: 42_000, totalTokensFresh: false });
    expect(readChatContextUsageSnapshot({ totalTokens: 0 }, sessionKey)?.totalTokens).toBe(0);
  });

  it('rejects old native identity carried only in the message envelope', () => {
    const { controller, handleEvent, row } = setup();
    const { sessionId: _sessionId, ...session } = row;
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        sessionId: 'sid-old',
        session: { ...session, updatedAt: 200, totalTokens: 190_000 },
      },
    });
    expect(controller.state.contextUsage?.totalTokens).toBe(80_000);
  });

  it('clears usage when a reset keeps the same public session identity', () => {
    const { controller, handleEvent, notify } = setup();
    handleEvent({
      event: 'sessions.changed',
      payload: { sessionKey, sessionId: 'sid-current', reason: 'reset' },
    });
    expect(controller.state.contextUsage).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].contextUsage).toBeNull();
    controller.disconnect();
  });

  it('immediately publishes cleared usage when reset rotates native identity', () => {
    const { controller, handleEvent, notify } = setup();
    handleEvent({
      event: 'sessions.changed',
      payload: { sessionKey, sessionId: 'sid-new', reason: 'reset' },
    });
    expect(controller.state.contextUsage).toBeNull();
    expect(controller.state.currentSessionId).toBe('sid-new');
    expect(notify).toHaveBeenCalledTimes(1);
    controller.disconnect();
  });
});
