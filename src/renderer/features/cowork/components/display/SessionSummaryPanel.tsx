import {
  ChatBubbleLeftEllipsisIcon,
  ClockIcon,
  LinkIcon,
  ShareIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { ProgressCard } from '@shared/openclaw/progressCard';
import { type RefObject, useEffect, useRef } from 'react';

import type {
  SessionSummaryResources,
  SummaryResource,
} from '@/libs/openclaw-chat/model/session-summary-resources';
import { i18nService } from '@/services/i18n';
import { isDomNode, useOwnerDocument } from '@/shared/dom/ownerDocument';

import SessionProgressCard, { type ProgressCardRunState } from '../status/SessionProgressCard';
import type { Subtask } from '../subagents/subtaskPresentation';
import { isActiveSubtask } from '../subagents/subtaskPresentation';
import { type AgentTeamEntry, AgentTeamKind } from './agentTeamEntries';
import type { SummaryResourceListKind } from './displayTabIds';
import { SessionSummaryResourceIcon } from './SessionSummaryResourceList';

export function summarySubagentCounts(tasks: readonly Subtask[]) {
  return {
    running: tasks.filter(task => isActiveSubtask(task.status)).length,
    completed: tasks.filter(task => task.status === 'done').length,
    failed: tasks.filter(task => ['failed', 'killed', 'timeout', 'blocked'].includes(task.status))
      .length,
  };
}

interface Props {
  sessionId: string;
  visible: boolean;
  anchorRef: RefObject<HTMLElement>;
  objective?: string;
  progress?: {
    card: ProgressCard;
    runState: ProgressCardRunState;
    onRefresh: () => Promise<boolean>;
  };
  tasks: readonly Subtask[];
  resources: SessionSummaryResources | null;
  workflowCount: number;
  teamEntries: readonly AgentTeamEntry[];
  onClose: () => void;
  onOpenSubagents: () => void;
  onOpenWorkflow: () => void;
  onOpenTeam: () => void;
  onOpenTeamHistory?: () => void;
  onOpenResource: (resource: SummaryResource) => void;
  onOpenResourceList: (kind: SummaryResourceListKind) => void;
}

const rowClass =
  'flex w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

const subagentIconColors = [
  'text-amber-500',
  'text-orange-400',
  'text-violet-500',
  'text-teal-500',
] as const;

function SubagentSummaryIcon({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`h-4 w-4 shrink-0 ${className}`}>
      <g fill="currentColor">
        {[0, 45, 90, 135].map(angle => (
          <ellipse key={angle} cx="10" cy="10" rx="3" ry="8" transform={`rotate(${angle} 10 10)`} />
        ))}
      </g>
      <circle cx="10" cy="10" r="2.5" fill="white" fillOpacity="0.25" />
    </svg>
  );
}

function ResourceRows({
  items,
  onOpen,
  onViewAll,
}: {
  items: SummaryResource[];
  onOpen: Props['onOpenResource'];
  onViewAll: () => void;
}) {
  return (
    <>
      {items.slice(0, 3).map(item => (
        <button
          key={item.id}
          type="button"
          className={`${rowClass} py-1.5 text-[13px] leading-[18px]`}
          title={item.title}
          onClick={() => onOpen(item)}
        >
          <SessionSummaryResourceIcon resource={item} />
          <span className="min-w-0 flex-1 truncate">
            {item.title || i18nService.t('coworkSummaryAttachment')}
          </span>
        </button>
      ))}
      {items.length > 3 && (
        <button
          type="button"
          className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={onViewAll}
        >
          <LinkIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
          {i18nService.t('coworkSummaryViewAll')}
        </button>
      )}
    </>
  );
}

