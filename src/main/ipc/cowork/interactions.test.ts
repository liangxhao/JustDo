import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

import { CoworkInteractionIpc } from '../../../shared/openclaw/extensions';
import type { OpenClawExtensionHostController } from '../../plugins/extensions';
import { registerCoworkInteractionHandlers } from './interactions';

describe('cowork interaction IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.send.mockClear();
  });

  test('publishes lightweight user activity after a handled response', async () => {
    const respondToInteraction = vi.fn().mockReturnValue({ handled: true });
    const sessions = new Map([['request-1', 'session-1']]);
    registerCoworkInteractionHandlers({
      getExtensionHostController: () =>
        ({ respondToInteraction }) as unknown as OpenClawExtensionHostController,
      getPendingInteractions: () => [],
      askUserSessionByRequestId: sessions,
    });

    await expect(
      mocks.handlers.get(CoworkInteractionIpc.Respond)?.({}, {
        requestId: 'request-1',
        result: { behavior: 'submit', updatedInput: { answer: 'yes' } },
      }),
    ).resolves.toEqual({ success: true });

    expect(respondToInteraction).toHaveBeenCalledWith('request-1', {
      behavior: 'allow',
      updatedInput: { answer: 'yes' },
    });
    expect(mocks.send).toHaveBeenCalledWith('cowork:session:activity', {
      sessionId: 'session-1',
      kind: 'user',
      timestamp: expect.any(Number),
    });
    expect(sessions.has('request-1')).toBe(false);
  });

  test('does not publish activity when the extension rejects an unknown response', async () => {
    const respondToInteraction = vi.fn().mockReturnValue({ handled: false });
    registerCoworkInteractionHandlers({
      getExtensionHostController: () =>
        ({ respondToInteraction }) as unknown as OpenClawExtensionHostController,
      getPendingInteractions: () => [],
      askUserSessionByRequestId: new Map([['request-1', 'session-1']]),
    });

    await expect(
      mocks.handlers.get(CoworkInteractionIpc.Respond)?.({}, {
        requestId: 'request-1',
        result: { behavior: 'cancel', message: 'cancelled' },
      }),
    ).resolves.toEqual({ success: true });

    expect(mocks.send).not.toHaveBeenCalled();
  });
});
