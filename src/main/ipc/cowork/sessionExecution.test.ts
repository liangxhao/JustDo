import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerCoworkSessionExecutionHandlers } from './sessionExecution';

const session = (permissionMode: 'ask' | 'auto' | 'full'): CoworkSession => ({
  id: 'session-1',
  title: 'Session',
  status: 'idle',
  pinned: false,
  cwd: 'C:\\workspace',
  executionMode: 'local',
  permissionMode,
  activeSkillIds: [],
  agentId: 'main',
  messages: [],
  createdAt: 1,
  updatedAt: 2,
});

describe('cowork session execution permissions', () => {
  beforeEach(() => handlers.clear());

  test('acquires and persists the explicit new-session permission before execution', async () => {
    const acquirePermissionModeForTurn = vi.fn().mockResolvedValue({ success: true });
    const createSession = vi.fn().mockReturnValue(session('ask'));
    const store = {
      getConfig: () => ({
        workingDirectory: 'C:\\workspace',
        executionMode: 'local',
        agentEngine: 'openclaw',
        permissionMode: 'full',
      }),
      createSession,
      updateSession: vi.fn(),
      addMessage: vi.fn(),
      getSession: vi.fn().mockReturnValue(session('ask')),
    } as unknown as CoworkStore;
    const startSession = vi.fn().mockResolvedValue(undefined);
    registerCoworkSessionExecutionHandlers({
      ensureEngineRunning: vi.fn().mockResolvedValue({ phase: 'running' }),
      getCoworkStore: () => store,
      getCoworkEngineRouter: () => ({ startSession }) as unknown as CoworkEngineRouter,
      acquirePermissionModeForTurn,
      getEngineNotReadyResponse: vi.fn(),
    });

    const result = await handlers.get('cowork:session:start')?.(
      {},
      { prompt: 'hello', cwd: 'C:\\workspace', permissionMode: 'ask' },
    );
    expect(result).toMatchObject({ success: true });
    expect(acquirePermissionModeForTurn).toHaveBeenCalledWith('ask');
    expect(createSession.mock.calls[0]?.[5]).toBe('ask');
    expect(startSession).toHaveBeenCalledOnce();
  });

  test('loads an existing session permission in main before continuing', async () => {
    const acquirePermissionModeForTurn = vi.fn().mockResolvedValue({ success: true });
    const store = {
      getSession: vi.fn().mockReturnValue(session('auto')),
    } as unknown as CoworkStore;
    const continueSession = vi.fn().mockResolvedValue(undefined);
    registerCoworkSessionExecutionHandlers({
      ensureEngineRunning: vi.fn().mockResolvedValue({ phase: 'running' }),
      getCoworkStore: () => store,
      getCoworkEngineRouter: () => ({ continueSession }) as unknown as CoworkEngineRouter,
      acquirePermissionModeForTurn,
      getEngineNotReadyResponse: vi.fn(),
    });

    const result = await handlers.get('cowork:session:continue')?.(
      {},
      { sessionId: 'session-1', prompt: 'continue' },
    );
    expect(result).toMatchObject({ success: true });
    expect(acquirePermissionModeForTurn).toHaveBeenCalledWith('auto');
    expect(continueSession).toHaveBeenCalledOnce();
  });
});
