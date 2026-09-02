import { describe, expect, test, vi } from 'vitest';

import {
  DeliveryMode,
  GatewayStatus,
  IpcChannel,
  ScheduledTaskAgentId,
  TaskStatus,
} from '../../shared/scheduledTask/constants';
import {
  CronJobService,
  mapGatewayJob,
  mapGatewayRun,
  mapGatewayTaskState,
  shouldRepairInAppOnlyDeliveryBackoff,
} from './cronJobService';

const getAllWindowsMock = vi.hoisted(() => vi.fn(() => []));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: getAllWindowsMock },
}));

const missingChannelError =
  'Channel is required (no configured channels detected). Set delivery.channel explicitly.';

function createMissingChannelJob(delivery?: {
  mode: 'none' | 'announce' | 'webhook';
  channel?: string;
  to?: string;
}) {
  return {
    id: 'job-1',
    name: 'Reminder',
    enabled: true,
    schedule: { kind: 'cron' as const, expr: '* * * * *' },
    sessionTarget: 'isolated' as const,
    wakeMode: 'now' as const,
    payload: { kind: 'agentTurn' as const, message: 'Remember this' },
    agentId: ScheduledTaskAgentId,
    delivery,
    state: {
      nextRunAtMs: 1_700_003_600_000,
      lastRunAtMs: 1_700_000_000_000,
      lastRunStatus: GatewayStatus.Error,
      lastError: missingChannelError,
      lastDeliveryStatus: 'unknown',
      consecutiveErrors: 5,
    },
    createdAtMs: 1_699_000_000_000,
    updatedAtMs: 1_700_000_000_000,
  };
}

describe('shouldRepairInAppOnlyDeliveryBackoff', () => {
  test('repairs a missing-channel backoff for an in-app-only job', () => {
    expect(
      shouldRepairInAppOnlyDeliveryBackoff(createMissingChannelJob({ mode: DeliveryMode.None })),
    ).toBe(true);
    expect(shouldRepairInAppOnlyDeliveryBackoff(createMissingChannelJob())).toBe(true);
  });

  test('preserves announce intent even when the external target is incomplete', () => {
    expect(
      shouldRepairInAppOnlyDeliveryBackoff(
        createMissingChannelJob({ mode: DeliveryMode.Announce }),
      ),
    ).toBe(false);
    expect(
      shouldRepairInAppOnlyDeliveryBackoff(
        createMissingChannelJob({ mode: DeliveryMode.Announce, channel: 'slack' }),
      ),
    ).toBe(false);
  });

  test('does not alter webhook delivery or genuine execution failures', () => {
    expect(
      shouldRepairInAppOnlyDeliveryBackoff(
        createMissingChannelJob({ mode: DeliveryMode.Webhook, to: 'https://example.com/hook' }),
      ),
    ).toBe(false);

    const job = createMissingChannelJob({ mode: DeliveryMode.None });
    job.state.lastError = 'agent timeout';
    expect(shouldRepairInAppOnlyDeliveryBackoff(job)).toBe(false);
  });
});

