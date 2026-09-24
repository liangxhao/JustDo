import type { ScheduledTask, SystemTaskSettings } from '@shared/scheduledTask/types';

import { withMemoryDreamingCard } from './memoryDreamingControl';
import { isSkillCollectionReviewTask } from './utils';

// Renderer-only aggregate. All mutations target feature config or real member IDs.
export const SKILL_REVIEW_CARD_ID = 'skill-review-feature';
export function withSkillReviewCard(
  tasks: ScheduledTask[],
  settings: SystemTaskSettings | null,
): ScheduledTask[] {
  const members = tasks.filter(isSkillCollectionReviewTask);
  if (!settings && members.length === 0) return tasks;
  const fallback = withMemoryDreamingCard([], settings)[0];
  const latest = [...members].sort(
    (a, b) => (b.state.lastRunAtMs ?? 0) - (a.state.lastRunAtMs ?? 0),
  );
  const representative =
    latest.find(task => task.state.lastStatus === 'error') ?? latest[0] ?? fallback;
  const nextRuns = members
    .filter(task => task.enabled && task.state.nextRunAtMs !== null)
    .map(task => task.state.nextRunAtMs!);
  const enabled = settings ? settings.skillMode === 'auto' : members.some(task => task.enabled);
  const card: ScheduledTask = {
    ...representative,
    id: SKILL_REVIEW_CARD_ID,
    name: '',
    description: '',
    agentId: null,
    sessionKey: null,
    declarationKey: null,
    management: 'managed',
    payload: { kind: 'skillCollectionReview' },
    enabled,
    state: {
      ...representative.state,
      nextRunAtMs: enabled && nextRuns.length ? Math.min(...nextRuns) : null,
    },
  };
  return [...tasks.filter(task => !isSkillCollectionReviewTask(task)), card];
}
