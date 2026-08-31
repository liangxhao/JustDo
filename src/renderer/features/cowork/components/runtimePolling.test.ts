import { describe, expect, it } from 'vitest';

import {
  resolveBackgroundRuntimeDiscoverySessionIds,
  resolveBackgroundRuntimeSessionIds,
  shouldContinueFullRuntimeScan,
} from './runtimePolling';

describe('resolveBackgroundRuntimeSessionIds', () => {
  it('polls only non-current sessions that may still be running', () => {
    const sessions = [
      { id: 'current', status: 'running' as const },
      { id: 'persisted-running', status: 'running' as const },
      { id: 'runtime-running', status: 'idle' as const },
      { id: 'idle', status: 'idle' as const },
      { id: 'temp-new', status: 'running' as const },
    ];

    expect(
      resolveBackgroundRuntimeSessionIds(sessions, 'current', {
        'runtime-running': true,
        idle: false,
      }),
    ).toEqual(['persisted-running', 'runtime-running']);
  });

  it('keeps idle background sessions in the low-frequency discovery sweep', () => {
    const sessions = [
      { id: 'current', status: 'idle' as const },
      { id: 'idle-background', status: 'idle' as const },
      { id: 'running-background', status: 'running' as const },
      { id: 'temp-new', status: 'running' as const },
    ];

    expect(resolveBackgroundRuntimeDiscoverySessionIds(sessions, 'current')).toEqual([
      'idle-background',
      'running-background',
    ]);
  });
});

describe('shouldContinueFullRuntimeScan', () => {
  it('keeps scanning while the paginated runtime state is unknown', () => {
    expect(
      shouldContinueFullRuntimeScan({
        known: false,
        mainRunning: false,
        subagentRunning: false,
        running: false,
      }),
    ).toBe(true);
  });

  it('keeps scanning while an open run receipt awaits a second known-idle snapshot', () => {
    expect(
      shouldContinueFullRuntimeScan({
        known: true,
        mainRunning: false,
        subagentRunning: false,
        running: true,
      }),
    ).toBe(true);
  });

  it('returns to lightweight polling while Gateway reports active work', () => {
    expect(
      shouldContinueFullRuntimeScan({
        known: true,
        mainRunning: true,
        subagentRunning: false,
        running: true,
      }),
    ).toBe(false);
  });

  it('stops scanning after terminal state is confirmed', () => {
    expect(
      shouldContinueFullRuntimeScan({
        known: true,
        mainRunning: false,
        subagentRunning: false,
        running: false,
      }),
    ).toBe(false);
  });
});