export default function SessionSummaryPanel(props: Props) {
  const { visible, anchorRef, onClose } = props;
  const ownerDocument = useOwnerDocument();
  const panelRef = useRef<HTMLElement>(null);
  const counts = summarySubagentCounts(props.tasks);
  const teamCountLabel = [
    { kind: AgentTeamKind.TASK, key: 'teamSummaryTaskCount' },
    { kind: AgentTeamKind.GROUP, key: 'teamSummaryGroupCount' },
  ]
    .flatMap(({ kind, key }) => {
      const count = props.teamEntries.filter(entry => entry.kind === kind).length;
      return count > 0 ? [i18nService.t(key).replace('{count}', String(count))] : [];
    })
    .join(i18nService.t('teamSummaryCountSeparator'));
  const subagentStatuses = [
    { count: counts.running, key: 'coworkSummaryRunning', className: 'text-primary' },
    { count: counts.completed, key: 'coworkSummaryCompleted', className: '' },
    {
      count: counts.failed,
      key: 'coworkSummaryFailed',
      className: 'text-red-600 dark:text-red-400',
    },
  ].map(status => ({
    ...status,
    label: i18nService.t(status.key).replace('{count}', String(status.count)),
  }));
  const subagentsLabel = subagentStatuses.map(status => status.label).join(' ');
  const visibleSubagentStatuses = subagentStatuses.some(status => status.count > 0)
    ? subagentStatuses.filter(status => status.count > 0)
    : subagentStatuses;
  useEffect(() => {
    if (!visible) return;
    const onPointer = (event: PointerEvent) => {
      if (!isDomNode(event.target)) return;
      if (panelRef.current?.contains(event.target) || anchorRef.current?.contains(event.target))
        return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
      anchorRef.current?.focus();
    };
    ownerDocument.addEventListener('pointerdown', onPointer);
    ownerDocument.addEventListener('keydown', onKey);
    return () => {
      ownerDocument.removeEventListener('pointerdown', onPointer);
      ownerDocument.removeEventListener('keydown', onKey);
    };
  }, [visible, anchorRef, onClose, ownerDocument]);
  if (!visible) return null;
  const heading = (key: string) => (
    <h3 className="px-2 pb-1 text-xs font-medium text-muted">{i18nService.t(key)}</h3>
  );
  return (
    <aside
      ref={panelRef}
      id="cowork-session-summary"
      role="dialog"
      aria-label={i18nService.t('coworkSummaryTitle')}
      className="absolute right-0 top-full z-[90] mt-2 flex max-h-[min(42rem,calc(100dvh-5rem))] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface/95 shadow-popover backdrop-blur-xl"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold text-foreground">
          {i18nService.t('coworkSummaryTitle')}
        </h2>
        <button
          type="button"
          aria-label={i18nService.t('close')}
          className="rounded-md p-1 text-secondary hover:bg-surface-raised"
          onClick={onClose}
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 space-y-4 overflow-y-auto p-3">
        {props.objective && (
          <section>
            {heading('coworkSummaryGoal')}
            <p className="break-words px-2 text-sm leading-6 text-foreground">{props.objective}</p>
          </section>
        )}
        {props.progress && (
          <SessionProgressCard
            key={props.progress.card.sessionKey}
            card={props.progress.card}
            runState={props.progress.runState}
            onRefresh={props.progress.onRefresh}
          />
        )}
        {props.tasks.length > 0 && (
          <section>
            {heading('coworkSummarySubagents')}
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-secondary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={subagentsLabel}
              onClick={props.onOpenSubagents}
            >
              <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
                {props.tasks.slice(0, subagentIconColors.length).map((task, index) => (
                  <SubagentSummaryIcon key={task.id} className={subagentIconColors[index]} />
                ))}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 leading-5 tabular-nums">
                {visibleSubagentStatuses.map(status => (
                  <span
                    key={status.key}
                    className={`whitespace-nowrap ${status.count ? status.className : 'text-muted'}`}
                  >
                    {status.label}
                  </span>
                ))}
              </span>
            </button>
          </section>
        )}
        <section>
          <div className="flex items-center justify-between gap-2 px-2 pb-1">
            <h3 className="text-xs font-medium text-muted">
              {i18nService.t('coworkSummaryOutputs')}
            </h3>
            {!props.resources?.outputs.length &&
              !props.resources?.outputsUnavailable &&
              !props.resources?.omittedOversized && (
                <span className="shrink-0 text-[9px] leading-4 text-muted">
                  {i18nService.t('coworkSummaryOutputsNone')}
                </span>
              )}
          </div>
          {!!props.resources?.outputs.length && (
            <ResourceRows
              key={`${props.sessionId}:outputs`}
              items={props.resources.outputs}
              onOpen={props.onOpenResource}
              onViewAll={() => props.onOpenResourceList('outputs')}
            />
          )}
          {props.resources?.outputsUnavailable && (
            <p role="status" className="px-2 py-2 text-xs text-muted">
              {i18nService.t('coworkSummaryOutputsUnavailable')}
            </p>
          )}
          {props.resources?.omittedOversized && (
            <p className="px-2 py-2 text-xs text-muted">
              {i18nService.t('coworkSummaryOutputsPartial')}
            </p>
          )}
        </section>
        {!!props.resources?.sources.length && (
          <section>
            {heading('coworkSummarySources')}
            <ResourceRows
              key={`${props.sessionId}:sources`}
              items={props.resources.sources}
              onOpen={props.onOpenResource}
              onViewAll={() => props.onOpenResourceList('sources')}
            />
          </section>
        )}
        {props.workflowCount > 0 && (
          <button
            type="button"
            className={`${rowClass} py-2 text-sm`}
            aria-label={`${i18nService.t('swarmWorkflowTitle')} ${props.workflowCount}`}
            onClick={props.onOpenWorkflow}
          >
            <ShareIcon className="h-4 w-4 shrink-0 text-secondary" />
            <span className="min-w-0 flex-1">{i18nService.t('swarmWorkflowTitle')}</span>
            <span className="text-secondary">{props.workflowCount}</span>
          </button>
        )}
        {(props.teamEntries.length > 0 || props.onOpenTeamHistory) && (
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              className={`${rowClass} flex-1 py-2 text-sm`}
              aria-label={[i18nService.t('coworkSummaryAgentTeam'), teamCountLabel]
                .filter(Boolean)
                .join(' ')}
              onClick={props.teamEntries.length ? props.onOpenTeam : props.onOpenTeamHistory}
            >
              <ChatBubbleLeftEllipsisIcon className="h-4 w-4 shrink-0 text-secondary" />
              <span className="shrink-0">{i18nService.t('coworkSummaryAgentTeam')}</span>
              {teamCountLabel && (
                <span className="min-w-0 flex-1 text-right text-xs text-secondary tabular-nums">
                  {teamCountLabel}
                </span>
              )}
              {!props.teamEntries.length && (
                <ClockIcon aria-hidden="true" className="ml-auto h-4 w-4 text-secondary" />
              )}
            </button>
            {props.teamEntries.length > 0 && props.onOpenTeamHistory && (
              <button
                type="button"
                title={i18nService.t('teamAllRecords')}
                aria-label={i18nService.t('teamAllRecords')}
                onClick={props.onOpenTeamHistory}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <ClockIcon aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
