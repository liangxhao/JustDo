import {
  type WorkboardCard,
  workboardCardHasLiveExecution,
  type WorkboardStatus,
} from '@shared/openclaw/workboard';

export const WORKBOARD_COLUMNS = ['pending', 'running', 'attention', 'done'] as const;
export type WorkboardColumn = (typeof WORKBOARD_COLUMNS)[number];

const STATUS_COLUMNS: Record<WorkboardStatus, WorkboardColumn> = {
  triage: 'pending',
  backlog: 'pending',
  todo: 'pending',
  scheduled: 'pending',
  ready: 'pending',
  running: 'running',
  review: 'attention',
  blocked: 'attention',
  done: 'done',
};

export const workboardColumn = (card: WorkboardCard): WorkboardColumn =>
  workboardCardHasLiveExecution(card) ? 'running' : STATUS_COLUMNS[card.status];

// Native scheduling and review states stay intact; these are explicit user actions.
export const canRequeueWorkboardCard = (card: WorkboardCard): boolean =>
  !card.metadata?.archivedAt &&
  !workboardCardHasLiveExecution(card) &&
  (['triage', 'review', 'blocked', 'done'].includes(card.status) ||
    (card.status === 'scheduled' && !card.metadata?.automation?.scheduledAt));

export const canCompleteWorkboardCard = (card: WorkboardCard): boolean =>
  !card.metadata?.archivedAt && !workboardCardHasLiveExecution(card) && card.status === 'review';
