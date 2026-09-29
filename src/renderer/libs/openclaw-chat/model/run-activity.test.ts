import { describe, expect, it } from 'vitest';

import {
  projectWaitingStatus,
  RUN_LONG_NOTICE_MS,
  RUN_SLOW_NOTICE_MS,
  RUN_STALL_NOTICE_MS,
  type RunActivity,
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
