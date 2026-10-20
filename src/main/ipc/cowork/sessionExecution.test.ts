import { EventEmitter } from 'node:events';

import path from 'path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { appendAgentTeamInstruction } from '../../../../openclaw-extensions/agent-team/prompt/agentTeamPrompt';
import { SessionStartIpc } from '../../../shared/cowork/sessionStart';
import type { AgentTeamLaunchCoordinator } from '../../cowork/agent-team/agentTeamLaunchCoordinator';
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

test('keeps Team launch hooks when the first message is delegated to its current viewer', async () => {
  const created = session('ask');
  const frame = { url: 'http://127.0.0.1:43127/' };
  const owner = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    getURL: () => frame.url,
    isDestroyed: () => false,
  });
  const window = { webContents: owner, isDestroyed: () => false };
  const launch = {
    register: vi.fn().mockResolvedValue(undefined),
    markSubmissionStarted: vi.fn().mockResolvedValue(undefined),
    abortBeforeSend: vi.fn().mockResolvedValue(true),
  };
  const startSession = vi.fn(
    async (
      _id: string,
      _prompt: string,
      options: {
        dispatchChatSend?: unknown;
        beforeNativeSend?: () => Promise<void>;
        onNativeSendAbandoned?: () => Promise<void>;
        onAccepted: () => void;
      },
    ) => {
      expect(options.dispatchChatSend).toBeTypeOf('function');
      await options.beforeNativeSend!();
      await options.onNativeSendAbandoned!();
      options.onAccepted();
    },
  );
  registerCoworkSessionExecutionHandlers({
    getMainWindow: () => window as never,
    getAgentTeamLaunch: () => launch as unknown as AgentTeamLaunchCoordinator,
    ensureEngineRunning: vi.fn().mockResolvedValue({ phase: 'running' }),
    getCoworkStore: () =>
      ({
        getConfig: () => ({ workingDirectory: 'C:/project', permissionMode: 'ask' }),
        getAgent: () => ({ enabled: true, model: '' }),
        getSessionRunByClientTurnId: () => undefined,
        createSession: () => created,
        getSession: () => created,
        updateSession: vi.fn(),
      }) as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({ startSession }) as unknown as CoworkEngineRouter,
    waitForConfigUpdates: async () => {},
    getEngineNotReadyResponse: vi.fn(),
  });
  const prompt = appendAgentTeamInstruction('Compare two designs', 'group');
  await expect(
    handlers.get('cowork:session:start')!(
      { sender: owner, senderFrame: frame },
      {
        prompt,
        rendererDispatch: true,
        clientTurnId: 'team-initial-viewer',
      },
    ),
  ).resolves.toMatchObject({ success: true });

  expect(launch.register).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: created.id,
      clientTurnId: 'team-initial-viewer',
      prompt,
    }),
  );
  expect(launch.markSubmissionStarted).toHaveBeenCalledExactlyOnceWith(
    created.id,
    'team-initial-viewer',
  );
  expect(launch.abortBeforeSend).toHaveBeenCalledExactlyOnceWith(created.id, 'team-initial-viewer');
  expect(owner.listenerCount('did-start-navigation')).toBe(0);
});

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
  createdAt: 1,
  updatedAt: 2,
});

