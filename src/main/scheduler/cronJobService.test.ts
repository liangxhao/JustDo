import { describe, expect, test, vi } from 'vitest';

import { DeliveryMode, GatewayStatus, TaskStatus } from '../../shared/scheduledTask/constants';
import {
  CronJobService,
  mapGatewayJob,
  mapGatewayRun,
  mapGatewayTaskState,
  shouldRepairInAppOnlyDeliveryBackoff,
} from './cronJobService';

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
      shouldRepairInAppOnlyDeliveryBackoff(
        createMissingChannelJob({ mode: DeliveryMode.None }),
      ),
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
    expect(mapGatewayRun({ ...baseEntry, runAtMs: undefined }).id).toBe(
      'job-1:1700000000000',
    );
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
