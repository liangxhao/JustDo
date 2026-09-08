import { describe, expect, test } from 'vitest';

import {
  ACTIVE_SUBAGENT_POLL_INTERVAL_MS,
  IDLE_SUBAGENT_POLL_INTERVAL_MS,
  isActiveSubagentStatus,
  resolveSubagentPollInterval,
} from './subagentPolling';

describe('subagent status polling', () => {
  test('uses the active cadence while the parent or a child can still change state', () => {
    expect(resolveSubagentPollInterval(true, [])).toBe(ACTIVE_SUBAGENT_POLL_INTERVAL_MS);
    expect(resolveSubagentPollInterval(false, ['done', 'pending'])).toBe(
      ACTIVE_SUBAGENT_POLL_INTERVAL_MS,
    );
    expect(resolveSubagentPollInterval(false, ['running'])).toBe(ACTIVE_SUBAGENT_POLL_INTERVAL_MS);
  });

  test('backs off after every known child is terminal', () => {
    expect(resolveSubagentPollInterval(false, [])).toBe(IDLE_SUBAGENT_POLL_INTERVAL_MS);
    expect(resolveSubagentPollInterval(false, ['done', 'failed', 'killed', 'timeout'])).toBe(
      IDLE_SUBAGENT_POLL_INTERVAL_MS,
    );
    expect(isActiveSubagentStatus('done')).toBe(false);
  });
});