describe('in-app delivery backoff repair', () => {
  test('deduplicates a repaired error without replacing later list state with a stale update', async () => {
    const initial = createMissingChannelJob({ mode: DeliveryMode.None });
    const repaired = {
      ...initial,
      state: { ...initial.state, nextRunAtMs: 1_700_000_060_000 },
    };
    const edited = {
      ...initial,
      name: 'Edited reminder',
      enabled: false,
      updatedAtMs: initial.updatedAtMs + 1,
    };
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.list') {
        listCount += 1;
        return { jobs: [listCount === 1 ? initial : edited] };
      }
      if (method === 'cron.update') return repaired;
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    const first = await service.listJobs();
    const second = await service.listJobs();

    expect(first[0].state.nextRunAtMs).toBe(repaired.state.nextRunAtMs);
    expect(second[0]).toMatchObject({ name: edited.name, enabled: false });
    expect(request.mock.calls.filter(([method]) => method === 'cron.update')).toHaveLength(1);
  });

  test('skips repair when the task disappears after the initial list', async () => {
    const initial = createMissingChannelJob({ mode: DeliveryMode.None });
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.list') {
        listCount += 1;
        return { jobs: listCount === 1 ? [initial] : [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    const tasks = await service.listJobs();

    expect(tasks).toEqual([]);
    expect(request).not.toHaveBeenCalledWith('cron.update', expect.anything());
  });

  test('suppresses an update failure when the task was removed concurrently', async () => {
    const initial = createMissingChannelJob({ mode: DeliveryMode.None });
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.list') {
        listCount += 1;
        return { jobs: listCount < 3 ? [initial] : [] };
      }
      if (method === 'cron.update') {
        throw new Error('invalid cron.update params: id not found');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    const tasks = await service.listJobs();

    expect(tasks).toEqual([]);
    expect(request.mock.calls.filter(([method]) => method === 'cron.update')).toHaveLength(1);
  });
});

describe('mapGatewayRun', () => {
  const baseEntry = {
    ts: 1700000000000,
    jobId: 'job-1',
    status: GatewayStatus.Ok,
    sessionId: 'sess-1',
    runAtMs: 1699999990000,
    durationMs: 10000,
    summary: 'All good',
  };

  test('maps ok status to success', () => {
    const run = mapGatewayRun(baseEntry);
    expect(run.status).toBe(TaskStatus.Success);
    expect(run.error).toBeNull();
    expect(run).toMatchObject({
      id: 'job-1:1699999990000',
      summary: 'All good',
      deliveryStatus: null,
      deliveryError: null,
    });
  });

  test('maps error status to error', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: 'something broke',
    });
    expect(run.status).toBe(TaskStatus.Error);
    expect(run.error).toBe('something broke');
  });

  test('maps running action to running', () => {
    const run = mapGatewayRun({ ...baseEntry, action: 'started' });
    expect(run.status).toBe(TaskStatus.Running);
  });

  test('suppresses delivery-only error to success', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: '⚠️ ✉️ Message failed',
      deliveryStatus: 'not-delivered',
      deliveryError: '⚠️ ✉️ Message failed',
      summary: 'Agent produced a valid summary',
    });
    expect(run.status).toBe(TaskStatus.Success);
    expect(run.error).toBeNull();
    expect(run.deliveryStatus).toBe('not-delivered');
    expect(run.deliveryError).toBe('⚠️ ✉️ Message failed');
  });

  test('does not suppress error when error differs from deliveryError', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: 'agent crashed',
      deliveryStatus: 'not-delivered',
      deliveryError: '⚠️ ✉️ Message failed',
    });
    expect(run.status).toBe(TaskStatus.Error);
    expect(run.error).toBe('agent crashed');
  });

  test('does not suppress error when no deliveryError is present', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: 'timeout',
    });
    expect(run.status).toBe(TaskStatus.Error);
    expect(run.error).toBe('timeout');
  });

  test('separates the OpenClaw missing-channel routing error from execution', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: missingChannelError,
      deliveryStatus: 'unknown',
      deliveryError: undefined,
    });

    expect(run.status).toBe(TaskStatus.Success);
    expect(run.error).toBeNull();
    expect(run.deliveryStatus).toBe('unknown');
    expect(run.deliveryError).toBe(missingChannelError);
  });

  test('prefers a native run ID and falls back to a stable start timestamp', () => {
    expect(mapGatewayRun({ ...baseEntry, runId: 'native-run' }).id).toBe('native-run');
    expect(mapGatewayRun({ ...baseEntry, runAtMs: undefined }).id).toBe('job-1:1700000000000');
  });

  test('uses the completion timestamp when a start timestamp is malformed', () => {
    const mapped = mapGatewayRun({
      ...baseEntry,
      runAtMs: Number.NaN,
      durationMs: Number.POSITIVE_INFINITY,
    });
    expect(mapped.startedAt).toBe(new Date(baseEntry.ts).toISOString());
    expect(mapped.durationMs).toBeNull();
  });
});

