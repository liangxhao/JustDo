import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appendAgentTeamInstruction } from '../../prompt/agentTeamPrompt';
import type { TeamHostSession as CoworkSession, TeamHostStore as CoworkStore } from '../ports';
import { AgentTeamLaunchCoordinator } from './agentTeamLaunchCoordinator';

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach(db => db.close());
  vi.restoreAllMocks();
});
const sessionId = 'source';
const sessionKey = 'agent:organizer:justdo:source';
const nativeSessionId = 'actual-native';
const clientTurnId = 'current-input';
const prompt = appendAgentTeamInstruction('Private user request', 'group');
const input = { sessionId, clientTurnId, prompt };
const event = {
  sessionKey,
  sessionId: nativeSessionId,
  runId: clientTurnId,
  stream: 'lifecycle',
  data: { phase: 'end', executionSettled: true },
};

function fixture() {
  const native = new DatabaseSync(':memory:');
  databases.push(native);
  native.exec(
    'CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)',
  );
  const source = {
    id: sessionId,
    agentId: 'organizer',
    cwd: '/fixture',
    permissionMode: 'ask',
    executionMode: 'sandbox',
  } as CoworkSession;
  const db = native as unknown as Database.Database;
  const metadata = () => {
    const row = native
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get('agentTeam.launch.receipt.source') as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Record<string, unknown>) : undefined;
  };
  const state = {
    source,
    deleted: false,
    goal: false,
    goalSnapshot: undefined as unknown,
    known: true,
    running: false,
    subagents: false,
    inputExists: false,
    sourceAccepted: false,
    guard: undefined as Record<string, unknown> | undefined,
    plan: undefined as unknown,
    planProjection: undefined as unknown,
    legacyPlanProjection: undefined as unknown,
    nativeGoal: undefined as unknown,
    lifecycleRevision: 'native-revision' as unknown,
    permission: 'guarded',
    history: {
      sessionInfo: { sessionId: nativeSessionId, hasActiveRun: false },
      pendingInputs: { total: 0, items: [] as unknown[] },
      inputReceipts: [] as unknown[],
      inputConsumptions: [] as unknown[],
    },
    lose: new Set<string>(),
    before: undefined as
      ((method: string, params: Record<string, unknown>) => Promise<void>) | undefined,
  };
  const store = {
    getSession: () => (state.deleted ? null : source),
    getSessionByNativeKey: () => null,
    getGoalExecutionSnapshot: () => state.goalSnapshot ?? (state.goal ? { sessionId } : null),
    getSessionRunByClientTurnId: () => ({
      sessionId,
      clientTurnId,
      ...(state.sourceAccepted ? { rootRunId: 'bound-real-run', acceptedAt: 2 } : {}),
    }),
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn(async () => ({
      known: state.known,
      running: state.running || state.subagents,
      mainRunning: state.running,
      subagentRunning: state.subagents,
    })),
    prepareSession: vi.fn(async () => ({ sessionKey, gatewaySessionId: nativeSessionId })),
  };
  const request = vi.fn(async (method: string, raw?: unknown): Promise<unknown> => {
    const params = (raw ?? {}) as Record<string, unknown>;
    await state.before?.(method, params);
    let result: unknown;
    if (method === 'sessions.describe')
      result = {
        session: {
          sessionId: nativeSessionId,
          lifecycleRevision: state.lifecycleRevision,
          permissionMode: state.permission,
          goal: state.nativeGoal,
          planMode: state.planProjection,
          justdoPlanMode: state.legacyPlanProjection,
          pluginExtensions:
            state.plan === undefined
              ? []
              : [{ pluginId: 'plan-mode', namespace: 'state', value: state.plan }],
        },
      };
    else if (method === 'chat.history') result = structuredClone(state.history);
    else if (method === 'agentTeam.launch.inspect')
      result = state.guard
        ? {
            state: state.guard.state,
            generation: state.guard.generation,
            wholeSettled: state.guard.wholeSettled === true,
            launch: structuredClone(state.guard),
          }
        : { state: 'absent', generation: 0 };
    else if (method === 'agentTeam.launch.register') {
      expect(metadata()).toMatchObject({ registerAcknowledged: false, submissionStarted: false });
      const generation = Number(state.guard?.generation ?? 0);
      if (params.expectedGeneration !== generation) throw new Error('generation changed');
      state.guard = {
        ...params,
        lifecycleRevision: 'native-revision',
        state: 'pending',
        generation: generation + 1,
        wholeSettled: false,
      };
      result = {
        state: 'pending',
        nativeSessionId,
        lifecycleRevision: 'native-revision',
        generation: generation + 1,
      };
    } else if (method === 'agentTeam.launch.abandon' && !state.guard) {
      if (params.expectedGeneration !== 0 || params.neverSubmitted !== true || state.inputExists)
        throw new Error('not absent');
      state.guard = {
        ...params,
        lifecycleRevision: 'native-revision',
        state: 'released',
        generation: 1,
      };
      result = { state: 'released' };
    } else {
      if (
        !state.guard ||
        params.clientTurnId !== state.guard.clientTurnId ||
        params.nativeSessionId !== state.guard.nativeSessionId
      )
        throw new Error('identity changed');
      if (method === 'agentTeam.launch.cancel') state.guard.state = 'cancelled';
      else if (method === 'agentTeam.launch.confirm') state.guard.state = 'launched';
      else if (method === 'agentTeam.launch.abandon') {
        if (
          state.inputExists ||
          params.neverSubmitted !== true ||
          state.guard.wholeSettled === true
        )
          throw new Error('input exists');
        state.guard.state = 'released';
      } else if (method === 'agentTeam.launch.release') {
        if (
          params.executionSettled !== true ||
          params.dispatchCleanupComplete !== true ||
          state.guard.wholeSettled !== true
        )
          throw new Error('missing proof');
        state.guard.state = 'released';
      } else throw new Error(`Unsupported fixture method ${method}`);
      result = { state: state.guard.state };
    }
    if (state.lose.has(method)) throw new Error('lost reply');
    return result;
  });
  const deps = {
    getStore: () => store,
    getDatabase: () => db,
    getRouter: () => router,
    requestGateway: <T>(method: string, params?: unknown) => request(method, params) as Promise<T>,
  };
  const coordinator = new AgentTeamLaunchCoordinator(deps);
  const count = (method: string) => request.mock.calls.filter(([name]) => name === method).length;
  const start = async () => {
    await coordinator.register(input);
    coordinator.markSubmissionStarted(sessionId, clientTurnId);
    state.inputExists = true;
    state.sourceAccepted = true;
  };
  return {
    native,
    state,
    router,
    request,
    coordinator,
    metadata,
    count,
    start,
    restart: () => new AgentTeamLaunchCoordinator(deps),
  };
}

