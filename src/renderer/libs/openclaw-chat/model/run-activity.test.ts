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
  activeRunConfirmedAt: null,
  probeState: 'idle',
  ...overrides,
});

describe('projectWaitingStatus', () => {
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

  it('uses warning copy for a long wait without claiming the run is active', () => {
    expect(
      projectWaitingStatus({
        activity: activity(),
        transportStatus: 'connected',
        now: 1_000 + RUN_LONG_NOTICE_MS,
      }),
    ).toMatchObject({ kind: 'long-wait', tone: 'warning' });
  });

  it('uses the long-wait warning after three minutes even while retrying', () => {
    expect(
      projectWaitingStatus({
        activity: activity({ stage: 'retrying', retryReason: 'rate_limit' }),
        transportStatus: 'connected',
        now: 1_000 + RUN_LONG_NOTICE_MS,
      }),
    ).toMatchObject({ kind: 'long-wait', tone: 'warning' });
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

  it('uses a factual notice when a visible tool has no activity', () => {
    expect(
      projectWaitingStatus({
        activity: activity({ stage: 'running-tool' }),
        transportStatus: 'connected',
        now: 1_000 + RUN_LONG_NOTICE_MS,
      }),
    ).toMatchObject({ kind: 'long-wait', tone: 'warning' });
  });

  it('identifies a stalled tool before the long-wait threshold', () => {
    expect(
      projectWaitingStatus({
        activity: activity({ stage: 'running-tool' }),
        transportStatus: 'connected',
        now: 1_000 + RUN_STALL_NOTICE_MS,
      }),
    ).toMatchObject({ kind: 'waiting-tool', tone: 'neutral' });
  });
});
