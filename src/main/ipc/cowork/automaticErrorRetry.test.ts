import { beforeEach, expect, it, vi } from 'vitest';

import { AutomaticErrorRetryIpc } from '../../../shared/cowork/automaticErrorRetry';
import type { SessionRunTiming } from '../../../shared/cowork/sessionRun';
import { registerAutomaticErrorRetryHandlers } from './automaticErrorRetry';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      handlers.set(name, callback),
  },
}));
beforeEach(() => handlers.clear());

const timing = (disposition: 'candidate' | 'pending' | 'superseded'): SessionRunTiming => ({
  id: 'receipt',
  sessionId: 'product',
  clientTurnId: 'input',
  rootRunId: 'native-run',
  startedAt: 1,
  state: 'failed',
  endedAt: 2,
  automaticErrorRetry: {
    chainId: 'chain',
    attempt: 0,
    maxContinuations: 1,
    sessionKey: 'agent:main:justdo:product',
    nativeSessionId: 'physical',
    lifecycleRevision: 'revision',
    disposition,
  },
});

it('only exposes associations to the authorized desktop caller', () => {
  const getStore = vi.fn();
  registerAutomaticErrorRetryHandlers({
    isAllowedSender: () => false,
    getStore,
    getRouter: vi.fn(),
  });
  expect(handlers.get(AutomaticErrorRetryIpc.Get)!({}, 'product')).toMatchObject({
    success: false,
  });
  expect(getStore).not.toHaveBeenCalled();
});

it('merges earlier handled chains with the live current chain', () => {
  const live = { sessionId: 'product', chainId: 'new', revision: 1, runs: [] };
  registerAutomaticErrorRetryHandlers({
    isAllowedSender: () => true,
    getStore: () =>
      ({ getSession: () => ({}), getSessionRuns: () => [timing('superseded')] }) as never,
    getRouter: () => ({ getAutomaticErrorRetry: () => live }) as never,
  });
  expect(handlers.get(AutomaticErrorRetryIpc.Get)!({}, 'product')).toMatchObject({
    success: true,
    presentation: live,
    presentations: [{ chainId: 'chain' }, live],
  });
});
