import { describe, expect, it } from 'vitest';

import {
  advanceRunActivity,
  projectWaitingStatus,
  RUN_LONG_NOTICE_MS,
  RUN_SLOW_NOTICE_MS,
  RUN_STALL_NOTICE_MS,
  type RunActivity,
  type RunProgressDetail,
  type RunProgressStage,
} from './run-activity';

const activity = (overrides: Partial<RunActivity> = {}): RunActivity => ({
  runId: 'run-1',
  stage: 'waiting-model',
  startedAt: 1_000,
  stageChangedAt: 1_000,
  lastAgentEventAt: 1_000,
  lastModelActivityAt: null,
  hasRunningTool: false,
  activeRunConfirmedAt: null,
  probeState: 'idle',
  ...overrides,
});

describe('content-free model activity', () => {
  const details: Array<{ stage: RunProgressStage; progress: RunProgressDetail }> = [
    { stage: 'thinking', progress: { kind: 'model-stream', receivedChars: 120 } },
    { stage: 'responding', progress: { kind: 'model-stream', receivedChars: 240 } },
    {
      stage: 'generating-tool-input',
      progress: {
        kind: 'tool-input', toolCallId: 'call-1', name: 'tool_call',
        receivedChars: 2_000, complete: false,
      },
    },
    {
      stage: 'preparing-tool',
      progress: {
        kind: 'tool-input', toolCallId: 'call-1', name: 'tool_call',
        receivedChars: 2_000, complete: true,
      },
    },
    {
      stage: 'running-tool',
      progress: { kind: 'tool', toolCallId: 'call-1', name: 'read', summary: 'Reading' },
    },
    { stage: 'receiving-model', progress: { kind: 'model-stream', receivedChars: 360 } },
  ];

  it.each(details)('preserves the $stage stage and its real detail', ({ stage, progress }) => {
    const previous = activity({ stage, progress });
    const next = advanceRunActivity(previous, 'receiving-model', {
      modelActivity: true, progress: { kind: 'model-activity' }, at: 2_000,
    }, stage === 'running-tool');

    expect(next).toMatchObject({
      stage, progress, lastAgentEventAt: 2_000, lastModelActivityAt: 2_000,
      hasRunningTool: stage === 'running-tool',
    });
    expect(next.progress).toBe(progress);
    expect(next.stageChangedAt).toBe(previous.stageChangedAt);
    expect(previous.lastModelActivityAt).toBeNull();
  });

  it('supplies only activity freshness when thinking has no public counters', () => {
    const next = advanceRunActivity(activity({ stage: 'thinking' }), 'receiving-model', {
      modelActivity: true, progress: { kind: 'model-activity' }, at: 2_000,
    }, false);
    expect(next).toMatchObject({ stage: 'thinking', progress: { kind: 'model-activity' } });
    expect(next.progress).not.toHaveProperty('receivedChars');
  });

  it('leaves a retry when the current model produces activity', () => {
    const previous = activity({
      stage: 'retrying', retryReason: 'timeout', retryAttempt: 1, maxRetries: 2,
      retryAt: 8_000, progress: { kind: 'model-stream', receivedChars: 120 },
    });
    const next = advanceRunActivity(previous, 'receiving-model', {
      modelActivity: true, progress: { kind: 'model-activity' }, at: 2_000,
    }, false);
    expect(next).toMatchObject({
      stage: 'receiving-model', progress: { kind: 'model-activity' }, stageChangedAt: 2_000,
    });
    for (const field of ['retryReason', 'retryAttempt', 'maxRetries', 'retryAt']) {
      expect(next).not.toHaveProperty(field);
    }
  });
});

