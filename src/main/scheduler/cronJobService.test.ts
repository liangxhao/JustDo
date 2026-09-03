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
} from './cronJobService';

const getAllWindowsMock = vi.hoisted(() => vi.fn(() => []));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: getAllWindowsMock },
}));

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

  test('preserves the native execution status separately from delivery status', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: '⚠️ ✉️ Message failed',
      deliveryStatus: 'not-delivered',
      deliveryError: '⚠️ ✉️ Message failed',
      summary: 'Agent produced a valid summary',
    });
    expect(run.status).toBe(TaskStatus.Error);
    expect(run.error).toBe('⚠️ ✉️ Message failed');
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

  test('does not synthesize a delivery error from the execution error', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: 'Channel is required',
      deliveryStatus: 'unknown',
      deliveryError: undefined,
    });

    expect(run.status).toBe(TaskStatus.Error);
    expect(run.error).toBe('Channel is required');
    expect(run.deliveryStatus).toBe('unknown');
    expect(run.deliveryError).toBeNull();
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
    expect(job.management).toBe('editable');
  });

  test('maps v2026.8.2 event schedules and command payloads as advanced read-only edits', () => {
    const job = mapGatewayJob({
      id: 'watch-build',
      name: 'Watch build',
      enabled: true,
      schedule: { kind: 'on-exit', command: './watch-build.ps1', cwd: 'C:\\work' },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: {
        kind: 'command',
        argv: ['npm', 'test'],
        cwd: 'C:\\work',
        toolsAllow: ['exec'],
      },
      state: {},
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_100_000,
    });

    expect(job).toMatchObject({
      management: 'advanced',
      schedule: { kind: 'on-exit', command: './watch-build.ps1', cwd: 'C:\\work' },
      payload: {
        kind: 'command',
        argv: ['npm', 'test'],
        cwd: 'C:\\work',
        toolsAllow: ['exec'],
      },
    });
  });

  test('uses displayName and marks declarative system jobs as managed', () => {
    const job = mapGatewayJob({
      id: 'heartbeat-main',
      declarationKey: 'system:heartbeat:main',
      displayName: 'Heartbeat (main)',
      name: 'internal-heartbeat-main',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'heartbeat' },
      state: {},
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_100_000,
    });

    expect(job).toMatchObject({
      name: 'Heartbeat (main)',
      management: 'managed',
      payload: { kind: 'heartbeat' },
    });
  });

  test('keeps account-scoped and hidden native capabilities out of the basic editor', () => {
    const job = mapGatewayJob({
      id: 'account-job',
      name: 'Account job',
      enabled: true,
      owner: { agentId: 'main', accountId: 'account-1' },
      scheduledToolPolicy: { version: 1, mode: 'account' },
      pacing: { min: '5m' },
      trigger: { script: 'return true' },
      failureAlert: { after: 2 },
      deleteAfterRun: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: 'Run safely' },
      state: {},
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_100_000,
    });

    expect(job.management).toBe('advanced');
    expect(job.advancedFeatures).toEqual([
      'owner',
      'account-tool-policy',
      'pacing',
      'trigger',
      'failure-alert',
      'delete-after-run',
    ]);
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

  test('uses the native v2026.8.2 execution status without delivery heuristics', () => {
    const state = mapGatewayTaskState({
      lastRunStatus: GatewayStatus.Error,
      lastError: 'agent failed',
      lastDeliveryStatus: 'not-delivered',
      lastDeliveryError: 'delivery failed',
    });
    expect(state.lastStatus).toBe(TaskStatus.Error);
    expect(state.lastError).toBe('agent failed');
  });

  test('does not suppress non-delivery errors even for mode none', () => {
    const state = mapGatewayTaskState({
      lastRunStatus: GatewayStatus.Error,
      lastError: 'agent timeout',
    });
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
      if (method === 'cron.get') return { ...gatewayJob, enabled: false };
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
      if (method === 'cron.get') return gatewayJob;
      if (method === 'cron.run') return { ok: true, enqueued: true, runId: 'manual-run-1' };
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await expect(service.runJob(gatewayJob.id)).resolves.toEqual({
      enqueued: true,
      runId: 'manual-run-1',
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(['cron.get', 'cron.run']);
    expect(request).toHaveBeenCalledWith('cron.run', { id: gatewayJob.id, mode: 'force' });
  });

  test('keeps the original agent during an ordinary update', async () => {
    const current = { ...gatewayJob, configRevision: 'sha256:current' };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'cron.get') return current;
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

    const task = await service.updateJob(gatewayJob.id, { name: 'Renamed' });

    expect(task).toMatchObject({ name: 'Renamed', agentId: 'main' });
    expect(request).toHaveBeenCalledWith('cron.update', {
      id: gatewayJob.id,
      patch: { name: 'Renamed' },
      expectedConfigRevision: 'sha256:current',
    });
  });

  test('renames the visible displayName when an external task defines one', async () => {
    const current = { ...gatewayJob, displayName: 'Visible name' };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'cron.get') return current;
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

    const task = await service.updateJob(gatewayJob.id, { name: 'Renamed display' });

    expect(task.name).toBe('Renamed display');
    expect(request).toHaveBeenCalledWith('cron.update', {
      id: gatewayJob.id,
      patch: { displayName: 'Renamed display' },
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
      includeDeliveryPreviews: false,
      limit: 200,
      offset: 0,
    });
    expect(request).toHaveBeenNthCalledWith(2, 'cron.list', {
      includeDisabled: true,
      includeDeliveryPreviews: false,
      limit: 200,
      offset: 200,
    });
  });

  test('rejects cron.list pages from different Gateway snapshots', async () => {
    const request = vi.fn(async (_method: string, params?: unknown) => {
      const offset = (params as { offset?: number }).offset ?? 0;
      return offset === 0
        ? { jobs: [gatewayJob], hasMore: true, nextOffset: 200, snapshotRevision: 'rev-1' }
        : { jobs: [], hasMore: false, nextOffset: null, snapshotRevision: 'rev-2' };
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await expect(service.listJobs()).rejects.toThrow(
      'OpenClaw cron.list changed while pagination was in progress.',
    );
    expect(request).toHaveBeenCalledTimes(6);
  });

  test('restarts cron.list pagination when the first snapshot changes', async () => {
    let firstPageCount = 0;
    const request = vi.fn(async (_method: string, params?: unknown) => {
      const offset = (params as { offset?: number }).offset ?? 0;
      if (offset === 0) {
        firstPageCount += 1;
        return {
          jobs: [gatewayJob],
          hasMore: true,
          nextOffset: 200,
          snapshotRevision: firstPageCount === 1 ? 'rev-1' : 'rev-3',
        };
      }
      return {
        jobs: [],
        hasMore: false,
        nextOffset: null,
        snapshotRevision: firstPageCount === 1 ? 'rev-2' : 'rev-3',
      };
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await expect(service.listJobs()).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(4);
  });

  test('converts AgentTurn to SystemEvent in one update without scheduler residue', async () => {
    const current = {
      ...gatewayJob,
      agentId: ScheduledTaskAgentId,
      sessionKey: 'agent:justdo-scheduler:cron:job-1',
    };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'cron.get') return current;
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
      if (method === 'cron.get') return current;
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
    let getCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.get') {
        getCount += 1;
        if (getCount === 1) return gatewayJob;
        throw new Error(`unknown cron job id: ${gatewayJob.id}`);
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
      if (method === 'cron.get') throw new Error(`unknown cron job id: ${gatewayJob.id}`);
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
    let getCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.get') {
        getCount += 1;
        if (getCount === 1) return gatewayJob;
        throw new Error(`unknown cron job id: ${gatewayJob.id}`);
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

  test('keeps declarative OpenClaw jobs read-only', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.get') {
        return { ...gatewayJob, declarationKey: 'system:heartbeat:main' };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await expect(service.toggleJob(gatewayJob.id, false)).rejects.toThrow('system-managed');
    expect(request.mock.calls.map(([method]) => method)).toEqual(['cron.get']);
  });

  test('rejects advanced task edits at the Main-process boundary', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.get') {
        return {
          ...gatewayJob,
          scheduledToolPolicy: { version: 1, mode: 'account' as const },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await expect(service.updateJob(gatewayJob.id, { name: 'Unsafe rename' })).rejects.toThrow(
      'read-only',
    );
    expect(request.mock.calls.map(([method]) => method)).toEqual(['cron.get']);
  });

  test('returns native cron.runs pagination metadata', async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== 'cron.runs') throw new Error(`Unexpected method: ${method}`);
      return {
        entries: [
          {
            ts: 1_700_000_001_000,
            jobId: gatewayJob.id,
            action: 'finished',
            status: 'ok',
            runId: 'run-1',
            runAtMs: 1_700_000_000_000,
          },
        ],
        hasMore: true,
        nextOffset: 20,
      };
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await expect(service.listRunsPage(gatewayJob.id, 20, 0)).resolves.toMatchObject({
      runs: [{ id: 'run-1', status: TaskStatus.Success }],
      hasMore: true,
      nextOffset: 20,
    });
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

  test('projects a Gateway run event immediately and reconciles durable results', async () => {
    const send = vi.fn();
    const onJobFinished = vi.fn().mockResolvedValue(undefined);
    getAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } } as never,
    ]);
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
      onJobFinished,
    });

    await service.reconcileGatewayChange({
      jobId: gatewayJob.id,
      action: 'finished',
      job: gatewayJob,
      runId: 'run-1',
      runAtMs: 1_700_000_000_000,
      ts: 1_700_000_001_000,
      status: 'ok',
      summary: 'done',
    });

    expect(send).toHaveBeenCalledWith(
      IpcChannel.RunUpdate,
      expect.objectContaining({
        run: expect.objectContaining({ id: 'run-1', status: TaskStatus.Success }),
      }),
    );
    expect(onJobFinished).toHaveBeenCalledWith(expect.objectContaining({ id: gatewayJob.id }));
    expect(request).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith(IpcChannel.Refresh);
    getAllWindowsMock.mockReturnValue([]);
  });

  test('rejects a manual run when the confirmed configuration is stale', async () => {
    const current = { ...gatewayJob, configRevision: 'sha256:new' };
    const request = vi.fn(async (method: string) => {
      if (method === 'cron.get') return current;
      throw new Error(`Unexpected method: ${method}`);
    });
    const service = new CronJobService({
      getGatewayClient: () => ({ request }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await expect(service.runJob(gatewayJob.id, 'sha256:old')).rejects.toThrow('changed');
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('does not create a run-history row from a started event without a run ID', async () => {
    const send = vi.fn();
    getAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } } as never,
    ]);
    const service = new CronJobService({
      getGatewayClient: () => ({ request: vi.fn() }) as never,
      ensureGatewayReady: vi.fn(),
    });

    await service.reconcileGatewayChange({
      jobId: gatewayJob.id,
      action: 'started',
      job: { ...gatewayJob, state: { runningAtMs: 1_700_000_000_000 } },
      runAtMs: 1_700_000_000_000,
    });

    expect(send).toHaveBeenCalledWith(IpcChannel.StatusUpdate, expect.any(Object));
    expect(send).not.toHaveBeenCalledWith(IpcChannel.RunUpdate, expect.any(Object));
    expect(send).not.toHaveBeenCalledWith(IpcChannel.Refresh);
    getAllWindowsMock.mockReturnValue([]);
  });
});
