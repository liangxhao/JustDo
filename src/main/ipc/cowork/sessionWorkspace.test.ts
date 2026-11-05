import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { CoworkPlanHandoffState } from '../../../shared/cowork/interactions/planHandoff';
import { SessionWorkspaceIpc } from '../../../shared/cowork/sessionWorkspace';
import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(name, handler),
  },
}));

import { registerSessionWorkspaceHandler } from './sessionWorkspace';

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
  handlers.clear();
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-workspace-'));
  roots.push(root);
  const cwd = path.join(root, '项目 空格');
  fs.mkdirSync(cwd);
  const session = {
    id: 'session',
    cwd: path.join(root, 'old'),
    agentId: 'main',
    permissionMode: 'ask',
  } as CoworkSession;
  const original = { ...session };
  const updateSession = vi.fn((_id: string, changes: Partial<CoworkSession>) =>
    Object.assign(session, changes),
  );
  const getLatestSessionRun = vi.fn<() => unknown>(() => undefined);
  const getActiveSessionRun = vi.fn<() => unknown>(() => undefined);
  const listPlanHandoffs = vi.fn<() => unknown[]>(() => []);
  const store = {
    getSession: () => session,
    updateSession,
    getLatestSessionRun,
    getActiveSessionRun,
    listPlanHandoffs,
  } as unknown as CoworkStore;
  const status = { known: true, running: false, mainRunning: false, subagentRunning: false };
  const getSessionRuntimeStatus = vi.fn(async () => status);
  const isSessionPreparing = vi.fn(() => false);
  const hasUnconfirmedSessionPreparation = vi.fn(() => false);
  const router = {
    getSessionRuntimeStatus,
    isSessionActive: () => false,
    isSessionPreparing,
    hasUnconfirmedSessionPreparation,
  } as unknown as CoworkEngineRouter;
  const isBlocked = vi.fn(() => false);
  const isAllowedSender = vi.fn(() => true);
  const isManaged = vi.fn(() => false);
  const onSessionsChanged = vi.fn();
  registerSessionWorkspaceHandler({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    isBlocked,
    isManaged,
    isAllowedSender,
    onSessionsChanged,
  });
  const input = { sessionId: session.id, expectedCwd: session.cwd, cwd };
  const set = (value: unknown = input) => handlers.get(SessionWorkspaceIpc.Set)!({}, value);
  return {
    root,
    session,
    original,
    input,
    set,
    updateSession,
    status,
    getSessionRuntimeStatus,
    getLatestSessionRun,
    getActiveSessionRun,
    listPlanHandoffs,
    isBlocked,
    isAllowedSender,
    isManaged,
    isSessionPreparing,
    hasUnconfirmedSessionPreparation,
    onSessionsChanged,
  };
}

test('saves an existing Unicode folder without replacing native identity or moving files', async () => {
  const f = setup();
  f.session.historyBinding = { sessionKey: 'native-key', nativeSessionId: 'native-id' } as never;
  const historyBinding = f.session.historyBinding;
  await expect(f.set()).resolves.toEqual({
    success: true,
    cwd: fs.realpathSync.native(f.input.cwd),
  });
  expect(f.updateSession).toHaveBeenCalledExactlyOnceWith('session', {
    cwd: fs.realpathSync.native(f.input.cwd),
  });
  expect(f.session.historyBinding).toEqual(historyBinding);
  expect(f.getSessionRuntimeStatus).toHaveBeenCalledWith('session', {
    targeted: true,
    includeSubagents: true,
    forceRefresh: true,
  });
  expect(f.onSessionsChanged).toHaveBeenCalledOnce();
});

test('rejects invalid payloads, nonexistent paths and files without creating folders', async () => {
  const f = setup();
  const missing = path.join(f.root, 'missing');
  const file = path.join(f.root, 'file');
  fs.writeFileSync(file, 'data');
  for (const input of [
    null,
    { ...f.input, cwd: '' },
    { ...f.input, cwd: 'relative' },
    { ...f.input, cwd: missing },
    { ...f.input, cwd: file },
  ]) {
    await expect(f.set(input)).resolves.toEqual({ success: false, reason: 'invalid' });
  }
  expect(fs.existsSync(missing)).toBe(false);
  expect(f.updateSession).not.toHaveBeenCalled();
});