describe('projectWaitingStatus', () => {
  it('shows an explicit retry immediately without waiting for a stall', () => {
    expect(
      projectWaitingStatus({
        activity: activity({ stage: 'retrying', retryReason: 'rate_limit' }),
        transportStatus: 'connected',
        now: 2_000,
      }),
    ).toMatchObject({ kind: 'rate-limited' });
  });

  it.each([1, 2])('projects the admitted format recovery attempt %i', retryAttempt => {
    expect(
      projectWaitingStatus({
        activity: activity({
          stage: 'retrying',
          retryReason: 'tool_call_format',
          retryAttempt,
          maxRetries: 2,
        }),
        transportStatus: 'connected',
        now: 2_000,
      }),
    ).toEqual({
      kind: 'retry-tool-call-format',
      tone: 'neutral',
      quietMs: 1_000,
      retryAttempt,
      maxRetries: 2,
    });
  });

  it.each([
    [0, 2],
    [3, 2],
    [1.5, 2],
    [Number.NaN, 2],
    [1, 3],
    [1, undefined],
  ])('omits unsupported format recovery progress %s/%s', (retryAttempt, maxRetries) => {
    expect(
      projectWaitingStatus({
        activity: activity({
          stage: 'retrying',
          retryReason: 'tool_call_format',
          retryAttempt,
          maxRetries,
        }),
        transportStatus: 'connected',
        now: 2_000,
      }),
    ).toEqual({ kind: 'retry-tool-call-format', tone: 'neutral', quietMs: 1_000 });
  });

  it('does not carry format counters into another retry reason', () => {
    expect(
      projectWaitingStatus({
        activity: activity({
          stage: 'retrying',
          retryReason: 'rate_limit',
          retryAttempt: 1,
          maxRetries: 2,
        }),
        transportStatus: 'connected',
        now: 2_000,
      }),
    ).toEqual({ kind: 'rate-limited', tone: 'neutral', quietMs: 1_000 });
  });

  it('keeps the existing UI unchanged before the stall threshold', () => {
    expect(
      projectWaitingStatus({
        activity: activity(),
        transportStatus: 'connected',
        now: 1_000 + RUN_STALL_NOTICE_MS - 1,
      }),
    ).toBeNull();
  });

  it('shows model waiting at the stall threshold', () => {
    expect(
      projectWaitingStatus({
        activity: activity(),
        transportStatus: 'connected',
        now: 1_000 + RUN_STALL_NOTICE_MS,
      }),
    ).toMatchObject({ kind: 'waiting-model', tone: 'neutral' });
  });

  it.each(['queued', 'preparing'] as const)(
    'keeps the explicit %s stage instead of inventing a model wait',
    stage => {
      expect(
        projectWaitingStatus({
          activity: activity({ stage }),
          transportStatus: 'connected',
          now: 1_000 + RUN_STALL_NOTICE_MS,
        }),
      ).toBeNull();
    },
  );

  it('starts a fresh silence window when a tool finishes after a long run', () => {
    expect(
      projectWaitingStatus({
        activity: activity({ stageChangedAt: 100_000, lastModelActivityAt: 1000 }),
        transportStatus: 'connected',
        now: 100_001,
      }),
    ).toBeNull();
  });

  it('only claims a slow active run after a fresh gateway confirmation', () => {
    const now = 1_000 + RUN_SLOW_NOTICE_MS;
    expect(
      projectWaitingStatus({ activity: activity(), transportStatus: 'connected', now }),
    ).toMatchObject({ kind: 'waiting-model' });
    expect(
      projectWaitingStatus({
        activity: activity({ activeRunConfirmedAt: now - 1_000, probeState: 'active' }),
        transportStatus: 'connected',
        now,
      }),
    ).toMatchObject({ kind: 'slow-active' });
  });

  it('uses warning copy for a long wait only after fresh active-run confirmation', () => {
    const now = 1_000 + RUN_LONG_NOTICE_MS;
    expect(
      projectWaitingStatus({
        activity: activity({ activeRunConfirmedAt: now - 1_000, probeState: 'active' }),
        transportStatus: 'connected',
        now,
      }),
    ).toMatchObject({ kind: 'long-wait', tone: 'warning' });
  });

  it('does not claim a four-minute request is active without fresh confirmation', () => {
    const now = 1_000 + RUN_LONG_NOTICE_MS;
    expect(
      projectWaitingStatus({ activity: activity(), transportStatus: 'connected', now }),
    ).toMatchObject({ kind: 'waiting-model', tone: 'neutral' });
    expect(
      projectWaitingStatus({
        activity: activity({
          activeRunConfirmedAt: now - 31_000,
          probeState: 'idle',
        }),
        transportStatus: 'connected',
        now,
      }),
    ).toMatchObject({ kind: 'waiting-model', tone: 'neutral' });
    expect(
      projectWaitingStatus({
        activity: activity({ probeState: 'failed' }),
        transportStatus: 'connected',
        now,
      }),
    ).toMatchObject({ kind: 'probe-failed', tone: 'neutral' });
  });

  it('preserves the specific retry reason even after four minutes', () => {
    const now = 1_000 + RUN_LONG_NOTICE_MS;
    expect(
      projectWaitingStatus({
        activity: activity({
          stage: 'retrying',
          retryReason: 'rate_limit',
          activeRunConfirmedAt: now - 1_000,
          probeState: 'active',
        }),
        transportStatus: 'connected',
        now,
      }),
    ).toMatchObject({ kind: 'rate-limited', tone: 'neutral' });
  });

  it.each([
    ['timeout', 'retry-timeout'],
    ['overloaded', 'retry-overloaded'],
    ['auth', 'retry-auth'],
    ['unknown', 'retrying'],
  ] as const)('describes an explicit %s retry without guessing', (retryReason, kind) => {
    expect(
      projectWaitingStatus({
        activity: activity({ stage: 'retrying', retryReason }),
        transportStatus: 'connected',
        now: 2_000,
      }),
    ).toMatchObject({ kind });
  });

  it('distinguishes a pause in the reply and clears it when content resumes', () => {
    const now = 1_000 + RUN_STALL_NOTICE_MS;
    expect(
      projectWaitingStatus({
        activity: activity({ stage: 'responding' }),
        transportStatus: 'connected',
        now,
      }),
    ).toMatchObject({ kind: 'response-paused' });
    expect(
      projectWaitingStatus({
        activity: activity({ stage: 'responding', lastModelActivityAt: now }),
        transportStatus: 'connected',
        now,
      }),
    ).toBeNull();
  });

  it('does not claim a disconnected run is active or reconnecting', () => {
    const now = 1_000 + RUN_LONG_NOTICE_MS;
    expect(
      projectWaitingStatus({
        activity: activity({ activeRunConfirmedAt: now, hasRunningTool: true }),
        transportStatus: 'disconnected',
        now,
      }),
    ).toMatchObject({ kind: 'disconnected', tone: 'warning' });
  });

  it('prioritizes reconnecting and rate-limit states', () => {
    expect(
      projectWaitingStatus({
        activity: activity(),
        transportStatus: 'reconnecting',
        now: 2_000,
      }),
    ).toMatchObject({ kind: 'reconnecting', tone: 'warning' });
    expect(
      projectWaitingStatus({
        activity: activity({ stage: 'retrying', retryReason: 'rate_limit' }),
        transportStatus: 'connected',
        now: 1_000 + RUN_STALL_NOTICE_MS,
      }),
    ).toMatchObject({ kind: 'rate-limited' });
  });

  it('does not show a model-stall notice while a tool is still running', () => {
    const now = 1_000 + RUN_LONG_NOTICE_MS;
    expect(
      projectWaitingStatus({
        activity: activity({
          stage: 'running-tool',
          hasRunningTool: true,
          activeRunConfirmedAt: now - 1_000,
          probeState: 'active',
        }),
        transportStatus: 'connected',
        now,
      }),
    ).toBeNull();
  });

  it('keeps tool execution free of model-stall notices at the first threshold', () => {
    expect(
      projectWaitingStatus({
        activity: activity({ stage: 'running-tool', hasRunningTool: true }),
        transportStatus: 'connected',
        now: 1_000 + RUN_STALL_NOTICE_MS,
      }),
    ).toBeNull();
  });
});
