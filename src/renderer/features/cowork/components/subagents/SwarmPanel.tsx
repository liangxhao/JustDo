import '../shared/swarmGraph.css';

import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  ExclamationCircleIcon,
  MinusIcon,
  PlusIcon,
  ShareIcon,
  Square3Stack3DIcon,
  StopIcon,
  ViewfinderCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { SwarmChildStatus, SwarmSnapshot } from '@shared/cowork/swarm';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import type { Subtask } from './subtaskPresentation';
import { layoutSwarmMembers, SWARM_COLLAPSE_AFTER, swarmMembers, swarmTotal } from './swarmGraph';

const ICONS = {
  queued: ClockIcon,
  running: ArrowPathIcon,
  done: CheckCircleIcon,
  failed: ExclamationCircleIcon,
};
const LABELS = {
  queued: 'swarmQueued',
  running: 'swarmRunning',
  done: 'swarmDone',
  failed: 'swarmFailed',
};
const displayStatus = (native: SwarmChildStatus, task?: Subtask) =>
  native === 'failed' && (task?.status === 'killed' || task?.status === 'timeout')
    ? task.status
    : native;
const NODE_ICONS = { ...ICONS, killed: StopIcon, timeout: ClockIcon };
const NODE_LABELS = { ...LABELS, killed: 'subtaskStatusKilled', timeout: 'subtaskStatusTimeout' };
const t = (key: string) => i18nService.t(key);
const date = (value: number) =>
  new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export function SwarmGraph({
  snapshot,
  tasks,
  parentRunning,
  onOpenTask,
  onRefresh,
  onStop,
  stale,
  loading,
}: {
  snapshot: SwarmSnapshot;
  tasks: readonly Subtask[];
  parentRunning: boolean;
  onOpenTask: (task: Subtask) => void;
  onRefresh: () => void;
  onStop?: () => boolean | void | Promise<boolean | void>;
  stale: boolean;
  loading: boolean;
}) {
  const markerId = useId().replace(/:/g, '');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [selectedKey, setSelectedKey] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [highlight, setHighlight] = useState<SwarmChildStatus>();
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(2);
  const drag = useRef<{ x: number; y: number; left: number; top: number }>();
  const stableOrder = useRef(new Map<string, number>());
  const group = snapshot.groups.find(item => item.groupId === selectedGroup) ?? snapshot.groups[0];
  const hasGroup = Boolean(group);
  useEffect(() => {
    if (!canvas.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width) setColumns(width >= 560 ? 3 : 2);
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, [hasGroup]);
  const members = useMemo(() => {
    if (!group) return [];
    const items = swarmMembers(group, tasks);
    for (const item of items)
      if (!stableOrder.current.has(item.sessionKey))
        stableOrder.current.set(item.sessionKey, stableOrder.current.size);
    return items.sort(
      (a, b) => stableOrder.current.get(a.sessionKey)! - stableOrder.current.get(b.sessionKey)!,
    );
  }, [group, tasks]);
  const shown = expanded ? members : members.slice(0, SWARM_COLLAPSE_AFTER);
  const positions = layoutSwarmMembers(
    shown.map(item => item.sessionKey),
    columns,
  );
  const selected = members.find(item => item.sessionKey === selectedKey);
  const graphWidth = columns * 180 + 40;
  const center = graphWidth / 2;
  const height = 225 + Math.ceil(shown.length / columns) * 116;
  const fit = () => {
    setZoom(1);
    canvas.current?.scrollTo?.({ top: 0, left: 0 });
  };
  const stop = async () => {
    if (!onStop || stopping) return;
    setStopping(true);
    setStopFailed(false);
    try {
      if ((await onStop()) === false) setStopFailed(true);
    } catch {
      setStopFailed(true);
    } finally {
      setStopping(false);
    }
  };
  const button = (key: string, Icon: typeof PlusIcon, action: () => void, disabled = false) => (
    <button
      type="button"
      title={t(key)}
      aria-label={t(key)}
      onClick={action}
      disabled={disabled}
      className="swarm-icon-button"
    >
      <Icon className="h-4 w-4" />
    </button>
  );

  return (
    <section className="swarm-panel" aria-label={t('swarmTitle')}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <ShareIcon className="h-4 w-4 shrink-0 text-primary" />
        <select
          aria-label={t('swarmRecent')}
          title={t('swarmRecentHint')}
          value={group?.groupId ?? ''}
          onChange={event => {
            setSelectedGroup(event.target.value);
            setSelectedKey(undefined);
            setExpanded(false);
            fit();
          }}
          className="min-w-0 flex-1 truncate bg-transparent text-xs text-foreground"
          disabled={!group}
        >
          {!group && <option value="">{t('swarmTitle')}</option>}
          {snapshot.groups.map((item, index) => (
            <option key={item.groupId} value={item.groupId}>
              {t('swarmBatch')} {snapshot.groups.length - index} · {date(item.createdAt)}
            </option>
          ))}
        </select>
        {button('swarmRefresh', ArrowPathIcon, onRefresh, loading)}
      </header>
      {stale && (
        <div role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-amber-600">
          <ExclamationCircleIcon className="h-4 w-4 shrink-0" />
          {t('swarmUnavailable')}
        </div>
      )}
      {!group ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted">
          {parentRunning ? (
            <ArrowPathIcon className="h-9 w-9 motion-safe:animate-spin" />
          ) : (
            <ShareIcon className="h-9 w-9" />
          )}
          <p className="text-sm">{t(parentRunning ? 'swarmPreparing' : 'swarmEmpty')}</p>
          {parentRunning && <p className="text-xs">{t('swarmPreparingHint')}</p>}
        </div>
      ) : (
        <>
          <div
            ref={canvas}
            className="swarm-canvas"
            onPointerDown={event => {
              if (event.button !== 0 || (event.target as Element).closest('[role="button"]'))
                return;
              const el = canvas.current!;
              drag.current = {
                x: event.clientX,
                y: event.clientY,
                left: el.scrollLeft,
                top: el.scrollTop,
              };
              el.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
              if (!drag.current || !canvas.current) return;
              canvas.current.scrollLeft = drag.current.left - event.clientX + drag.current.x;
              canvas.current.scrollTop = drag.current.top - event.clientY + drag.current.y;
            }}
            onPointerUp={() => {
              drag.current = undefined;
            }}
            onPointerCancel={() => {
              drag.current = undefined;
            }}
          >
            <div style={{ width: `${zoom * 100}%`, minWidth: 340 }}>
              <svg
                viewBox={`0 0 ${graphWidth} ${height}`}
                className="block w-full"
                aria-label={t('swarmParentHint')}
              >
                <defs>
                  <marker
                    id={markerId}
                    markerWidth="6"
                    markerHeight="6"
                    refX="5"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L6,3 L0,6" fill="currentColor" />
                  </marker>
                </defs>
                <g className="swarm-root">
                  <rect x={center - 80} y="30" width="160" height="58" rx="18" />
                  <ShareIcon x={center - 66} y="48" width="20" height="20" />
                  <text x={center - 33} y="64" fontSize="13">
                    {t('swarmParent')}
                  </text>
                  <title>{t('swarmParentHint')}</title>
                </g>
                <path
                  d={`M${center} 88 V126`}
                  className="swarm-edge"
                  markerEnd={`url(#${markerId})`}
                />
                <g className="swarm-root">
                  <rect x={center - 60} y="132" width="120" height="34" rx="17" />
                  <text x={center} y="154" textAnchor="middle" fontSize="12">
                    {t('swarmBatch')} · {swarmTotal(group)}
                  </text>
                </g>
                {positions.map(pos => (
                  <path
                    key={pos.key}
                    d={
                      pos.y === 200
                        ? `M${center} 166 V182 H${pos.x + 80} V${pos.y}`
                        : `M${center} 166 V176 H12 V${pos.y - 18} H${pos.x + 80} V${pos.y}`
                    }
                    className={`swarm-edge ${selectedKey === pos.key ? 'is-selected' : ''}`}
                    markerEnd={`url(#${markerId})`}
                  />
                ))}
                {shown.map((member, index) => {
                  const pos = positions[index];
                  const status = displayStatus(member.status, member.task);
                  const Icon = NODE_ICONS[status];
                  const label =
                    member.task?.label ?? `${t('swarmTask')} ${members.indexOf(member) + 1}`;
                  return (
                    <g
                      key={member.sessionKey}
                      role="button"
                      tabIndex={0}
                      aria-label={`${label}: ${t(NODE_LABELS[status])}`}
                      aria-pressed={selectedKey === member.sessionKey}
                      className={`swarm-node swarm-${status} ${selectedKey === member.sessionKey ? 'is-selected' : ''}`}
                      style={{ opacity: highlight && highlight !== member.status ? 0.35 : 1 }}
                      onClick={() => setSelectedKey(member.sessionKey)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedKey(member.sessionKey);
                        }
                      }}
                      onDoubleClick={() => member.task && onOpenTask(member.task)}
                    >
                      <rect x={pos.x} y={pos.y} width="160" height="86" rx="15" />
                      <g transform={`translate(${pos.x + 69} ${pos.y + 12})`}>
                        <Icon
                          width="22"
                          height="22"
                          className={member.status === 'running' ? 'swarm-spinner' : ''}
                        />
                      </g>
                      <foreignObject x={pos.x + 8} y={pos.y + 42} width="144" height="36">
                        <div className="swarm-node-label">{label}</div>
                      </foreignObject>
                      <title>
                        {label +
                          '\n' +
                          t(NODE_LABELS[status]) +
                          (member.task?.model ? '\n' + member.task.model : '')}
                      </title>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-center gap-2 px-3 text-xs text-muted">
            {members.length > SWARM_COLLAPSE_AFTER &&
              button(
                expanded ? 'swarmCollapse' : 'swarmExpand',
                expanded ? ChevronUpIcon : ChevronDownIcon,
                () => setExpanded(!expanded),
              )}
            {shown.length < swarmTotal(group) && (
              <span>
                {t('swarmPartial')
                  .replace('{shown}', String(shown.length))
                  .replace('{total}', String(swarmTotal(group)))}
              </span>
            )}
            {snapshot.otherActiveGroups > 0 && (
              <span
                title={t('swarmMoreGroups').replace('{count}', String(snapshot.otherActiveGroups))}
              >
                +{snapshot.otherActiveGroups}
              </span>
            )}
          </div>
          {selected && (
            <div className="swarm-detail">
              <div className="flex items-center gap-2">
                <Square3Stack3DIcon className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {selected.task?.label ?? t('swarmNoDetail')}
                </span>
                {selected.task &&
                  button('swarmProcess', ArrowTopRightOnSquareIcon, () =>
                    onOpenTask(selected.task!),
                  )}
                {button('swarmCloseDetail', XMarkIcon, () => setSelectedKey(undefined))}
              </div>
              <div className="mt-2 flex gap-3 text-xs text-muted">
                <span>{t(NODE_LABELS[displayStatus(selected.status, selected.task)])}</span>
                <span className="truncate">{selected.task?.model}</span>
              </div>
              {selected.task?.error && (
                <p className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-red-600">
                  {selected.task.error}
                </p>
              )}
            </div>
          )}
        </>
      )}
      {stopFailed && (
        <p role="status" className="px-3 py-2 text-xs text-red-600">
          {t('swarmStopFailed')}
        </p>
      )}
      <footer className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border px-2 py-2">
        {group &&
          (Object.keys(ICONS) as SwarmChildStatus[]).map(status => {
            const Icon = ICONS[status];
            return (
              <button
                type="button"
                key={status}
                title={t(LABELS[status])}
                aria-label={`${t(LABELS[status])}: ${group[status]}`}
                className={`swarm-count swarm-${status}`}
                aria-pressed={highlight === status}
                onClick={() => setHighlight(current => (current === status ? undefined : status))}
              >
                <Icon className="h-4 w-4" />
                {group[status]}
              </button>
            );
          })}
        <div className="ml-auto flex">
          {button('swarmZoomOut', MinusIcon, () => setZoom(value => Math.max(0.6, value - 0.2)))}
          {button('swarmZoomIn', PlusIcon, () => setZoom(value => Math.min(2.5, value + 0.2)))}
          {button('swarmFit', ViewfinderCircleIcon, fit)}
          {onStop &&
            button(
              stopping ? 'swarmStopping' : 'swarmStop',
              stopping ? ArrowPathIcon : StopIcon,
              () => {
                void stop();
              },
              !parentRunning || stopping,
            )}
        </div>
      </footer>
    </section>
  );
}

export default function SwarmPanel({
  sessionId,
  tasks,
  parentRunning,
  onOpenTask,
  onStop,
  active = true,
}: {
  sessionId: string;
  tasks: readonly Subtask[];
  parentRunning: boolean;
  active?: boolean;
  onOpenTask: (task: Subtask) => void;
  onStop?: () => boolean | void | Promise<boolean | void>;
}) {
  const [snapshot, setSnapshot] = useState<SwarmSnapshot>({ groups: [], otherActiveGroups: 0 });
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      setLoading(true);
      try {
        const result = await window.electron.cowork.getSwarmSnapshot(sessionId);
        if (disposed) return;
        if (result.success) {
          setSnapshot(result.snapshot);
          setStale(false);
        } else setStale(true);
      } catch {
        if (!disposed) setStale(true);
      } finally {
        if (!disposed) {
          setLoading(false);
          timer = setTimeout(() => void read(), parentRunning ? 2500 : 10000);
        }
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, parentRunning, revision, active]);
  return (
    <SwarmGraph
      snapshot={snapshot}
      tasks={tasks}
      parentRunning={parentRunning}
      stale={stale}
      loading={loading}
      onRefresh={() => setRevision(value => value + 1)}
      onOpenTask={onOpenTask}
      onStop={onStop}
    />
  );
}
