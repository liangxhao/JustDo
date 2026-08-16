import { describe, expect, test } from 'vitest';

import { reconcileSubagentLabel } from '@/features/cowork/components/subagentLabel';

describe('reconcileSubagentLabel', () => {
  test('uses the incoming title when there is no previous snapshot', () => {
    expect(
      reconcileSubagentLabel(undefined, { label: 'Task summary', labelSource: 'task' }),
    ).toEqual({ label: 'Task summary', labelSource: 'task' });
  });

  test('upgrades a label to a task name', () => {
    expect(
      reconcileSubagentLabel(
        { label: 'Friendly label', labelSource: 'label' },
        { label: 'stable-task-name', labelSource: 'taskName' },
      ),
    ).toEqual({ label: 'stable-task-name', labelSource: 'taskName' });
  });

  test('upgrades a task summary to an explicit label', () => {
    expect(
      reconcileSubagentLabel(
        { label: 'Task summary', labelSource: 'task' },
        { label: 'Friendly label', labelSource: 'label' },
      ),
    ).toEqual({ label: 'Friendly label', labelSource: 'label' });
  });

  test('does not downgrade a task name to a label or task summary', () => {
    const taskName = { label: 'stable-task-name', labelSource: 'taskName' as const };

    expect(
      reconcileSubagentLabel(taskName, { label: 'Friendly label', labelSource: 'label' }),
    ).toEqual(taskName);
    expect(
      reconcileSubagentLabel(taskName, { label: 'Task summary', labelSource: 'task' }),
    ).toEqual(taskName);
  });

  test('accepts updates from the same source', () => {
    expect(
      reconcileSubagentLabel(
        { label: 'Old task name', labelSource: 'taskName' },
        { label: 'New task name', labelSource: 'taskName' },
      ),
    ).toEqual({ label: 'New task name', labelSource: 'taskName' });
  });
});