describe('worktree first-message admission', () => {
  const setup = () => {
    const created = session('ask');
    const root = path.resolve('native-worktrees', 'task-1');
    let resolveCreation!: (value: unknown) => void;
    const nativeCreation = new Promise(resolve => {
      resolveCreation = resolve;
    });
    const requestGateway = vi.fn((method: string) =>
      method === 'sessions.create' ? nativeCreation : Promise.resolve({ ok: true, deleted: true }),
    );
    const store = {
      getConfig: () => ({ workingDirectory: created.cwd, permissionMode: 'ask' }),
      getAgent: () => ({ enabled: true, model: '' }),
      createSession: () => created,
      getSession: () => created,
      getSessionRunByClientTurnId: () => undefined,
      updateSession: vi.fn((_id: string, changes: Partial<CoworkSession>) =>
        Object.assign(created, changes),
      ),
      bindNativeSession: vi.fn((_id: string, key: string) => {
        created.nativeSessionKey = key;
      }),
      deleteSession: vi.fn(),
    };
    const startSession = vi.fn(
      async (_id: string, _prompt: string, options: { onAccepted: () => void }) => {
        options.onAccepted();
      },
    );
    registerCoworkSessionExecutionHandlers({
      ensureEngineRunning: vi.fn().mockResolvedValue({ phase: 'running' }),
      getCoworkStore: () => store as unknown as CoworkStore,
      getCoworkEngineRouter: () => ({ startSession }) as unknown as CoworkEngineRouter,
      waitForConfigUpdates: async () => {},
      getEngineNotReadyResponse: vi.fn(),
      requestGateway: requestGateway as <T>(method: string, params?: unknown) => Promise<T>,
    });
    const resolve = () =>
      resolveCreation({
        key: 'agent:main:justdo:session-1',
        sessionId: 'native-1',
        entry: { sessionRoot: root, permissionMode: 'guarded', worktree: { id: 'tree-1' } },
        worktree: { id: 'tree-1', path: root },
      });
    const start = () =>
      handlers.get('cowork:session:start')!(
        {},
        {
          prompt: 'work independently',
          worktree: true,
          clientTurnId: 'worktree-client-1',
        },
      ) as Promise<unknown>;
    return { start, resolve, requestGateway, store, startSession, root };
  };

  test('waits for worktree preparation and sends the first message in the confirmed checkout', async () => {
    const fixture = setup();
    const pending = fixture.start();
    await vi.waitFor(() => expect(fixture.requestGateway).toHaveBeenCalled());
    expect(fixture.startSession).not.toHaveBeenCalled();
    fixture.resolve();
    await expect(pending).resolves.toMatchObject({ success: true, session: { cwd: fixture.root } });
    expect(fixture.startSession).toHaveBeenCalledWith(
      'session-1',
      'work independently',
      expect.objectContaining({ workspaceRoot: fixture.root }),
    );
  });

  test('cleans a cancelled native creation without submitting a message', async () => {
    const fixture = setup();
    const pending = fixture.start();
    await vi.waitFor(() => expect(fixture.requestGateway).toHaveBeenCalled());
    await handlers.get(SessionStartIpc.Cancel)!({}, { clientTurnId: 'worktree-client-1' });
    fixture.resolve();
    await expect(pending).resolves.toMatchObject({ success: false, cancelled: true });
    expect(fixture.requestGateway).toHaveBeenCalledWith('sessions.delete', {
      key: 'agent:main:justdo:session-1',
      deleteTranscript: true,
    });
    expect(fixture.store.deleteSession).toHaveBeenCalledWith('session-1');
    expect(fixture.startSession).not.toHaveBeenCalled();
  });
});

