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
import { registerCoworkInteractionHandlers } from './interactions';

describe('cowork AskUserQuestion interaction IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.send.mockClear();
  });

  test('resolves a submitted answer and publishes lightweight user activity', async () => {
    const resolveAskUserInteraction = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
    registerCoworkInteractionHandlers({
      getRuntime: () => ({
        listPendingAskUserInteractions: vi.fn().mockResolvedValue([]),
        resolveAskUserInteraction,
      }),
    });

    await expect(
      mocks.handlers.get(CoworkInteractionIpc.Respond)?.(
        {},
        {
          requestId: 'ask-1',
          result: {
            behavior: 'submit',
            updatedInput: { answers: { deploy_target: { selected: ['option_1'] } } },
          },
        },
      ),
    ).resolves.toEqual({ success: true });

    expect(resolveAskUserInteraction).toHaveBeenCalledWith('ask-1', {
      behavior: 'submit',
      answers: { deploy_target: { selected: ['option_1'] } },
    });
    expect(mocks.send).toHaveBeenCalledWith('cowork:session:activity', {
      sessionId: 'session-1',
      kind: 'user',
      timestamp: expect.any(Number),
    });
  });

  test('maps cancel to extension question cancellation', async () => {
    const resolveAskUserInteraction = vi.fn().mockResolvedValue({ sessionId: '__askuser__' });
    registerCoworkInteractionHandlers({
      getRuntime: () => ({
        listPendingAskUserInteractions: vi.fn().mockResolvedValue([]),
        resolveAskUserInteraction,
      }),
    });

    await expect(
      mocks.handlers.get(CoworkInteractionIpc.Respond)?.(
        {},
        {
          requestId: 'ask-1',
          result: { behavior: 'cancel', message: 'cancelled' },
        },
      ),
    ).resolves.toEqual({ success: true });

    expect(resolveAskUserInteraction).toHaveBeenCalledWith('ask-1', { behavior: 'cancel' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  test('rejects an unknown response behavior instead of treating it as cancellation', async () => {
    const resolveAskUserInteraction = vi.fn();
    registerCoworkInteractionHandlers({
      getRuntime: () => ({
        listPendingAskUserInteractions: vi.fn().mockResolvedValue([]),
        resolveAskUserInteraction,
      }),
    });

    await expect(
      mocks.handlers.get(CoworkInteractionIpc.Respond)?.(
        {},
        { requestId: 'ask-1', result: { behavior: 'typo' } },
      ),
    ).resolves.toEqual({ success: false, error: 'Invalid interaction response.' });
    expect(resolveAskUserInteraction).not.toHaveBeenCalled();
  });

  test('replays pending extension questions to a newly loaded renderer', async () => {
    const interaction = {
      sessionId: 'session-1',
      request: {
        requestId: 'ask-1',
        toolName: 'AskUserQuestion' as const,
        interactionKind: 'structured-question' as const,
        toolInput: {
          sessionId: 'session-1',
          waitPolicy: { mode: 'required' as const },
          questions: [],
        },
      },
    };
    const sender = { send: vi.fn() };
    registerCoworkInteractionHandlers({
      getRuntime: () => ({
        listPendingAskUserInteractions: vi.fn().mockResolvedValue([interaction]),
        resolveAskUserInteraction: vi.fn(),
      }),
    });

    await expect(mocks.handlers.get(CoworkInteractionIpc.Replay)?.({ sender })).resolves.toEqual({
      success: true,
      count: 1,
    });
    expect(sender.send).toHaveBeenCalledWith(CoworkInteractionIpc.Stream, interaction);
  });
});