describe('mapGatewayJob', () => {
  test('keeps native cron fields without legacy wrappers', () => {
    const job = mapGatewayJob({
      id: 'job-1',
      name: 'Morning brief',
      description: 'Send a summary',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: 'Summarize updates', timeoutSeconds: 45 },
      delivery: { mode: 'announce', channel: 'last', to: 'chat-1' },
      agentId: 'agent-42',
      sessionKey: 'session-1',
      state: {
        nextRunAtMs: 100,
        lastRunAtMs: 90,
        lastRunStatus: 'skipped',
      },
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_100_000,
    });

    expect(job.schedule.kind).toBe('cron');
    expect((job.schedule as { expr: string }).expr).toBe('0 9 * * *');
    expect((job.schedule as { tz: string }).tz).toBe('Asia/Shanghai');
    expect(job.payload.kind).toBe('agentTurn');
    expect((job.payload as { timeoutSeconds: number }).timeoutSeconds).toBe(45);
    expect(job.delivery).toEqual({
      mode: 'announce',
      channel: 'last',
      to: 'chat-1',
    });
    expect(job.agentId).toBe('agent-42');
    expect(job.sessionKey).toBe('session-1');
    expect(job.state.lastStatus).toBe('skipped');
  });
});

describe('mapGatewayTaskState', () => {
  test('maps ok status to success', () => {
    const state = mapGatewayTaskState({
      lastRunStatus: GatewayStatus.Ok,
      lastRunAtMs: 1700000000000,
    });
    expect(state.lastStatus).toBe(TaskStatus.Success);
    expect(state.lastError).toBeNull();
  });

  test('maps error status to error', () => {
    const state = mapGatewayTaskState({ lastRunStatus: GatewayStatus.Error, lastError: 'fail' });
    expect(state.lastStatus).toBe(TaskStatus.Error);
    expect(state.lastError).toBe('fail');
  });

  test('maps running state', () => {
    const state = mapGatewayTaskState({ runningAtMs: Date.now(), lastRunStatus: GatewayStatus.Ok });
    expect(state.lastStatus).toBe(TaskStatus.Running);
  });

  test('suppresses delivery-only error when delivery mode is none', () => {
    const state = mapGatewayTaskState(
      {
        lastRunStatus: GatewayStatus.Error,
        lastError: '⚠️ ✉️ Message failed',
        lastDeliveryStatus: 'not-delivered',
        lastDeliveryError: '⚠️ ✉️ Message failed',
      },
      DeliveryMode.None,
    );
    expect(state.lastStatus).toBe(TaskStatus.Success);
    expect(state.lastError).toBeNull();
  });

  test('separates delivery error from execution when delivery mode is announce', () => {
    const state = mapGatewayTaskState(
      {
        lastRunStatus: GatewayStatus.Error,
        lastError: '⚠️ ✉️ Message failed',
        lastDeliveryStatus: 'not-delivered',
        lastDeliveryError: '⚠️ ✉️ Message failed',
      },
      DeliveryMode.Announce,
    );
    expect(state.lastStatus).toBe(TaskStatus.Success);
    expect(state.lastError).toBeNull();
  });

  test('does not suppress non-delivery errors even for mode none', () => {
    const state = mapGatewayTaskState(
      {
        lastRunStatus: GatewayStatus.Error,
        lastError: 'agent timeout',
      },
      DeliveryMode.None,
    );
    expect(state.lastStatus).toBe(TaskStatus.Error);
    expect(state.lastError).toBe('agent timeout');
  });
});

