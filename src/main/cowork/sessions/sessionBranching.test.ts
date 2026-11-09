import { expect, test, vi } from 'vitest';

import type { CoworkSession } from '../../data/coworkStore';
import { recoverFailedSessionBranch } from './sessionBranching';

const session: CoworkSession = {
  id: 'branch',
  title: 'Branch',
  status: 'idle',
  pinned: false,
  cwd: 'E:\\workspace\\project',
  executionMode: 'local',
  permissionMode: 'ask',
  activeSkillIds: [],
  agentId: 'main',
  createdAt: 1,
  updatedAt: 1,
};
const sessionKey = 'agent:main:justdo:branch';

test('does not erase an unconfirmed creation even when a read could report absence', async () => {
  const requestGateway = vi.fn().mockResolvedValue({ session: null });
  const store = { deleteSession: vi.fn(), updateSession: vi.fn() };
  const router = { onSessionDeleted: vi.fn() };
  expect(
    await recoverFailedSessionBranch({
      requestGateway,
      store,
      router,
      session,
      sessionKey,
      creationResponseReceived: false,
    }),
  ).toEqual({ ...session, status: 'error', branchCreationPending: true });
  expect(requestGateway).not.toHaveBeenCalled();
  expect(store.deleteSession).not.toHaveBeenCalled();
  expect(store.updateSession).toHaveBeenCalledWith(session.id, { status: 'error' });
  expect(router.onSessionDeleted).not.toHaveBeenCalled();
});

test.each([{ session: { sessionId: 'physical' } }, {}, null])(
  'retains a recovery row unless absence is explicitly confirmed: %j',
  async response => {
    const store = { deleteSession: vi.fn(), updateSession: vi.fn() };
    const router = { onSessionDeleted: vi.fn() };
    expect(
      await recoverFailedSessionBranch({
        requestGateway: vi.fn().mockResolvedValue(response),
        store,
        router,
        session,
        sessionKey,
        creationResponseReceived: true,
      }),
    ).toEqual({ ...session, status: 'error', branchCreationPending: true });
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(router.onSessionDeleted).not.toHaveBeenCalled();
  },
);

test('removes a local target only after a creation response and confirmed native absence', async () => {
  const store = { deleteSession: vi.fn(), updateSession: vi.fn() };
  const router = { onSessionDeleted: vi.fn() };
  expect(
    await recoverFailedSessionBranch({
      requestGateway: vi.fn().mockResolvedValue({ session: null }),
      store,
      router,
      session,
      sessionKey,
      creationResponseReceived: true,
    }),
  ).toBeUndefined();
  expect(store.deleteSession).toHaveBeenCalledWith(session.id);
  expect(router.onSessionDeleted).toHaveBeenCalledWith(
    session.id,
    session.agentId,
    [sessionKey],
    [session.cwd],
  );
});

test('keeps the recovery entry when native lookup or local rollback fails', async () => {
  for (const failRead of [true, false]) {
    const store = {
      deleteSession: vi.fn().mockImplementation(() => {
        throw new Error('database busy');
      }),
      updateSession: vi.fn(),
    };
    const router = { onSessionDeleted: vi.fn() };
    const requestGateway = failRead
      ? vi.fn().mockRejectedValue(new Error('disconnected'))
      : vi.fn().mockResolvedValue({ session: null });
    expect(
      await recoverFailedSessionBranch({
        requestGateway,
        store,
        router,
        session,
        sessionKey,
        creationResponseReceived: true,
      }),
    ).toEqual({ ...session, status: 'error', branchCreationPending: true });
    expect(router.onSessionDeleted).not.toHaveBeenCalled();
  }
});

test('a local persistence failure before creation dispatch does not leave an unknown native operation', async () => {
  const requestGateway = vi.fn();
  const store = { deleteSession: vi.fn(), updateSession: vi.fn() };
  const router = { onSessionDeleted: vi.fn() };
  expect(
    await recoverFailedSessionBranch({
      requestGateway,
      store,
      router,
      session,
      sessionKey,
      creationResponseReceived: false,
      creationRequestIssued: false,
    }),
  ).toBeUndefined();
  expect(store.deleteSession).toHaveBeenCalledWith(session.id);
  expect(requestGateway).not.toHaveBeenCalled();
});