describe('initial admission cancellation', () => {
  const setup = (preparation?: 'config' | 'engine') => {
    let timing:
      | { id: string; sessionId: string; clientTurnId: string; startedAt: number; state: string }
      | undefined;
    const createdSession = session('ask');
    const createSession = vi.fn(() => createdSession);
    const startSession = vi.fn(() => new Promise<void>(() => undefined));
    const stopSession = vi.fn().mockResolvedValue(undefined);
    const cancelLaunch = vi.fn().mockResolvedValue(undefined);
    const store = {
      getConfig: () => ({ workingDirectory: 'C:/project', permissionMode: 'ask' }),
      getAgent: () => ({ enabled: true, model: '' }),
      createSession,
      updateSession: vi.fn(),
      getSession: () => createdSession,
      getSessionRunByClientTurnId: () => timing,
      getLatestSessionRun: vi.fn(() => timing),
      beginSessionRun: (input: { sessionId: string; clientTurnId: string; startedAt: number }) => {
        timing = { ...input, id: 'receipt-1', state: 'running' };
        return timing;
      },
      finishSessionRun: vi.fn((_id: string, state: string) => {
        if (timing) timing = { ...timing, state };
        return timing;
      }),
    };
    const ensureEngineRunning = vi.fn(() =>
      preparation === 'engine'
        ? new Promise<never>(() => undefined)
        : Promise.resolve({ phase: 'running' as const, message: '' }),
    );
    registerCoworkSessionExecutionHandlers({
      getAgentTeamLaunch: () => ({ cancel: cancelLaunch }) as unknown as AgentTeamLaunchCoordinator,
      ensureEngineRunning: ensureEngineRunning as never,
      waitForConfigUpdates: () =>
        preparation === 'config' ? new Promise<void>(() => undefined) : Promise.resolve(),
      getCoworkStore: () => store as unknown as CoworkStore,
      getCoworkEngineRouter: () => ({ startSession, stopSession }) as unknown as CoworkEngineRouter,
      getEngineNotReadyResponse: vi.fn(),
    });
    const start = () =>
      handlers.get('cowork:session:start')!(
        {},
        {
          prompt: 'slow model',
          clientTurnId: 'client-1',
          startedAt: 100,
        },
      ) as Promise<unknown>;
    const cancel = () =>
      handlers.get(SessionStartIpc.Cancel)!({}, { clientTurnId: 'client-1' }) as Promise<unknown>;
    return {
      start,
      cancel,
      startSession,
      stopSession,
      cancelLaunch,
      createSession,
      store,
      ensureEngineRunning,
    };
  };

  test('cancels an initial run without waiting for a lost admission acknowledgement', async () => {
    const fixture = setup();
    const starting = fixture.start();
    await vi.waitFor(() => expect(fixture.startSession).toHaveBeenCalled());
    await expect(fixture.cancel()).resolves.toEqual({ success: true });
    expect(fixture.stopSession).toHaveBeenCalledWith('session-1', {
      diagnosticUserInitiated: true,
    });
    await expect(starting).resolves.toMatchObject({ success: true, timing: { state: 'aborted' } });
  });

  test.each([false, true])(
    'stops an initial run while Team guard cancellation is pending (admitted=%s)',
    async admitted => {
      const fixture = setup();
      let finishGuard!: () => void;
      fixture.cancelLaunch.mockImplementation(
        () =>
          new Promise<void>(resolve => {
            finishGuard = resolve;
          }),
      );
      if (admitted) fixture.startSession.mockResolvedValueOnce(undefined);
      const starting = fixture.start();
      await vi.waitFor(() => expect(fixture.startSession).toHaveBeenCalled());
      if (admitted) await starting;
      const stopping = fixture.cancel();
      await vi.waitFor(() =>
        expect(fixture.stopSession).toHaveBeenCalledWith('session-1', {
          diagnosticUserInitiated: true,
        }),
      );
      expect(fixture.cancelLaunch).toHaveBeenCalledWith('session-1', 'client-1');
      await expect(stopping).resolves.toEqual({ success: true });
      await starting;
      finishGuard();
    },
  );

  test.each(['config', 'engine'] as const)(
    'cancels during %s preparation without creating a run',
    async preparation => {
      const fixture = setup(preparation);
      const starting = fixture.start();
      if (preparation === 'engine')
        await vi.waitFor(() => expect(fixture.ensureEngineRunning).toHaveBeenCalled());
      await expect(fixture.cancel()).resolves.toEqual({ success: true });
      await expect(starting).resolves.toEqual({ success: false, cancelled: true });
      expect(fixture.createSession).not.toHaveBeenCalled();
      expect(fixture.startSession).not.toHaveBeenCalled();
    },
  );

  test('keeps uncertain admission cancellable after a failed stop', async () => {
    const fixture = setup();
    fixture.stopSession.mockRejectedValueOnce(new Error('unconfirmed abort'));
    const starting = fixture.start();
    let admitted = false;
    void starting.then(() => {
      admitted = true;
    });
    await vi.waitFor(() => expect(fixture.startSession).toHaveBeenCalled());
    await expect(fixture.cancel()).resolves.toEqual({ success: false, error: 'unconfirmed abort' });
    expect(admitted).toBe(false);
    expect(fixture.store.finishSessionRun).not.toHaveBeenCalled();
    await expect(fixture.cancel()).resolves.toEqual({ success: true });
    await expect(starting).resolves.toMatchObject({ timing: { state: 'aborted' } });
  });

  test('rejects an old start cancellation when a different receipt owns the session', async () => {
    const fixture = setup();
    const starting = fixture.start();
    await vi.waitFor(() => expect(fixture.startSession).toHaveBeenCalled());
    await fixture.cancel();
    await starting;
    const timing = fixture.store.getSessionRunByClientTurnId()!;
    timing.state = 'running';
    fixture.store.getLatestSessionRun.mockReturnValue({ ...timing, id: 'new-receipt' });
    fixture.stopSession.mockClear();
    await expect(fixture.cancel()).resolves.toMatchObject({ success: false });
    expect(fixture.stopSession).not.toHaveBeenCalled();
  });
});

