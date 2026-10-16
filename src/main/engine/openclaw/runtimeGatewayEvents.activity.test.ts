import { beforeEach, expect, test, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
  },
}));
vi.mock('../../cowork/coworkLogger', () => ({ coworkLog: vi.fn() }));
vi.mock('../../providers/providerApiConfig', () => ({ resolveCurrentApiConfig: vi.fn() }));

import { groupSessionsByDate } from '../../../renderer/features/cowork/sessionPresentation';
import { createDefaultAgentRuntimeSettings } from '../../../shared/agents/agentRuntimeSettings';
import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import { CoworkEngineRouter } from '../cowork/coworkEngineRouter';
import { bindCoworkRuntimeForwarder } from '../cowork/coworkRuntimeForwarder';
import type { GatewayClientLike, GatewayEventFrame, SessionTurn } from '../gateway/types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

const today = new Date(2026, 9, 16, 12).getTime();
const yesterday = today - 86_400_000;
const sessionKey = 'agent:main:activity-history';
const nativeSessionId = 'native-history';
const nativeRow = { key: sessionKey, sessionId: nativeSessionId };

beforeEach(() => vi.clearAllMocks());

function fixture(turnIdentity: 'bound' | 'unbound' | 'absent' = 'bound') {
  const session = {
    id: 'history',
    title: 'Historical chat',
    status: 'running',
    pinned: false,
    cwd: process.cwd(),
    executionMode: 'local',
    permissionMode: 'full',
    activeSkillIds: [],
    agentId: 'main',
    createdAt: yesterday,
    updatedAt: yesterday,
  } satisfies CoworkSession;
  const getSession = vi.fn((id: string) => (id === session.id ? session : null));
  const store = {
    getSession,
    getAgentRuntimeSettings: createDefaultAgentRuntimeSettings,
    updateSession: vi.fn(),
    recordSessionActivity: (id: string, timestamp: number) => {
      if (getSession(id)) session.updatedAt = Math.max(session.updatedAt, timestamp);
    },
  } as unknown as CoworkStore;
  const adapter = new OpenClawRuntimeAdapter(store, {} as never);
  adapter.rememberSessionKey(session.id, sessionKey);
  const request = vi.fn().mockResolvedValue({ session: nativeRow });
  const internals = adapter as unknown as {
    handleGatewayEvent: (event: GatewayEventFrame) => void;
    gatewayClient: GatewayClientLike;
    gatewayClientGeneration: number;
    activeTurns: Map<string, SessionTurn>;
    sessionActivityChecks: Map<string, Set<symbol>>;
  };
  internals.gatewayClient = { request } as unknown as GatewayClientLike;
  if (turnIdentity !== 'absent') {
    internals.activeTurns.set(session.id, {
      sessionId: session.id,
      sessionKey,
      runId: 'active-from-yesterday',
      turnToken: 1,
      gatewaySessionId: turnIdentity === 'bound' ? nativeSessionId : null,
      stopRequested: false,
      knownRunIds: new Set(['active-from-yesterday']),
    });
  }
  bindCoworkRuntimeForwarder(new CoworkEngineRouter({ openclawRuntime: adapter }), () => store);
  const receive = (payload: Record<string, unknown>) =>
    internals.handleGatewayEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey,
        reason: 'send',
        ts: today,
        session: { ...nativeRow, hasActiveRun: true, status: 'running' },
        ...payload,
      },
    });
  const settle = () => vi.waitFor(() => expect(internals.sessionActivityChecks.size).toBe(0));
  const activityEvents = () =>
    send.mock.calls.filter(([channel]) => channel === 'cowork:session:activity');
  return { session, store, getSession, internals, request, receive, settle, activityEvents };
}

test.each(['bound', 'unbound', 'absent'] as const)(
  'moves accepted queued input to Today with %s execution tracking, without starting a run',
  async identity => {
    const f = fixture(identity);
    const turn = f.internals.activeTurns.get(f.session.id);
    expect(groupSessionsByDate([f.session], today)[0].key).toBe('yesterday');

    f.receive({});
    await f.settle();

    expect(f.request).toHaveBeenCalledExactlyOnceWith('sessions.describe', { key: sessionKey });
    expect(f.session.updatedAt).toBe(today);
    expect(groupSessionsByDate([f.session], today)[0].key).toBe('today');
    expect(f.activityEvents()).toEqual([
      [
        'cowork:session:activity',
        {
          sessionId: f.session.id,
          kind: 'other',
          timestamp: today,
        },
      ],
    ]);
    expect(f.internals.activeTurns.get(f.session.id)).toBe(turn);
    expect(f.store.updateSession).not.toHaveBeenCalled();
  },
);

test.each([
  { reason: 'chat.title' },
  { reason: 'update' },
  { ts: NaN },
  { ts: -1 },
  { ts: undefined },
  { session: { ...nativeRow, sessionId: 'old-incarnation', hasActiveRun: true } },
])('ignores non-input or invalid activity metadata: %j', async payload => {
  const f = fixture();
  f.receive(payload);
  await f.settle();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.activityEvents()).toEqual([]);
  expect(f.session.updatedAt).toBe(yesterday);
});

test.each([
  null,
  { ...nativeRow, sessionId: 'replaced-incarnation' },
  { ...nativeRow, key: 'another-session' },
])('rejects a mismatched authoritative session lookup: %j', async row => {
  const f = fixture('absent');
  f.request.mockResolvedValue({ session: row });
  f.receive({});
  await f.settle();
  expect(f.activityEvents()).toEqual([]);
  expect(f.session.updatedAt).toBe(yesterday);
});

test('does not establish activity when native identity lookup fails', async () => {
  const f = fixture('absent');
  f.request.mockRejectedValue(new Error('disconnected'));
  f.receive({});
  await f.settle();
  expect(f.activityEvents()).toEqual([]);
});

test.each(['reset', 'operation-reset', 'deleted', 'reconnected', 'replaced-turn'] as const)(
  'rejects an in-flight activity lookup after the session is %s',
  async change => {
    const f = fixture();
    let resolve!: (result: { session: typeof nativeRow }) => void;
    f.request.mockReturnValue(
      new Promise(result => {
        resolve = result;
      }),
    );
    f.receive({});
    expect(f.internals.sessionActivityChecks.size).toBe(1);
    if (change === 'reset') f.receive({ reason: 'reset' });
    if (change === 'operation-reset')
      f.internals.handleGatewayEvent({
        event: 'session.operation',
        payload: { sessionKey, operation: 'reset' },
      });
    if (change === 'deleted') f.getSession.mockReturnValue(null);
    if (change === 'reconnected') f.internals.gatewayClientGeneration += 1;
    if (change === 'replaced-turn') {
      f.internals.activeTurns.get(f.session.id)!.gatewaySessionId = 'new-incarnation';
    }

    resolve({ session: nativeRow });
    await f.settle();

    expect(f.activityEvents()).toEqual([]);
    expect(f.session.updatedAt).toBe(yesterday);
  },
);
