import { describe, expect, test } from 'vitest';

import { TaskStatus } from './constants';
import {
  getHeartbeatSkippedReason,
  isRoutineScheduledTaskResult,
  isSilentScheduledTaskResult,
} from './resultPresentation';

describe('scheduled task result presentation', () => {
  test('recognizes only the exact OpenClaw silent reply marker', () => {
    expect(isSilentScheduledTaskResult('NO_REPLY')).toBe(true);
    expect(isSilentScheduledTaskResult('  no_reply  ')).toBe(true);
    expect(isSilentScheduledTaskResult('No reply was needed')).toBe(false);
    expect(isSilentScheduledTaskResult(null)).toBe(false);
  });

  test('extracts an OpenClaw heartbeat skip reason', () => {
    expect(getHeartbeatSkippedReason('heartbeat skipped: no-route')).toBe('no-route');
    expect(getHeartbeatSkippedReason(' HEARTBEAT SKIPPED: quiet-hours ')).toBe('quiet-hours');
    expect(getHeartbeatSkippedReason('heartbeat skipped:')).toBe('unknown');
    expect(getHeartbeatSkippedReason('execution failed')).toBeNull();
  });

  test('classifies silent successes and skipped heartbeats as routine', () => {
    expect(
      isRoutineScheduledTaskResult({
        status: TaskStatus.Success,
        summary: 'NO_REPLY',
        error: null,
      }),
    ).toBe(true);
    expect(
      isRoutineScheduledTaskResult({
        status: TaskStatus.Skipped,
        summary: null,
        error: 'heartbeat skipped: no-route',
        systemManaged: true,
      }),
    ).toBe(true);
    expect(
      isRoutineScheduledTaskResult({
        status: TaskStatus.Skipped,
        summary: null,
        error: 'heartbeat skipped:',
        systemManaged: true,
      }),
    ).toBe(true);
    expect(
      isRoutineScheduledTaskResult({
        status: TaskStatus.Skipped,
        summary: null,
        error: 'heartbeat skipped: no-route',
        systemManaged: false,
      }),
    ).toBe(false);
    expect(
      isRoutineScheduledTaskResult({
        status: TaskStatus.Error,
        summary: null,
        error: 'heartbeat failed: agent-runner-failure',
      }),
    ).toBe(false);
  });
});