describe('cowork session execution permissions', () => {
  beforeEach(() => handlers.clear());

  test('uses the persisted new-session default and ignores a renderer-supplied mode', async () => {
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
      listAgents: () => [{ id: 'main', enabled: true, isDefault: true }],
      getAgent: vi.fn().mockReturnValue({ enabled: true, model: 'openai/gpt-5' }),
    } as unknown as CoworkStore;
    const startSession = vi.fn(
      (_sessionId: string, _prompt: string, options?: { onAccepted?: () => void }) => {
        options?.onAccepted?.();
        return new Promise<void>(() => undefined);
      },
    );
    registerCoworkSessionExecutionHandlers({
      ensureEngineRunning: vi.fn().mockResolvedValue({ phase: 'running' }),
      getCoworkStore: () => store,
      getCoworkEngineRouter: () => ({ startSession }) as unknown as CoworkEngineRouter,
      waitForConfigUpdates: vi.fn().mockResolvedValue(undefined),
      getEngineNotReadyResponse: vi.fn(),
    });

    const result = await handlers.get('cowork:session:start')?.(
      {},
      {
        prompt: 'hello',
        gatewayPrompt:
          '<<<EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>context<<<END_EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>\n\nhello',
        permissionMode: 'ask',
      },
    );
    expect(result).toMatchObject({ success: true });
    expect(createSession.mock.calls[0]?.[5]).toBe('full');
    // Legacy main profile models must not override the composer/application selection.
    expect(createSession.mock.calls[0]?.[6]).toBeUndefined();
    expect(startSession).toHaveBeenCalledWith(
      'session-1',
      '<<<EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>context<<<END_EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>\n\nhello',
      expect.objectContaining({ workspaceRoot: 'C:\\workspace' }),
    );
  });

  test('admits image-only first messages and preserves their attachments', async () => {
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
      listAgents: () => [{ id: 'main', enabled: true, isDefault: true }],
      getAgent: vi.fn().mockReturnValue({ enabled: true, model: 'openai/gpt-5' }),
    } as unknown as CoworkStore;
    const startSession = vi.fn(
      (_sessionId: string, _prompt: string, options?: { onAccepted?: () => void }) => {
        options?.onAccepted?.();
        return new Promise<void>(() => undefined);
      },
    );
    registerCoworkSessionExecutionHandlers({
      ensureEngineRunning: vi.fn().mockResolvedValue({ phase: 'running' }),
      getCoworkStore: () => store,
      getCoworkEngineRouter: () => ({ startSession }) as unknown as CoworkEngineRouter,
      waitForConfigUpdates: vi.fn().mockResolvedValue(undefined),
      getEngineNotReadyResponse: vi.fn(),
    });

    const result = await handlers.get('cowork:session:start')?.(
      {},
      {
        prompt: '',
        attachments: [{ name: 'image.png', mimeType: 'image/png', base64Data: 'aGVsbG8=' }],
        permissionMode: 'ask',
      },
    );
    expect(result).toMatchObject({ success: true });
    expect(createSession.mock.calls[0]?.[5]).toBe('full');
    // Legacy main profile models must not override the composer/application selection.
    expect(createSession.mock.calls[0]?.[6]).toBeUndefined();
    expect(startSession).toHaveBeenCalledWith(
      'session-1',
      '',
      expect.objectContaining({
        attachments: [{ name: 'image.png', mimeType: 'image/png', base64Data: 'aGVsbG8=' }],
      }),
    );
  });

  test('waits for queued config writes before reading the new-session default', async () => {
    let releaseConfig!: () => void;
    const waitForConfigUpdates = vi.fn(
      () =>
        new Promise<void>(resolve => {
          releaseConfig = resolve;
        }),
    );
    const ensureEngineRunning = vi.fn().mockResolvedValue({ phase: 'running' });
    const createSession = vi.fn().mockReturnValue(session('ask'));
    const store = {
      getConfig: () => ({
        workingDirectory: 'C:\\workspace',
        executionMode: 'local',
        agentEngine: 'openclaw',
        permissionMode: 'ask',
      }),
      createSession,
      updateSession: vi.fn(),
      addMessage: vi.fn(),
      getSession: vi.fn().mockReturnValue(session('ask')),
      listAgents: () => [{ id: 'main', enabled: true, isDefault: true }],
      getAgent: vi.fn().mockReturnValue({ enabled: true, model: '' }),
    } as unknown as CoworkStore;
    registerCoworkSessionExecutionHandlers({
      ensureEngineRunning,
      getCoworkStore: () => store,
      getCoworkEngineRouter: () =>
        ({ startSession: vi.fn().mockResolvedValue(undefined) }) as unknown as CoworkEngineRouter,
      waitForConfigUpdates,
      getEngineNotReadyResponse: vi.fn(),
    });

    const pending = handlers.get('cowork:session:start')?.(
      {},
      { prompt: 'hello', cwd: 'C:\\workspace', permissionMode: 'full' },
    ) as Promise<unknown>;
    await Promise.resolve();
    expect(ensureEngineRunning).not.toHaveBeenCalled();

    releaseConfig();
    await expect(pending).resolves.toMatchObject({ success: true });
    expect(createSession.mock.calls[0]?.[5]).toBe('ask');
  });

  test('replays a start request without creating or starting a second session', async () => {
    const existingSession = { ...session('ask'), status: 'running' as const };
    const existingTiming = {
      id: 'timing-1',
      sessionId: existingSession.id,
      clientTurnId: 'turn-1',
      rootRunId: 'run-1',
      startedAt: 1_000,
      state: 'running' as const,
    };
    const createSession = vi.fn();
    const startSession = vi.fn();
    const ensureEngineRunning = vi.fn();
    const store = {
      getSessionRunByClientTurnId: vi.fn().mockReturnValue(existingTiming),
      getSession: vi.fn().mockReturnValue(existingSession),
      createSession,
    } as unknown as CoworkStore;
    registerCoworkSessionExecutionHandlers({
      ensureEngineRunning,
      getCoworkStore: () => store,
      getCoworkEngineRouter: () => ({ startSession }) as unknown as CoworkEngineRouter,
      waitForConfigUpdates: vi.fn().mockResolvedValue(undefined),
      getEngineNotReadyResponse: vi.fn(),
    });

    await expect(
      handlers.get('cowork:session:start')?.(
        {},
        { prompt: 'hello', clientTurnId: 'turn-1', startedAt: 1_000 },
      ),
    ).resolves.toEqual({ success: true, session: existingSession, timing: existingTiming });
    expect(ensureEngineRunning).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  test('rejects an empty prompt before creating a session', async () => {
    const createSession = vi.fn();
    const store = {
      getSessionRunByClientTurnId: vi.fn(),
      createSession,
    } as unknown as CoworkStore;
    const ensureEngineRunning = vi.fn();
    registerCoworkSessionExecutionHandlers({
      ensureEngineRunning,
      getCoworkStore: () => store,
      getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
      waitForConfigUpdates: vi.fn(),
      getEngineNotReadyResponse: vi.fn(),
    });

    await expect(handlers.get('cowork:session:start')?.({}, { prompt: '   ' })).resolves.toEqual({
      success: false,
      error: 'Prompt is required.',
    });
    expect(ensureEngineRunning).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  test.each(['research', 'helper', 'unknown'])(
    'rejects non-main agent %s for user conversations',
    async agentId => {
      const ensureEngineRunning = vi.fn();
      registerCoworkSessionExecutionHandlers({
        ensureEngineRunning,
        getCoworkStore: () => ({ getConfig: () => ({}) }) as CoworkStore,
        getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
        waitForConfigUpdates: vi.fn(),
        getEngineNotReadyResponse: vi.fn(),
      });

      await expect(
        handlers.get('cowork:session:start')?.({}, { prompt: 'hello', agentId }),
      ).resolves.toEqual({
        success: false,
        error: 'agentUnavailable',
      });
      expect(ensureEngineRunning).not.toHaveBeenCalled();
    },
  );

  test('returns an asynchronous runtime admission failure and preserves the error state', async () => {
    const createdSession = { ...session('ask'), status: 'idle' as const };
    const updateSession = vi.fn((_sessionId: string, updates: Partial<CoworkSession>) =>
      Object.assign(createdSession, updates),
    );
    const store = {
      getConfig: () => ({
        workingDirectory: 'C:\\workspace',
        executionMode: 'local',
        permissionMode: 'ask',
      }),
      createSession: vi.fn().mockReturnValue(createdSession),
      updateSession,
      getSession: vi.fn().mockImplementation(() => createdSession),
      listAgents: () => [{ id: 'main', enabled: true, isDefault: true }],
      getAgent: vi.fn().mockReturnValue({ enabled: true, model: '' }),
    } as unknown as CoworkStore;
    registerCoworkSessionExecutionHandlers({
      ensureEngineRunning: vi.fn().mockResolvedValue({ phase: 'running' }),
      getCoworkStore: () => store,
      getCoworkEngineRouter: () =>
        ({
          startSession: vi.fn().mockRejectedValue(new Error('gateway unavailable')),
        }) as unknown as CoworkEngineRouter,
      waitForConfigUpdates: vi.fn().mockResolvedValue(undefined),
      getEngineNotReadyResponse: vi.fn(),
    });

    await expect(
      handlers.get('cowork:session:start')?.({}, { prompt: 'hello' }),
    ).resolves.toMatchObject({ success: false, error: 'gateway unavailable' });
    await vi.waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith(createdSession.id, { status: 'error' }),
    );
    expect(createdSession.status).toBe('error');
  });
});

test.each([undefined, { enabled: false, model: '' }])(
  'rejects an unavailable selected role before persisting a session',
  async agent => {
    const createSession = vi.fn();
    registerCoworkSessionExecutionHandlers({
      ensureEngineRunning: vi.fn().mockResolvedValue({ phase: 'running' }),
      getCoworkStore: () =>
        ({
          getConfig: () => ({ workingDirectory: 'C:/project' }),
          getAgent: () => agent,
          createSession,
        }) as unknown as CoworkStore,
      getCoworkEngineRouter: () => ({ startSession: vi.fn() }) as unknown as CoworkEngineRouter,
      waitForConfigUpdates: async () => {},
      getEngineNotReadyResponse: vi.fn(),
    });
    await expect(
      handlers.get('cowork:session:start')?.({}, { prompt: 'hello', agentId: 'main' }),
    ).resolves.toMatchObject({ success: false, error: 'agentUnavailable' });
    expect(createSession).not.toHaveBeenCalled();
  },
);

test('uses main even when a specialist was previously configured as the default', async () => {
  const created = { ...session('ask'), agentId: 'main' };
  const createSession = vi.fn().mockReturnValue(created);
  const startSession = vi.fn().mockResolvedValue(undefined);
  registerCoworkSessionExecutionHandlers({
    ensureEngineRunning: vi.fn().mockResolvedValue({ phase: 'running' }),
    getCoworkStore: () =>
      ({
        getConfig: () => ({ workingDirectory: 'C:/project' }),
        listAgents: () => [{ id: 'research', enabled: true, isDefault: true }],
        getAgent: () => ({ enabled: true, model: '' }),
        createSession,
        getSession: () => created,
        updateSession: vi.fn(),
      }) as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({ startSession }) as unknown as CoworkEngineRouter,
    waitForConfigUpdates: async () => {},
    getEngineNotReadyResponse: vi.fn(),
  });
  await expect(
    handlers.get('cowork:session:start')?.({}, { prompt: 'hello' }),
  ).resolves.toMatchObject({ success: true });
  expect(createSession.mock.calls[0][4]).toBe('main');
  expect(startSession).toHaveBeenCalledWith(
    created.id,
    'hello',
    expect.objectContaining({ agentId: 'main', workspaceRoot: createSession.mock.calls[0][1] }),
  );
});

test('rejects a direct conversation with a peer before preparing any runtime', async () => {
  const ensureEngineRunning = vi.fn();
  const getCoworkStore = vi.fn(
    () => ({ getConfig: () => ({ allowMainAgentSwitch: false }) }) as CoworkStore,
  );
  registerCoworkSessionExecutionHandlers({
    ensureEngineRunning,
    getCoworkStore,
    getCoworkEngineRouter: vi.fn(),
    waitForConfigUpdates: vi.fn(),
    getEngineNotReadyResponse: vi.fn(),
  });
  await expect(
    handlers.get('cowork:session:start')?.({}, { prompt: 'hello', agentId: 'research' }),
  ).resolves.toMatchObject({ success: false, error: 'agentUnavailable' });
  expect(ensureEngineRunning).not.toHaveBeenCalled();
  expect(getCoworkStore).toHaveBeenCalled();
});

test.each([
  { enabled: true, deletedAt: undefined, allowed: true },
  { enabled: false, deletedAt: undefined, allowed: false },
  { enabled: true, deletedAt: 123, allowed: false },
])(
  'routes an opted-in specialist only when available: %j',
  async ({ enabled, deletedAt, allowed }) => {
    const created = { ...session('ask'), agentId: 'research' };
    const createSession = vi.fn().mockReturnValue(created);
    const startSession = vi.fn().mockResolvedValue(undefined);
    registerCoworkSessionExecutionHandlers({
      ensureEngineRunning: vi.fn().mockResolvedValue({ phase: 'running' }),
      getCoworkStore: () =>
        ({
          getConfig: () => ({ workingDirectory: 'C:/project', allowMainAgentSwitch: true }),
          getAgent: () => ({ enabled, deletedAt, model: 'provider/research-model' }),
          createSession,
          getSession: () => created,
          updateSession: vi.fn(),
        }) as unknown as CoworkStore,
      getCoworkEngineRouter: () => ({ startSession }) as unknown as CoworkEngineRouter,
      waitForConfigUpdates: async () => {},
      getEngineNotReadyResponse: vi.fn(),
    });
    const result = await handlers.get('cowork:session:start')?.(
      {},
      { prompt: 'hello', agentId: 'research' },
    );
    if (!allowed) {
      expect(result).toEqual({ success: false, error: 'agentUnavailable' });
      expect(createSession).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ success: true, session: { agentId: 'research' } });
    expect(createSession.mock.calls[0][4]).toBe('research');
    expect(createSession.mock.calls[0][6]).toBe('provider/research-model');
    expect(startSession).toHaveBeenCalledWith(
      created.id,
      'hello',
      expect.objectContaining({
        agentId: 'research',
        workspaceRoot: createSession.mock.calls[0][1],
      }),
    );
  },
);

