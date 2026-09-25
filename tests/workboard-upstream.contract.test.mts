import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { registerWorkboardGatewayMethods } from 'upstream-workboard/gateway.ts';
import { WorkboardStore } from 'upstream-workboard/store.ts';
import { createKernelStores } from 'upstream-workboard/test/sqlite-kernel.ts';
import {
  WorkboardIpc,
  WorkboardErrorCode,
  canStartWorkboardCard,
  type WorkboardCard,
  type WorkboardSnapshot,
  type WorkboardStartResult,
  type WorkboardDispatchSummary,
  type WorkboardResult,
} from '../src/shared/openclaw/workboard';

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<WorkboardResult<unknown>>;
type Registration = Parameters<typeof registerWorkboardGatewayMethods>[0];
type GatewayHandler = Parameters<Registration['api']['registerGatewayMethod']>[1];
type Results = {
  [WorkboardIpc.CreateCard]: WorkboardCard;
  [WorkboardIpc.GetSnapshot]: WorkboardSnapshot;
  [WorkboardIpc.UpdateCard]: WorkboardCard;
  [WorkboardIpc.CommentCard]: WorkboardCard;
  [WorkboardIpc.StartCard]: WorkboardStartResult;
  [WorkboardIpc.StopCard]: WorkboardCard;
  [WorkboardIpc.MoveCard]: WorkboardCard;
  [WorkboardIpc.Dispatch]: WorkboardDispatchSummary;
  [WorkboardIpc.ArchiveCard]: WorkboardCard;
  [WorkboardIpc.DeleteCard]: void;
};
const handlers = new Map<string, IpcHandler>();
vi.mock('electron', () => ({
  ipcMain: { handle: (key: string, handler: IpcHandler) => handlers.set(key, handler) },
}));
const { registerOpenClawWorkboardHandlers } = await import('../src/main/ipc/openclaw/workboard');