describe('explicit Team launch operation ownership', () => {
  it.each(['before-preparation', 'before-registration'] as const)(
    'reports unknown separately and keeps preparation unwritten at %s', async stage => {
      const f = fixture();
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      if (stage === 'before-preparation') f.state.known = false;
      else f.router.getSessionRuntimeStatus.mockResolvedValueOnce({ known: true, running: false, mainRunning: false, subagentRunning: false })
        .mockResolvedValueOnce({ known: false, running: false, mainRunning: false, subagentRunning: false });
      await expect(f.coordinator.register(input)).rejects.toThrow('teamFeatureStatusUnknown');
      expect(f.count('agentTeam.launch.register')).toBe(0);
      expect(f.metadata()).toBeUndefined();
      expect(f.router.prepareSession).toHaveBeenCalledTimes(stage === 'before-preparation' ? 0 : 1);
      expect(warning).toHaveBeenCalledWith('[AgentTeamLaunch] Source admission was not idle:', {
        stage, known: false, running: false, mainRunning: false, subagentRunning: false,
      });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(prompt);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(nativeSessionId);
      if (stage === 'before-registration') expect(f.router.getSessionRuntimeStatus).toHaveBeenLastCalledWith(sessionId,
        { includeSubagents: true, forceRefresh: true, targeted: true, expectedSessionId: nativeSessionId, expectedLifecycleRevision: 'native-revision' });
    },
  );
  it('passes an explicit null revision to the second admission read', async () => {
    const f = fixture(); f.state.lifecycleRevision = null;
    await f.coordinator.register(input);
    expect(f.router.getSessionRuntimeStatus).toHaveBeenLastCalledWith(sessionId, {
      includeSubagents: true, forceRefresh: true, targeted: true,
      expectedSessionId: nativeSessionId, expectedLifecycleRevision: null,
    });
  });
  it.each([undefined, 3, {}])('refuses an unavailable native revision without registering: %j', async revision => {
    const f = fixture(); f.state.lifecycleRevision = revision;
    await expect(f.coordinator.register(input)).rejects.toThrow('teamFeatureStatusUnknown');
    expect(f.count('agentTeam.launch.register')).toBe(0);
    expect(f.metadata()).toBeUndefined();
  });
  it.each([false, true])(
    'uses canonical Plan state over conflicting slot projections: %s',
    async enabled => {
      const f = fixture();
      f.state.plan = { enabled };
      f.state.planProjection = !enabled;
      f.state.legacyPlanProjection = {
        enabled: !enabled,
        awaitingReview: enabled ? undefined : true,
      };
      if (enabled) {
        await expect(f.coordinator.register(input)).rejects.toThrow(
          'teamLaunchContractUnavailable',
        );
        expect(f.count('agentTeam.launch.register')).toBe(0);
      } else {
        await f.coordinator.register(input);
        expect(f.count('agentTeam.launch.register')).toBe(1);
      }
    },
  );

  it('keeps ordinary messages and unowned confirmations on the fast path without Gateway calls', async () => {
    const f = fixture();
    expect(await f.coordinator.register({ ...input, prompt: 'Ordinary message' })).toBeUndefined();
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(true);
    await f.coordinator.confirm({
      sessionKey,
      sourceRunId: clientTurnId,
      mode: 'discussion',
      receiptId: 'receipt',
    });
    f.coordinator.markSubmissionStarted(sessionId, clientTurnId);
    await f.coordinator.cancel(sessionId);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(['group', 'task'] as const)(
    'registers only exact %s selection and persists content-free native metadata',
    async selected => {
      const f = fixture();
      const text = appendAgentTeamInstruction('Private user request', selected);
      await f.coordinator.register({ ...input, prompt: text });
      expect(f.metadata()).toMatchObject({
        sessionKey,
        nativeSessionId,
        clientTurnId,
        promptSha256: createHash('sha256').update(text).digest('hex'),
        lifecycleRevision: 'native-revision',
        expectedGeneration: 0,
        generation: 1,
        registerAcknowledged: true,
        wholeSettled: false,
        mode: selected === 'group' ? 'discussion' : 'collaboration',
      });
      expect(JSON.stringify(f.metadata())).not.toContain('Private user request');
      expect(JSON.stringify(f.metadata())).not.toContain('The user explicitly');
      expect(f.router.getSessionRuntimeStatus).toHaveBeenCalledWith(sessionId, {
        includeSubagents: true,
        forceRefresh: true,
        targeted: true,
      });
      expect(f.request).toHaveBeenCalledWith(
        'agentTeam.launch.register',
        expect.objectContaining({ sessionKey, nativeSessionId, expectedGeneration: 0 }),
      );
    },
  );
  it.each(['group', 'task'] as const)(
    'binds the exact %s input to normal native Unicode/control/trim processing',
    async mode => {
      const f = fixture();
      const text = appendAgentTeamInstruction(' \u0001Discuss cafe\u0301\twith\nthis team', mode);
      const nativeText = appendAgentTeamInstruction('Discuss café\twith\nthis team', mode);
      await f.coordinator.register({ ...input, prompt: text });
      const digest = createHash('sha256').update(nativeText).digest('hex');
      expect(f.metadata()).toMatchObject({ promptSha256: digest, registerAcknowledged: true });
      expect(f.request).toHaveBeenCalledWith(
        'agentTeam.launch.register',
        expect.objectContaining({ promptSha256: digest }),
      );
      // The same native input and client identity remains the same operation.
      await f.coordinator.register({ ...input, prompt: nativeText });
      expect(f.count('agentTeam.launch.register')).toBe(1);
    },
  );
  it('rejects explicit Team input with NUL before native intent registration', async () => {
    const f = fixture();
    await expect(
      f.coordinator.register({
        ...input,
        prompt: appendAgentTeamInstruction('Invalid\u0000request', 'group'),
      }),
    ).rejects.toThrow('teamLaunchContractUnavailable');
    expect(f.request).not.toHaveBeenCalled();
    expect(f.metadata()).toBeUndefined();
    expect(
      await f.coordinator.register({ ...input, prompt: 'Ordinary\u0000message' }),
    ).toBeUndefined();
  });
  it.each(['waiting', 'stopped'])(
    'registers a new Team from a no-Goal %s host snapshot',
    async phase => {
      const f = fixture();
      f.state.goalSnapshot = { sessionId, phase, continuationCount: 0, updatedAt: Date.now() };
      await expect(f.coordinator.register(input)).resolves.toMatchObject({ state: 'pending' });
      expect(f.count('agentTeam.launch.register')).toBe(1);
    },
  );
  it.each([
    { phase: 'stopped', goalId: 'goal' },
    { phase: 'waiting', identityPending: true },
    { phase: 'running' },
    {},
  ])('rejects an unresolved host Goal snapshot %j', async snapshot => {
    const f = fixture();
    f.state.goalSnapshot = snapshot;
    await expect(f.coordinator.register(input)).rejects.toThrow('teamLaunchContractUnavailable');
    expect(f.count('agentTeam.launch.register')).toBe(0);
  });
  it.each(['external', 'goal', 'child'] as const)(
    'rejects the %s source contract before registration',
    async condition => {
      const f = fixture();
      if (condition === 'external')
        f.state.source.external = {} as NonNullable<CoworkSession['external']>;
      if (condition === 'goal') f.state.goal = true;
      if (condition === 'child') f.state.source.nativeParentSessionId = 'parent';
      await expect(f.coordinator.register(input)).rejects.toThrow('teamLaunchContractUnavailable');
      expect(f.count('agentTeam.launch.register')).toBe(0);
    },
  );
  it.each(['guarded', 'workspace', 'full'] as const)(
    'admits native %s permissions in a sandbox without widening them',
    async permission => {
      const f = fixture();
      f.state.permission = permission;
      await expect(f.coordinator.register(input)).resolves.toMatchObject({
        registerAcknowledged: true,
        nativeSessionId,
      });
      expect(f.state.source.executionMode).toBe('sandbox');
      expect(f.state.source.permissionMode).toBe('ask');
      expect(f.state.permission).toBe(permission);
      expect(f.request.mock.calls.some(([method]) => method === 'sessions.patch')).toBe(false);
    },
  );
  it.each(['unknown', 'main', 'subagents'] as const)(
    'rejects %s runtime evidence without inventing idle',
    async condition => {
      const f = fixture();
      if (condition === 'unknown') f.state.known = false;
      if (condition === 'main') f.state.running = true;
      if (condition === 'subagents') f.state.subagents = true;
      await expect(f.coordinator.register(input)).rejects.toThrow(condition === 'unknown' ? 'teamFeatureStatusUnknown' : 'teamFeatureBusy');
      expect(f.router.prepareSession).not.toHaveBeenCalled();
    },
  );
  it.each(['plan', 'review', 'goal', 'restricted'] as const)(
    'rejects native %s metadata before creating an intent',
    async condition => {
      const f = fixture();
      if (condition === 'plan') f.state.plan = { enabled: true };
      if (condition === 'review')
        f.state.plan = { enabled: false, awaitingReview: { requestId: 'pending' } };
      if (condition === 'goal') f.state.nativeGoal = { objective: 'goal' };
      if (condition === 'restricted') f.state.permission = 'read-only';
      await expect(f.coordinator.register(input)).rejects.toThrow('teamLaunchContractUnavailable');
      expect(f.count('agentTeam.launch.register')).toBe(0);
    },
  );
  it('keeps a lost registration reply unknown and never repeats the native registration', async () => {
    const f = fixture();
    f.state.lose.add('agentTeam.launch.register');
    await expect(f.coordinator.register(input)).rejects.toThrow('lost reply');
    expect(f.metadata()).toMatchObject({
      state: 'unknown',
      registerAcknowledged: false,
      submissionStarted: false,
    });
    await expect(f.restart().register(input)).rejects.toThrow('teamLaunchUnconfirmed');
    expect(() => f.coordinator.markSubmissionStarted(sessionId, clientTurnId)).toThrow(
      'teamLaunchUnconfirmed',
    );
    expect(f.count('agentTeam.launch.register')).toBe(1);
    expect(await f.restart().releaseIfSettled(sessionId)).toBe(true);
    expect(f.count('agentTeam.launch.abandon')).toBe(1);
  });
  it('allows no uncertain native registration to proceed after Stop while preparation yields', async () => {
    const f = fixture();
    let finish!: () => void;
    f.router.prepareSession.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ sessionKey, gatewaySessionId: nativeSessionId });
        }),
    );
    const registering = f.coordinator.register(input);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await f.coordinator.cancel(sessionId);
    finish();
    await expect(registering).rejects.toThrow('teamLaunchUnconfirmed');
    expect(f.count('agentTeam.launch.register')).toBe(0);
    expect(f.metadata()).toBeUndefined();
  });
  it('does not let a late register acknowledgement overwrite Stop or permit source sending', async () => {
    const f = fixture();
    let unblock!: () => void;
    f.state.before = async method => {
      if (method === 'agentTeam.launch.register')
        await new Promise<void>(resolve => {
          unblock = resolve;
        });
    };
    const registering = f.coordinator.register(input);
    await vi.waitFor(() => expect(unblock).toBeTypeOf('function'));
    await f.coordinator.cancel(sessionId);
    unblock();
    await expect(registering).rejects.toThrow('teamLaunchUnconfirmed');
    expect(f.metadata()).toMatchObject({ cancelRequested: true, registerAcknowledged: false });
    expect(() => f.coordinator.markSubmissionStarted(sessionId, clientTurnId)).toThrow();
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(true);
  });
  it('confirms only the exact mode and real source client/root binding, once', async () => {
    const f = fixture();
    await f.start();
    const receipt = {
      sessionKey,
      sourceRunId: 'wrong',
      mode: 'discussion' as const,
      receiptId: 'accepted-peer',
    };
    await f.coordinator.confirm(receipt);
    await f.coordinator.confirm({ ...receipt, sourceRunId: clientTurnId, mode: 'collaboration' });
    expect(f.count('agentTeam.launch.confirm')).toBe(0);
    await f.coordinator.confirm({ ...receipt, sourceRunId: 'bound-real-run' });
    await f.coordinator.confirm({ ...receipt, sourceRunId: 'bound-real-run' });
    expect(f.count('agentTeam.launch.confirm')).toBe(1);
    expect(f.metadata()?.state).toBe('launched');
  });
  it('does not cancel the current launch from an old failure callback', async () => {
    const f = fixture();
    await f.start();
    await f.coordinator.cancel(sessionId, 'old-input');
    expect(f.count('agentTeam.launch.cancel')).toBe(0);
    expect(f.metadata()?.cancelRequested).toBe(false);
  });
  it('does not invalidate a new preparation from a failure callback for the released previous intent', async () => {
    const f = fixture();
    await f.start();
    f.state.guard!.wholeSettled = true;
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(true);
    let finish!: () => void;
    f.router.prepareSession.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ sessionKey, gatewaySessionId: nativeSessionId });
        }),
    );
    const registering = f.coordinator.register({ ...input, clientTurnId: 'new-input' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await f.coordinator.cancel(sessionId, clientTurnId);
    finish();
    await expect(registering).resolves.toMatchObject({
      clientTurnId: 'new-input',
      registerAcknowledged: true,
    });
    expect(f.count('agentTeam.launch.cancel')).toBe(0);
  });
});