describe('homepage App adoption at first-message admission', () => {
  const input = {
    prompt: 'Summarize my current drawing',
    rendererDispatch: true,
    clientTurnId: 'fixture-first-send',
    appWorkspaceRequestId: '12345678-1234-1234-1234-123456789abc',
  };
  const setup = async (fails = false, launch?: Partial<AgentTeamLaunchCoordinator>) => {
    const cwd = path.resolve('first-send-fixture');
    const frame = { url: 'http://127.0.0.1:43127/' };
    const owner = Object.assign(new EventEmitter(), {
      mainFrame: frame,
      getURL: () => frame.url,
      isDestroyed: () => false,
    });
    const row = session('auto');
    row.cwd = cwd;
    const createSession = vi.fn((...args: unknown[]) => ({ ...row, id: args[9] as string }));
    let persisted = row;
    const store = {
      getConfig: () => ({ workingDirectory: cwd, permissionMode: 'auto' }),
      getAgent: () => ({ enabled: true, model: '' }),
      getSessionRunByClientTurnId: () => undefined,
      createSession: (...args: unknown[]) => (persisted = createSession(...args)),
      getSession: () => persisted,
      updateSession: vi.fn(),
    };
    const native = {
      sessionId: 'native-app',
      lifecycleRevision: 'revision-app',
      sessionRoot: cwd,
      permissionMode: 'workspace',
    };
    const request = vi.fn(async (method: string, raw: unknown) =>
      method === 'sessions.create'
        ? {
            key: (raw as { key: string }).key,
            sessionId: native.sessionId,
            entry: native,
            runStarted: false,
          }
        : { session: native },
    );
    const { WorkspaceAppSessions } = await import('../../plugins/mcp/workspaceAppSession');
    const workspaces = new WorkspaceAppSessions({
      getStore: () => store as unknown as CoworkStore,
      request: request as never,
    });
    const binding = await workspaces.prepare(owner as never, {
      requestId: input.appWorkspaceRequestId,
      cwd,
      agentId: 'main',
    });
    const startSession = vi.fn(
      async (
        _id: string,
        _prompt: string,
        options: { expectedInitialSessionId?: string; onAccepted: () => void },
      ) => {
        expect(options.expectedInitialSessionId).toBe(native.sessionId);
        if (fails) throw new Error('initial sender unavailable');
        options.onAccepted();
      },
    );
    registerCoworkSessionExecutionHandlers({
      workspaceAppSessions: workspaces,
      getMainWindow: () => ({ webContents: owner, isDestroyed: () => false }) as never,
      ...(launch ? { getAgentTeamLaunch: () => launch as AgentTeamLaunchCoordinator } : {}),
      ensureEngineRunning: async () => ({ phase: 'running' }) as never,
      getCoworkStore: () => store as unknown as CoworkStore,
      getCoworkEngineRouter: () =>
        ({
          startSession,
          stopSession: vi.fn().mockResolvedValue(undefined),
        }) as unknown as CoworkEngineRouter,
      waitForConfigUpdates: async () => {},
      getEngineNotReadyResponse: vi.fn(),
    });
    const start = (overrides: Partial<typeof input> = {}) =>
      handlers.get('cowork:session:start')!(
        { sender: owner, senderFrame: frame },
        { ...input, ...overrides },
      ) as Promise<Record<string, unknown>>;
    return { start, owner, workspaces, binding, createSession, startSession, request, native };
  };

  test('uses the preview reserved identity and checks its native incarnation before sending', async () => {
    const f = await setup();
    const result = await f.start();
    expect(result.success).toBe(true);
    const created = result.session as CoworkSession;
    expect(f.binding.sessionKey).toBe(`agent:main:justdo:${created.id}`);
    expect(f.createSession).toHaveBeenCalledOnce();
    expect(f.startSession).toHaveBeenCalledOnce();
    await f.workspaces.release(f.owner as never, input.appWorkspaceRequestId);
    expect(f.request.mock.calls.some(([method]) => method === 'sessions.delete')).toBe(false);
  });

  test('retains the adopted conversation when preparation fails before native send', async () => {
    const f = await setup(true);
    const result = await f.start();
    expect(result).toMatchObject({
      success: false,
      error: 'initial sender unavailable',
      session: { id: expect.any(String) },
    });
    f.owner.emit('destroyed');
    expect(f.request.mock.calls.some(([method]) => method === 'sessions.delete')).toBe(false);
  });

  test('does not adopt an App workspace whose native generation changed', async () => {
    const f = await setup();
    f.native.sessionId = 'changed';
    expect(await f.start()).toMatchObject({ success: false });
    expect(f.createSession).not.toHaveBeenCalled();
    expect(f.startSession).not.toHaveBeenCalled();
  });

  test('returns the adopted conversation when Team preparation is cancelled', async () => {
    let finishRegistration!: () => void;
    const registration = new Promise<void>(resolve => {
      finishRegistration = resolve;
    });
    const launch = {
      register: vi.fn(() => registration),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const f = await setup(false, launch as never);
    const starting = f.start({ prompt: appendAgentTeamInstruction(input.prompt, 'group') });
    await vi.waitFor(() => expect(launch.register).toHaveBeenCalledOnce());
    await expect(
      handlers.get(SessionStartIpc.Cancel)!({}, { clientTurnId: input.clientTurnId }),
    ).resolves.toMatchObject({ success: true });
    finishRegistration();
    await expect(starting).resolves.toMatchObject({
      success: false,
      cancelled: true,
      session: { id: expect.any(String) },
    });
    expect(f.startSession).not.toHaveBeenCalled();
    f.owner.emit('destroyed');
    expect(f.request.mock.calls.some(([method]) => method === 'sessions.delete')).toBe(false);
  });
});
