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
  const getRouter = vi.fn();
  const getActivity = vi.fn();
  registerAutomaticErrorRetryHandlers({
    isAllowedSender: () => false,
    getStore,
    getRouter,
    getActivity,
  });
  expect(handlers.get(AutomaticErrorRetryIpc.Get)!({}, 'product')).toMatchObject({
    success: false,
  });
  expect(getStore).not.toHaveBeenCalled();
  expect(handlers.get(AutomaticErrorRetryIpc.GetActivity)!({})).toBeNull();
  expect(getRouter).not.toHaveBeenCalled();
  expect(getActivity).not.toHaveBeenCalled();
});

it('loads the active retry list without initializing the runtime or querying stored run receipts', () => {
  const snapshot = { revision: 2, sessionIds: ['product'] };
  const getStore = vi.fn();
  const getRouter = vi.fn();
  const getActivity = vi.fn((): typeof snapshot | null => snapshot).mockReturnValueOnce(null);
  registerAutomaticErrorRetryHandlers({
    isAllowedSender: () => true,
    getStore,
    getRouter,
    getActivity,
  });
  expect(handlers.get(AutomaticErrorRetryIpc.GetActivity)!({})).toBeNull();
  expect(handlers.get(AutomaticErrorRetryIpc.GetActivity)!({})).toEqual(snapshot);
  expect(getStore).not.toHaveBeenCalled();
  expect(getRouter).not.toHaveBeenCalled();
});

it('merges earlier handled chains with the live current chain', () => {
  const live = { sessionId: 'product', chainId: 'new', revision: 1, runs: [] };
  registerAutomaticErrorRetryHandlers({
    isAllowedSender: () => true,
    getStore: () =>
      ({ getSession: () => ({}), getSessionRuns: () => [timing('superseded')] }) as never,
    getRouter: () => ({ getAutomaticErrorRetry: () => live }) as never,
    getActivity: () => null,
  });
  expect(handlers.get(AutomaticErrorRetryIpc.Get)!({}, 'product')).toMatchObject({
    success: true,
    presentation: live,
    presentations: [{ chainId: 'chain' }, live],
  });
});
