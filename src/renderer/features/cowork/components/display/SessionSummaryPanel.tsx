import './SessionSummaryPanel.css';

import {
  LinkIcon,
  ShareIcon,
  UserGroupIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { ProgressCard } from '@shared/openclaw/progressCard';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

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
  teamEnabled: boolean;
  onClose: () => void;
  onOpenSubagents: () => void;
  onOpenWorkflow: () => void;
  onOpenTeam: () => void;
  onOpenResource: (resource: SummaryResource) => void;
  onOpenResourceList: (kind: SummaryResourceListKind) => void;
}

const rowClass =
  'session-summary-panel__action flex w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

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
          className="session-summary-panel__action mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-secondary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [limits, setLimits] = useState<{ maxWidth: number; maxHeight: number } | null>(null);
  const resizeStart = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    const panel = panelRef.current;
    const view = panel?.ownerDocument.defaultView;
    if (!panel || !view) return;
    const updateLimits = () => {
      const bounds = panel.getBoundingClientRect();
      const next = {
        maxWidth: Math.max(0, bounds.right - 16),
        maxHeight: Math.max(0, panel.ownerDocument.documentElement.clientHeight - bounds.top - 16),
      };
      setLimits(current =>
        current?.maxWidth === next.maxWidth && current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    updateLimits();
    const observer = view.ResizeObserver ? new view.ResizeObserver(updateLimits) : null;
    for (let ancestor = panel.parentElement; ancestor; ancestor = ancestor.parentElement) {
      observer?.observe(ancestor);
    }
    view.addEventListener('resize', updateLimits);
    return () => {
      observer?.disconnect();
      view.removeEventListener('resize', updateLimits);
    };
  }, [visible, ownerDocument]);
  const resizePanel = (width: number, height: number) => {
    const panel = panelRef.current;
    if (!panel) return;
    const bounds = panel.getBoundingClientRect();
    const viewport = panel.ownerDocument.documentElement;
    const maxWidth = Math.max(0, bounds.right - 16);
    const maxHeight = Math.max(0, viewport.clientHeight - bounds.top - 16);
    setSize({
      width: Math.min(maxWidth, Math.max(280, width)),
      height: Math.min(maxHeight, Math.max(160, height)),
    });
  };
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
    <h3 className="px-2 pb-1 text-xs font-medium text-secondary">{i18nService.t(key)}</h3>
  );
  return (
    <aside
      ref={panelRef}
      id="cowork-session-summary"
      role="dialog"
      aria-label={i18nService.t('coworkSummaryTitle')}
      style={{ ...(size ? { width: size.width, height: size.height } : {}), ...limits }}
      className={`session-summary-panel absolute right-0 top-full z-[90] mt-2 flex max-h-[calc(100dvh-5rem)] ${props.progress?.card.markdown?.trim() ? 'w-[26rem]' : 'w-80'} max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border shadow-popover dark:shadow-[0_16px_48px_rgba(0,0,0,0.4)]`}
    >
      <div className="session-summary-panel__header flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">
          {i18nService.t('coworkSummaryTitle')}
        </h2>
        <button
          type="button"
          aria-label={i18nService.t('close')}
          className="session-summary-panel__action flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={onClose}
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 pb-5">
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
              className="session-summary-panel__action flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-secondary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
            <h3 className="text-xs font-medium text-secondary">
              {i18nService.t('coworkSummaryOutputs')}
            </h3>
            {!props.resources?.outputs.length &&
              !props.resources?.outputsUnavailable &&
              !props.resources?.omittedOversized && (
                <span className="shrink-0 text-[11px] leading-4 text-secondary">
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
        {props.teamEnabled && props.teamEntries.length > 0 && (
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              className={`${rowClass} flex-1 py-2 text-sm`}
              aria-label={[i18nService.t('coworkSummaryAgentTeam'), teamCountLabel]
                .filter(Boolean)
                .join(' ')}
              onClick={props.onOpenTeam}
            >
              <UserGroupIcon className="h-4 w-4 shrink-0 text-secondary" />
              <span className="shrink-0">{i18nService.t('coworkSummaryAgentTeam')}</span>
              {teamCountLabel && (
                <span className="min-w-0 flex-1 text-right text-xs text-secondary tabular-nums">
                  {teamCountLabel}
                </span>
              )}
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={i18nService.t('coworkSummaryResize')}
        title={i18nService.t('coworkSummaryResize')}
        className="absolute bottom-0 left-0 h-5 w-5 touch-none cursor-nesw-resize rounded-bl-xl text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        onPointerDown={event => {
          if (event.button !== 0) return;
          const bounds = panelRef.current?.getBoundingClientRect();
          if (!bounds) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeStart.current = {
            x: event.clientX,
            y: event.clientY,
            width: bounds.width,
            height: bounds.height,
          };
        }}
        onPointerMove={event => {
          const start = resizeStart.current;
          if (!start) return;
          resizePanel(
            start.width + start.x - event.clientX,
            start.height + event.clientY - start.y,
          );
        }}
        onPointerUp={event => {
          resizeStart.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onLostPointerCapture={() => {
          resizeStart.current = null;
        }}
        onPointerCancel={() => {
          resizeStart.current = null;
        }}
        onKeyDown={event => {
          const bounds = panelRef.current?.getBoundingClientRect();
          if (!bounds || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
            return;
          event.preventDefault();
          resizePanel(
            bounds.width + (event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0),
            bounds.height + (event.key === 'ArrowDown' ? 16 : event.key === 'ArrowUp' ? -16 : 0),
          );
        }}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
        >
          <path d="M4 9v7h7M4 12l4 4" />
        </svg>
      </button>
    </aside>
  );
}
