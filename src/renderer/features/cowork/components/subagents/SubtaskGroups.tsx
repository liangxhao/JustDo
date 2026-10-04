import type { ReactNode } from 'react';

import { i18nService } from '@/services/i18n';

import type { Subtask } from './subtaskPresentation';

/** Group only explicit native membership, within the supplied status/page scope. */
export default function SubtaskGroups({
  tasks,
  renderTask,
}: {
  tasks: readonly Subtask[];
  renderTask: (task: Subtask) => ReactNode;
}) {
  const groups = new Map<string, Subtask[]>();
  for (const task of tasks) {
    if (!task.swarmGroupId) continue;
    const members = groups.get(task.swarmGroupId) ?? [];
    members.push(task);
    groups.set(task.swarmGroupId, members);
  }
  return tasks.map(task => {
    const groupId = task.swarmGroupId;
    if (!groupId) return renderTask(task);
    const members = groups.get(groupId)!;
    if (members[0] !== task) return null;
    const label = i18nService.t('subtaskSwarmGroup').replace('{group}', groupId);
    return (
      <fieldset
        key={`swarm:${groupId}`}
        role="listitem"
        className="min-w-0 rounded-xl border"
        style={{
          borderColor:
            'color-mix(in srgb, var(--justdo-text-secondary) 40%, var(--justdo-surface))',
        }}
      >
        <legend
          className="mx-auto max-w-[75%] truncate px-2 text-center text-[11px] font-medium text-secondary"
          title={groupId}
        >
          {groupId}
        </legend>
        <div role="list" aria-label={label} className="space-y-0.5 px-1.5 pb-1.5">
          {members.map(renderTask)}
        </div>
      </fieldset>
    );
  });
}