describe('isolated scheduler agent assignment', () => {
  const input = {
    name: 'Morning brief',
    description: '',
    enabled: true,
    schedule: { kind: 'cron' as const, expr: '0 9 * * *' },
    sessionTarget: 'isolated' as const,
    wakeMode: 'now' as const,
    payload: { kind: 'agentTurn' as const, message: 'Summarize updates' },
    agentId: 'main',
  };
  const gatewayJob = {
    id: 'job-1',
    ...input,
    state: {},
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
  };

  test('creates agent-turn tasks on the scheduler agent without changing global permissions', async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== 'cron.add') throw new Error(`Unexpected method: ${method}`);
      return {
        ...gatewayJob,
        agentId: (params as { agentId: string }).agentId,
      };
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    const task = await service.addJob(input);

    expect(request).toHaveBeenCalledWith(
      'cron.add',
      expect.objectContaining({
        agentId: ScheduledTaskAgentId,
        delivery: { mode: DeliveryMode.None },
      }),
    );
    expect(task.agentId).toBe(ScheduledTaskAgentId);
  });

  test('keeps externally owned agent-turn tasks unchanged while listing', async () => {
    const systemJob = {
      ...gatewayJob,
      id: 'system-job',
      agentId: 'main',
      payload: { kind: 'systemEvent' as const, text: 'Wake up' },
    };
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.list') return { jobs: [gatewayJob, systemJob] };
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    const tasks = await service.listJobs();

    expect(tasks.map(task => [task.id, task.agentId])).toEqual([
      [gatewayJob.id, 'main'],
      [systemJob.id, 'main'],
    ]);
    expect(request.mock.calls.filter(([method]) => method === 'cron.update')).toHaveLength(0);
  });

  test('keeps the original agent when enabling an externally owned task', async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'cron.list') return { jobs: [{ ...gatewayJob, enabled: false }] };
      if (method === 'cron.update') {
        const patch = (params as { patch: Record<string, unknown> }).patch;
        return { ...gatewayJob, enabled: false, ...patch };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    const task = await service.toggleJob(gatewayJob.id, true);

    expect(task).toMatchObject({ enabled: true, agentId: 'main' });
    expect(request).toHaveBeenCalledWith('cron.update', {
      id: gatewayJob.id,
      patch: { enabled: true },
    });
  });

  test('runs an externally owned task without changing its agent', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.list') return { jobs: [gatewayJob] };
      if (method === 'cron.run') return undefined;
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await service.runJob(gatewayJob.id);

    expect(request.mock.calls.map(([method]) => method)).toEqual(['cron.list', 'cron.run']);
  });

  test('keeps the original agent during an ordinary update', async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'cron.list') return { jobs: [gatewayJob] };
      if (method === 'cron.update') {
        const patch = (params as { patch: Record<string, unknown> }).patch;
        return { ...gatewayJob, ...patch };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    const task = await service.updateJob(gatewayJob.id, { name: 'Renamed' });

    expect(task).toMatchObject({ name: 'Renamed', agentId: 'main' });
    expect(request).toHaveBeenCalledWith('cron.update', {
      id: gatewayJob.id,
      patch: { name: 'Renamed' },
    });
  });

  test('does not mutate or publish polled tasks while cowork is busy', async () => {
    const onJobsPolled = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn(async () => ({ jobs: [gatewayJob] }));
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
      isCoworkBusy: () => true,
      onJobsPolled,
    });

    service.startPolling();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('cron.list', expect.any(Object)));
    service.stopPolling();

    expect(request.mock.calls.filter(([method]) => method === 'cron.update')).toHaveLength(0);
    expect(onJobsPolled).not.toHaveBeenCalled();
  });

  test('reads every cron.list page without mutating task ownership', async () => {
    const first = { ...gatewayJob, id: 'job-1', agentId: ScheduledTaskAgentId };
    const second = { ...gatewayJob, id: 'job-201', agentId: 'main' };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== 'cron.list') throw new Error(`Unexpected method: ${method}`);
      const offset = (params as { offset?: number }).offset ?? 0;
      return offset === 0
        ? { jobs: [first], hasMore: true, nextOffset: 200 }
        : { jobs: [second], hasMore: false };
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    const tasks = await service.listJobs();

    expect(tasks.map(task => [task.id, task.agentId])).toEqual([
      ['job-1', ScheduledTaskAgentId],
      ['job-201', 'main'],
    ]);
    expect(request).toHaveBeenNthCalledWith(1, 'cron.list', {
      includeDisabled: true,
      limit: 200,
      offset: 0,
    });
    expect(request).toHaveBeenNthCalledWith(2, 'cron.list', {
      includeDisabled: true,
      limit: 200,
      offset: 200,
    });
  });

  test('converts AgentTurn to SystemEvent in one update without scheduler residue', async () => {
    const current = {
      ...gatewayJob,
      agentId: ScheduledTaskAgentId,
      sessionKey: 'agent:justdo-scheduler:cron:job-1',
    };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'cron.list') return { jobs: [current] };
      if (method === 'cron.update') {
        const patch = (params as { patch: Record<string, unknown> }).patch;
        return { ...current, ...patch };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    const task = await service.updateJob(gatewayJob.id, {
      payload: { kind: 'systemEvent', text: 'Wake up' },
    });

    expect(task).toMatchObject({
      payload: { kind: 'systemEvent', text: 'Wake up' },
      sessionTarget: 'main',
      agentId: null,
      sessionKey: null,
    });
    expect(request.mock.calls.filter(([method]) => method === 'cron.update')).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('cron.update', {
      id: gatewayJob.id,
      patch: {
        payload: { kind: 'systemEvent', text: 'Wake up' },
        sessionTarget: 'main',
        agentId: null,
        sessionKey: null,
      },
    });
  });

  test('honors an explicit agent update for an existing SystemEvent', async () => {
    const current = {
      ...gatewayJob,
      payload: { kind: 'systemEvent' as const, text: 'Wake up' },
      sessionTarget: 'main' as const,
      agentId: null,
    };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'cron.list') return { jobs: [current] };
      if (method === 'cron.update') {
        const patch = (params as { patch: Record<string, unknown> }).patch;
        return { ...current, ...patch };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await service.updateJob(current.id, { agentId: 'main' });

    expect(request).toHaveBeenCalledWith('cron.update', {
      id: current.id,
      patch: { agentId: 'main' },
    });
  });

  test('normalizes an update race when the task disappears before cron.update completes', async () => {
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.list') {
        listCount += 1;
        return { jobs: listCount === 1 ? [gatewayJob] : [] };
      }
      if (method === 'cron.update') {
        throw new Error('invalid cron.update params: id not found');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await expect(service.updateJob(gatewayJob.id, { name: 'Updated' })).rejects.toThrow(
      `Scheduled task not found: ${gatewayJob.id}`,
    );
  });

  test('treats deleting an already removed task as success', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.list') return { jobs: [] };
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await expect(service.removeJob(gatewayJob.id)).resolves.toBeUndefined();
    expect(request.mock.calls.some(([method]) => method === 'cron.remove')).toBe(false);
  });

  test('treats a concurrent removal during cron.remove as success', async () => {
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.list') {
        listCount += 1;
        return { jobs: listCount === 1 ? [gatewayJob] : [] };
      }
      if (method === 'cron.remove') {
        throw new Error('invalid cron.remove params: id not found');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await expect(service.removeJob(gatewayJob.id)).resolves.toBeUndefined();
  });

  test('notifies the renderer when polling observes a removed task', async () => {
    const send = vi.fn();
    getAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } } as never,
    ]);
    let jobs = [{ ...gatewayJob, agentId: ScheduledTaskAgentId }];
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.list') return { jobs };
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    service.startPolling();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IpcChannel.Refresh));
    send.mockClear();
    jobs = [];

    await (service as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(send).toHaveBeenCalledWith(IpcChannel.Refresh);
    service.stopPolling();
    getAllWindowsMock.mockReturnValue([]);
  });

  test('notifies the renderer after reconciling a Gateway cron change', async () => {
    const send = vi.fn();
    getAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } } as never,
    ]);
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.list') return { jobs: [] };
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await service.reconcileGatewayChange();

    expect(send).toHaveBeenCalledWith(IpcChannel.Refresh);
    getAllWindowsMock.mockReturnValue([]);
  });
});
