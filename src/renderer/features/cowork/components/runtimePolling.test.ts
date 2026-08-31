import { describe, expect, it } from 'vitest';

import { resolveBackgroundRuntimeSessionIds } from './runtimePolling';

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
});
