import type { ScheduledTaskResult } from '@shared/scheduledTask/types';
import { describe, expect, test } from 'vitest';

import { isResultTaskDeleted } from './ResultInbox';

const result = {
  taskId: 'heartbeat-main',
  systemManaged: true,
} satisfies Pick<ScheduledTaskResult, 'taskId' | 'systemManaged'>;

describe('ResultInbox task presentation', () => {
  test('does not label hidden system task results as deleted', () => {
    expect(isResultTaskDeleted(result, [])).toBe(false);
  });

  test('labels a missing user task result as deleted', () => {
    expect(isResultTaskDeleted({ ...result, systemManaged: false }, [])).toBe(true);
    expect(
      isResultTaskDeleted({ ...result, systemManaged: false }, [{ id: 'heartbeat-main' }]),
    ).toBe(false);
  });
});