test('rejects unauthorized frames and owned worktree/external sessions before querying Gateway', async () => {
  const f = setup();
  f.isAllowedSender.mockReturnValue(false);
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'unsupported' });
  f.isAllowedSender.mockReturnValue(true);
  f.session.nativeSessionKey = 'worktree-key';
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'unsupported' });
  delete f.session.nativeSessionKey;
  f.session.external = { readOnly: false } as never;
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'unsupported' });
  expect(f.getSessionRuntimeStatus).not.toHaveBeenCalled();
  expect(f.updateSession).not.toHaveBeenCalled();
});

test('refuses unknown and active native executions without settling their outcomes', async () => {
  const f = setup();
  f.status.known = false;
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'unknown' });
  f.status.known = true;
  f.status.subagentRunning = true;
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'busy' });
  expect(f.updateSession).not.toHaveBeenCalled();
});

test('blocks pending receipts, plans and plugin/Stop fences even if native status appears idle', async () => {
  const f = setup();
  // startedAt can go backwards; the latest ordered row is not the open receipt.
  f.getLatestSessionRun.mockReturnValue({ state: 'completed', startedAt: 200 });
  f.getActiveSessionRun.mockReturnValue({ state: 'running', startedAt: 100 });
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'busy' });
  f.getActiveSessionRun.mockReturnValue(undefined);
  f.listPlanHandoffs.mockReturnValue([{ state: CoworkPlanHandoffState.Presented }]);
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'busy' });
  f.listPlanHandoffs.mockReturnValue([]);
  f.isBlocked.mockReturnValue(true);
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'busy' });
  expect(f.getSessionRuntimeStatus).not.toHaveBeenCalled();
  expect(f.updateSession).not.toHaveBeenCalled();
});

test('rejects stale picker values and product identity changes while status is in flight', async () => {
  const f = setup();
  await expect(f.set({ ...f.input, expectedCwd: 'stale' })).resolves.toEqual({
    success: false,
    reason: 'changed',
  });
  f.getSessionRuntimeStatus.mockImplementation(async () => {
    f.session.permissionMode = 'full';
    return f.status;
  });
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'changed' });
  expect(f.updateSession).not.toHaveBeenCalled();
});

test('rejects a newly reserved run or plan while the native idle read is in flight', async () => {
  const f = setup();
  f.getSessionRuntimeStatus.mockImplementation(async () => {
    f.getLatestSessionRun.mockReturnValue({ id: 'new', state: 'running' });
    return f.status;
  });
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'changed' });
  f.getLatestSessionRun.mockReturnValue(undefined);
  f.getSessionRuntimeStatus.mockImplementation(async () => {
    f.listPlanHandoffs.mockReturnValue([{ state: CoworkPlanHandoffState.Dispatching }]);
    return f.status;
  });
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'busy' });
  expect(f.updateSession).not.toHaveBeenCalled();
});

test('waits for existing terminal/permission preparation and rechecks new preparation after the idle read', async () => {
  const f = setup();
  f.isSessionPreparing.mockReturnValue(true);
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'busy' });
  expect(f.getSessionRuntimeStatus).not.toHaveBeenCalled();
  f.isSessionPreparing.mockReturnValue(false);
  f.getSessionRuntimeStatus.mockImplementation(async () => {
    f.isSessionPreparing.mockReturnValue(true);
    return f.status;
  });
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'busy' });
  expect(f.updateSession).not.toHaveBeenCalled();
});

test('preserves the latest failed plan that can still be restored and approved', async () => {
  const f = setup();
  f.listPlanHandoffs.mockReturnValue([{ state: CoworkPlanHandoffState.Failed }]);
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'busy' });
  f.listPlanHandoffs.mockReturnValue([
    { state: CoworkPlanHandoffState.Failed },
    { state: CoworkPlanHandoffState.Resolved },
  ]);
  await expect(f.set()).resolves.toMatchObject({ success: true });
});

test('reports plugin ownership as unsupported instead of inviting an idle-session retry', async () => {
  const f = setup();
  f.isManaged.mockReturnValue(true);
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'unsupported' });
  expect(f.getSessionRuntimeStatus).not.toHaveBeenCalled();
});

test('refuses an unknown native directory preparation outcome after the client wait has ended', async () => {
  const f = setup();
  f.hasUnconfirmedSessionPreparation.mockReturnValue(true);
  await expect(f.set()).resolves.toEqual({ success: false, reason: 'preparation-unknown' });
  expect(f.getSessionRuntimeStatus).not.toHaveBeenCalled();
  expect(f.updateSession).not.toHaveBeenCalled();
});