describe('whole-run and native cleanup reconciliation', () => {
  it.each(['final', 'attempt', 'missing-sid', 'other-sid', 'old-run'] as const)(
    'does not use %s as a whole-run terminal',
    async observation => {
      const f = fixture();
      await f.start();
      const payload =
        observation === 'final'
          ? { ...event, stream: 'assistant' }
          : observation === 'attempt'
            ? { ...event, data: { phase: 'end', executionSettled: false } }
            : observation === 'missing-sid'
              ? { ...event, sessionId: undefined }
              : observation === 'other-sid'
                ? { ...event, sessionId: 'replacement' }
                : { ...event, runId: 'old-input' };
      f.coordinator.observeExecution(payload);
      expect(f.metadata()?.wholeSettled).toBe(false);
      expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(false);
      expect(f.count('agentTeam.launch.release')).toBe(0);
    },
  );
  it('requires the native exact terminal even when Main observed a whole terminal', async () => {
    const f = fixture();
    await f.start();
    f.coordinator.observeExecution(event);
    expect(f.metadata()?.wholeSettled).toBe(true);
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(false);
    expect(f.count('agentTeam.launch.release')).toBe(0);
  });
  it('recovers native whole proof after restart and releases with consumed receipts only after cleanup', async () => {
    const f = fixture();
    await f.start();
    f.state.guard!.wholeSettled = true;
    f.state.history.inputReceipts = [
      { runId: clientTurnId, state: 'consumed', consumedByEventId: 'input-event' },
    ];
    f.state.history.inputConsumptions = [{ runId: clientTurnId, consumedByEventId: 'input-event' }];
    expect(await f.restart().releaseIfSettled(sessionId)).toBe(true);
    expect(f.metadata()).toMatchObject({ state: 'released', wholeSettled: true });
    expect(f.request).toHaveBeenCalledWith('agentTeam.launch.release', {
      sessionKey,
      nativeSessionId,
      clientTurnId,
      executionSettled: true,
      dispatchCleanupComplete: true,
    });
    await expect(
      f.coordinator.register({ ...input, clientTurnId: 'new-input' }),
    ).resolves.toMatchObject({ generation: 2 });
    await expect(f.coordinator.register(input)).rejects.toThrow('teamLaunchUnconfirmed');
  });
  it.each(['unknown', 'running', 'different-sid', 'active', 'pending', 'receipt'] as const)(
    'keeps whole-finished source guarded while %s remains',
    async condition => {
      const f = fixture();
      await f.start();
      f.state.guard!.wholeSettled = true;
      if (condition === 'unknown') f.state.known = false;
      if (condition === 'running') f.state.subagents = true;
      if (condition === 'different-sid') f.state.history.sessionInfo.sessionId = 'replacement';
      if (condition === 'active') f.state.history.sessionInfo.hasActiveRun = true;
      if (condition === 'pending') {
        f.state.history.pendingInputs.total = 1;
        f.state.history.pendingInputs.items = [{}];
      }
      if (condition === 'receipt')
        f.state.history.inputReceipts = [{ runId: clientTurnId, state: 'pending' }];
      expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(false);
      expect(f.count('agentTeam.launch.release')).toBe(0);
    },
  );
  it('does not repeat an uncertain release write; an exact inspection resolves its acknowledgement', async () => {
    const f = fixture();
    await f.start();
    f.state.guard!.wholeSettled = true;
    f.state.lose.add('agentTeam.launch.release');
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(false);
    expect(f.metadata()?.state).toBe('unknown');
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(true);
    expect(f.count('agentTeam.launch.release')).toBe(1);
  });
  it('abandon-releases only an exact never-sent intent, never a lost chat.send acknowledgement', async () => {
    const f = fixture();
    await f.coordinator.register(input);
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(true);
    expect(f.request).toHaveBeenCalledWith(
      'agentTeam.launch.abandon',
      expect.objectContaining({
        expectedGeneration: 0,
        neverSubmitted: true,
        promptSha256: createHash('sha256').update(prompt).digest('hex'),
      }),
    );
    const started = fixture();
    await started.start();
    expect(await started.coordinator.releaseIfSettled(sessionId)).toBe(false);
    expect(started.count('agentTeam.launch.abandon')).toBe(0);
  });
  it('uses an absent generation tombstone after a pre-commit register loss rather than re-registering', async () => {
    const f = fixture();
    f.state.before = async method => {
      if (method === 'agentTeam.launch.register') throw new Error('transport closed before commit');
    };
    await expect(f.coordinator.register(input)).rejects.toThrow('transport closed');
    f.state.before = undefined;
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(true);
    expect(f.state.guard).toMatchObject({ generation: 1, state: 'released', clientTurnId });
    expect(f.count('agentTeam.launch.register')).toBe(1);
  });
  it('point-checks cleanup with the current explicit native revision and never lists sessions', async () => {
    const f = fixture();
    await f.coordinator.register(input);
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(true);
    expect(f.router.getSessionRuntimeStatus).toHaveBeenLastCalledWith(sessionId, {
      includeSubagents: true, forceRefresh: true, targeted: true,
      expectedSessionId: nativeSessionId, expectedLifecycleRevision: 'native-revision',
    });
    expect(f.router.getSessionRuntimeStatus.mock.calls.every(([, options]) =>
      options?.targeted === true && !('fullScan' in options))).toBe(true);
    expect(f.count('sessions.list')).toBe(0);
  });
  it.each([undefined, 0, '', 'replacement-revision'])(
    'keeps cleanup unconfirmed for missing or changed revision %s', async revision => {
      const f = fixture();
      await f.coordinator.register(input);
      f.state.lifecycleRevision = revision;
      expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(false);
      expect(f.count('agentTeam.launch.abandon')).toBe(0);
      expect(f.count('agentTeam.launch.release')).toBe(0);
      expect(f.count('sessions.list')).toBe(0);
    },
  );
  it('recovers a lost local mark acknowledgement only after the owning sender attests it never called native send', async () => {
    const f = fixture();
    await f.coordinator.register(input);
    f.coordinator.markSubmissionStarted(sessionId, clientTurnId);
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(false);
    expect(f.count('agentTeam.launch.abandon')).toBe(0);
    expect(await f.coordinator.abortBeforeSend(sessionId, clientTurnId)).toBe(true);
    expect(f.metadata()).toMatchObject({
      state: 'released',
      submissionStarted: false,
      cancelRequested: true,
    });
  });
  it('rejects a false or old pre-send abort when native acceptance or another intent is already established', async () => {
    const f = fixture();
    await f.start();
    expect(await f.coordinator.abortBeforeSend(sessionId, clientTurnId)).toBe(false);
    expect(await f.coordinator.abortBeforeSend(sessionId, 'old-input')).toBe(false);
    expect(f.count('agentTeam.launch.cancel')).toBe(0);
    expect(f.metadata()?.submissionStarted).toBe(true);
  });
  it('keeps the guard unknown if a purported pre-send abort finds exact native input facts', async () => {
    const f = fixture();
    await f.coordinator.register(input);
    f.coordinator.markSubmissionStarted(sessionId, clientTurnId);
    f.state.inputExists = true;
    expect(await f.coordinator.abortBeforeSend(sessionId, clientTurnId)).toBe(false);
    expect(f.metadata()?.state).toBe('unknown');
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(false);
    expect(f.count('agentTeam.launch.abandon')).toBe(1);
  });
  it('does not upgrade a stale product intent to a mismatched native generation', async () => {
    const f = fixture();
    await f.start();
    f.state.guard!.wholeSettled = true;
    f.state.guard!.generation = 9;
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(false);
    expect(f.metadata()?.generation).toBe(1);
    expect(f.count('agentTeam.launch.release')).toBe(0);
  });
  it('narrows cancellation synchronously, preserves unknown after a lost cancel ACK, and never retries it', async () => {
    const f = fixture();
    await f.start();
    f.state.lose.add('agentTeam.launch.cancel');
    const cancelled = f.coordinator.cancel(sessionId);
    expect(f.metadata()).toMatchObject({ state: 'cancelled', cancelRequested: true });
    expect(() => f.coordinator.markSubmissionStarted(sessionId, clientTurnId)).toThrow();
    await cancelled;
    expect(f.metadata()?.state).toBe('unknown');
    await f.coordinator.cancel(sessionId);
    expect(f.count('agentTeam.launch.cancel')).toBe(1);
    expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(false);
  });
});