let store: WorkboardStore;
let directory: string;
afterEach(async () => {
  await store?.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('desktop IPC works with current upstream handlers, SQLite and dispatcher', async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-workboard-contract-'));
  const stores = createKernelStores(path.join(directory, 'workboard.sqlite'));
  store = new WorkboardStore(stores.cards, stores);
  const methods = new Map<string, GatewayHandler>();
  const active = new Set<string>();
  let afterAbort: (() => Promise<void>) | undefined;
  let runNumber = 0;
  const api = {
    registerGatewayMethod: (name: string, handler: GatewayHandler) => methods.set(name, handler),
    runtime: {
      sandbox: {},
      subagent: {
        run: vi.fn(async ({ sessionKey }: { sessionKey: string }) => {
          active.add(sessionKey);
          return { sessionKey, runId: `contract-run-${++runNumber}` };
        }),
      },
    },
  };
  registerWorkboardGatewayMethods({ api: api as unknown as Registration['api'], store });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'agents.list') return { defaultId: 'main', agents: [{ id: 'main' }] };
    if (method === 'sessions.list')
      return {
        sessions: [{ key: params.search, hasActiveRun: active.has(String(params.search)) }],
      };
    if (method === 'chat.abort') {
      const aborted = active.delete(String(params.sessionKey));
      await afterAbort?.();
      return { aborted };
    }
    const handler = methods.get(method);
    if (!handler) throw new Error(`Unregistered upstream method: ${method}`);
    let result: unknown;
    let failure: { message: string } | undefined;
    await handler({
      params,
      context: { getRuntimeConfig: () => ({}) },
      respond: (ok: boolean, data: unknown, error?: { message: string }) => {
        result = data;
        if (!ok) failure = error;
      },
    } as Parameters<GatewayHandler>[0]);
    if (failure) throw new Error(failure.message);
    return result;
  };
  registerOpenClawWorkboardHandlers({
    getRuntime: () => ({ getGatewayClient: () => ({ request }) }) as never,
  });
  const call = async <K extends keyof Results>(key: K, ...args: unknown[]): Promise<Results[K]> => {
    const result = await handlers.get(key)!({}, ...args);
    expect(result, result.error).toMatchObject({ success: true });
    return result.data as Results[K];
  };
  const input = { title: 'Contract task', status: 'todo', priority: 'normal', labels: [] };
  const created = await call(WorkboardIpc.CreateCard, input);
  expect((await call(WorkboardIpc.GetSnapshot)).cards).toHaveLength(1);
  const edited = await call(
    WorkboardIpc.UpdateCard,
    created.id,
    { notes: 'Expected result' },
    created.updatedAt,
  );
  expect(edited.notes).toBe('Expected result');
  await call(WorkboardIpc.CommentCard, created.id, 'Review this result');
  const started = await call(WorkboardIpc.StartCard, created.id);
  expect(started.card.status).toBe('running');
  const stopped = await call(WorkboardIpc.StopCard, created.id, {
    sessionKey: started.sessionKey,
    runId: started.runId,
  });
  expect(stopped.status).toBe('blocked');
  expect(stopped.metadata?.claim).toBeUndefined();
  const queued = await call(WorkboardIpc.MoveCard, created.id, 'todo', 1024, stopped.updatedAt);
  expect(canStartWorkboardCard(queued)).toBe(true);
  const scheduled = await store.create({
    ...input,
    title: 'Later',
    agentId: 'scheduled-agent',
    scheduledAt: Date.now() + 3600000,
  });
  const triage = await store.create({ ...input, title: 'Needs specification', status: 'triage' });
  const other = await store.create({ ...input, title: 'Other board', boardId: 'other' });
  const assigned = await store.create({ ...input, title: 'Assigned task', agentId: 'writer' });
  const previouslyScheduled = await store.create({
    ...input,
    title: 'Requeued task with an elapsed schedule',
    agentId: 'elapsed-schedule-agent',
    scheduledAt: Date.now() - 3600000,
  });
  const parent = await store.create({ ...input, title: 'Unfinished dependency', status: 'triage' });
  const child = await store.create({
    ...input,
    title: 'Dependent task',
    agentId: 'dependent-agent',
  });
  await store.linkCards(parent.id, child.id);
  const dispatched = await call(WorkboardIpc.Dispatch, 'default');
  expect(dispatched.started).toBe(3);
  expect((await store.get(scheduled.id)).status).toBe('scheduled');
  expect((await store.get(triage.id)).status).toBe('triage');
  expect((await store.get(other.id)).status).toBe('todo');
  expect((await store.get(child.id)).status).toBe('todo');
  expect((await store.get(assigned.id)).status).toBe('running');
  expect((await store.get(previouslyScheduled.id)).status).toBe('running');
  expect(api.runtime.subagent.run).toHaveBeenCalledTimes(4);
  const current = (await call(WorkboardIpc.GetSnapshot)).cards.find(
    (card: { id: string }) => card.id === created.id,
  );
  const stoppedAgain = await call(WorkboardIpc.StopCard, current.id, {
    sessionKey: current.sessionKey,
    runId: current.runId,
  });
  const reviewed = await call(
    WorkboardIpc.MoveCard,
    current.id,
    'review',
    1024,
    stoppedAgain.updatedAt,
  );
  const completed = await call(WorkboardIpc.MoveCard, current.id, 'done', 1024, reviewed.updatedAt);
  const staleMove = await handlers.get(WorkboardIpc.MoveCard)!(
    {},
    current.id,
    'todo',
    1024,
    reviewed.updatedAt,
  );
  expect(staleMove).toMatchObject({ success: false, error: WorkboardErrorCode.STALE_CARD });
  expect((await store.get(current.id)).updatedAt).toBe(completed.updatedAt);
  expect((await store.get(current.id)).status).toBe('done');
  expect((await call(WorkboardIpc.ArchiveCard, current.id, true)).metadata.archivedAt).toBeTruthy();
  await call(WorkboardIpc.ArchiveCard, current.id, false);
  await call(WorkboardIpc.DeleteCard, current.id);
  expect(
    (await call(WorkboardIpc.GetSnapshot)).cards.some(
      (card: { id: string }) => card.id === created.id,
    ),
  ).toBe(false);

  const replacementTask = await store.create({ ...input, agentId: 'replacement-agent' });
  const originalRun = await call(WorkboardIpc.StartCard, replacementTask.id);
  let replacementToken: string | undefined;
  afterAbort = async () => {
    const originalClaim = (await store.get(replacementTask.id)).metadata!.claim!;
    await store.releaseClaim(replacementTask.id, { ...originalClaim, status: 'todo' });
    await store.update(replacementTask.id, {
      execution: { ...originalRun.card.execution!, status: 'blocked' },
    });
    // Native dispatch persists this new claim before materializing its workspace and
    // preparing a new run ID. The historical session/run identity is still unchanged.
    const claimClock = vi.spyOn(Date, 'now').mockReturnValue(originalClaim.claimedAt + 1000);
    let replacement: Awaited<ReturnType<WorkboardStore['claim']>>;
    try {
      replacement = await store.claim(replacementTask.id, { ownerId: originalClaim.ownerId });
    } finally {
      claimClock.mockRestore();
    }
    replacementToken = replacement.token;
    expect(replacement.card.runId).toBe(originalRun.runId);
  };
  const stopReplacedClaim = await handlers.get(WorkboardIpc.StopCard)!({}, replacementTask.id, {
    sessionKey: originalRun.sessionKey,
    runId: originalRun.runId,
  });
  expect(stopReplacedClaim).toMatchObject({ success: false });
  expect((await store.get(replacementTask.id)).metadata?.claim?.token).toBe(replacementToken);
  expect((await store.get(replacementTask.id)).status).toBe('running');
});
