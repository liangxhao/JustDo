import { beforeEach, expect, test, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handle,
  },
}));

import { registerCoworkSessionHandlers } from './sessions';

type IpcHandler = (...args: unknown[]) => Promise<unknown>;

const registerHandlers = (stopSession: ReturnType<typeof vi.fn>): IpcHandler => {
  const router = {
    stopSession,
  } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => ({}) as CoworkStore,
    getCoworkEngineRouter: () => router,
  });
  const registration = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:stop',
  );
  expect(registration).toBeDefined();
  return registration?.[1] as IpcHandler;
};

beforeEach(() => {
  mocks.handle.mockReset();
});

test('waits for the runtime to confirm a session stop before reporting success', async () => {
  let confirmStop: (() => void) | undefined;
  const stopSession = vi.fn(
    () =>
      new Promise<void>(resolve => {
        confirmStop = resolve;
      }),
  );
  const handler = registerHandlers(stopSession);

  let settled = false;
  const resultPromise = handler({}, 'session-1').finally(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  confirmStop?.();
  await expect(resultPromise).resolves.toEqual({ success: true });
});

test('reports failure when the runtime cannot confirm a session stop', async () => {
  const handler = registerHandlers(vi.fn().mockRejectedValue(new Error('abort unavailable')));

  await expect(handler({}, 'session-1')).resolves.toEqual({
    success: false,
    error: 'abort unavailable',
  });
});
