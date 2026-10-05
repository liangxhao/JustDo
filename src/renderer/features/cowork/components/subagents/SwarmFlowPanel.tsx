import './swarmPanel.css';

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  ExclamationCircleIcon,
  MinusIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  StopIcon,
  ViewfinderCircleIcon,
} from '@heroicons/react/24/outline';
import type {
  SwarmFlowAction,
  SwarmFlowNode,
  SwarmFlowResult,
  SwarmFlowView,
} from '@shared/cowork/swarmFlow';
import { useEffect, useId, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import type { Subtask } from './subtaskPresentation';
import SwarmFlowDetailPanel from './SwarmFlowDetailPanel';
import { useSwarmGraphViewport } from './useSwarmGraphViewport';

const icons = {
  queued: ClockIcon,
  preparing: ArrowPathIcon,
  running: ArrowPathIcon,
  uncertain: ExclamationCircleIcon,
  done: CheckCircleIcon,
  failed: ExclamationCircleIcon,
  cancelled: StopIcon,
};
const flowIcons = {
  running: PlayIcon,
  paused: PauseIcon,
  blocked: ExclamationCircleIcon,
  stopping: StopIcon,
  cancelled: StopIcon,
  completed: CheckCircleIcon,
};
export function layoutFlow(nodes: SwarmFlowNode[], columns = 3) {
  const levels = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++)
    for (const node of nodes) {
      if (!levels.has(node.id) && node.deps.every(d => levels.has(d)))
        levels.set(
          node.id,
          node.deps.length ? Math.max(...node.deps.map(d => levels.get(d)!)) + 1 : 0,
        );
    }
  const rows = new Map<number, SwarmFlowNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.id) ?? nodes.length;
    const row = rows.get(level) ?? [];
    row.push(node);
    rows.set(level, row);
  }
  // Size the graph to its widest row, and center every partial row on that axis.
  const count = Math.max(
    1,
    Math.min(columns, Math.max(0, ...[...rows.values()].map(row => row.length))),
  );
  const width = count * 190 + 30;
  const points = new Map<string, { x: number; y: number }>();
  let y = 35;
  for (const [, row] of [...rows].sort(([a], [b]) => a - b)) {
    row.forEach((node, i) => {
      const rowCount = Math.min(count, row.length - Math.floor(i / count) * count);
      const left = (width - ((rowCount - 1) * 190 + 160)) / 2;
      points.set(node.id, { x: left + (i % count) * 190, y: y + Math.floor(i / count) * 132 });
    });
    y += Math.ceil(row.length / count) * 132;
  }
  return { points, height: y + 20, width, nodes };
}
export function routeFlowEdge(
  layout: ReturnType<typeof layoutFlow>,
  sourceId: string,
  targetId: string,
) {
  const source = layout.points.get(sourceId);
  const target = layout.points.get(targetId);
  if (!source || !target) return [];
  const start = { x: source.x + 80, y: source.y + 72 };
  const end = { x: target.x + 80, y: target.y };
  // Direct connections avoid boxed elbows between adjacent parallel stages.
  if (target.y - source.y <= 132) return [start, end];
  // Skip intervening rows outside the cards, including wrapped parallel rows.
  const lane = start.x <= layout.width / 2 ? 10 : layout.width - 10;
  return [
    start,
    { x: start.x, y: start.y + 12 },
    { x: lane, y: start.y + 12 },
    { x: lane, y: end.y - 14 },
    { x: end.x, y: end.y - 14 },
    end,
  ];
}

function edgePath(points: Array<{ x: number; y: number }>) {
  return points
    .map((point, index) => (index === 0 ? `M ${point.x} ${point.y}` : `L ${point.x} ${point.y}`))
    .join(' ');
}

export default function SwarmFlowPanel({
  sessionId,
  active = true,
  snapshot,
  onRefresh,
}: {
  sessionId: string;
  active?: boolean;
  tasks: readonly Subtask[];
  onOpenTask: (task: Subtask) => void;
  snapshot?: SwarmFlowResult;
  onRefresh?: () => void;
}) {
  const t = (key: string) => i18nService.t(key);
  const [flows, setFlows] = useState<SwarmFlowView[]>([]);
  const [chosen, setChosen] = useState<string>();
  const seenFlows = useRef(new Set<string>());
  const [selected, setSelected] = useState<string>();
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [revision, refresh] = useState(0);
  const viewport = useSwarmGraphViewport();
  const resetViewport = viewport.reset;
  const container = useRef<HTMLElement>(null);
  const [columns, setColumns] = useState(2);
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) =>
      setColumns(entry.contentRect.width < 560 ? 2 : 3),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const marker = useId().replace(/:/g, '');
  useEffect(() => {
    seenFlows.current = new Set();
    setFlows([]);
    setChosen(undefined);
    setSelected(undefined);
    setSelectedEdge(undefined);
    setError(false);
    resetViewport();
  }, [sessionId, resetViewport]);
  useEffect(() => {
    const discovered = flows.find(flow => !seenFlows.current.has(flow.id));
    flows.forEach(flow => seenFlows.current.add(flow.id));
    if (discovered) {
      setChosen(discovered.id);
      setSelected(undefined);
      setSelectedEdge(undefined);
      resetViewport();
    }
  }, [flows, resetViewport]);
  useEffect(() => {
    if (!active || snapshot !== undefined) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await window.electron.cowork.getSwarmFlows(sessionId);
        if (disposed) return;
        if (result.success) {
          setFlows(result.flows);
          setStale(false);
        } else setStale(true);
      } catch {
        if (!disposed) setStale(true);
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 2500);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, active, revision, snapshot]);
  useEffect(() => {
    if (snapshot === undefined) return;
    if (snapshot.success) {
      setFlows(snapshot.flows);
      setStale(false);
    } else setStale(true);
  }, [snapshot]);
  const refreshFlows = () => {
    if (onRefresh) onRefresh();
    else refresh(v => v + 1);
  };
  const flow = flows.find(f => f.id === chosen) ?? flows[0];
  const StatusIcon = flow ? flowIcons[flow.status] : ClockIcon;
  const node = flow?.nodes.find(n => n.id === selected);
  const source = flow?.nodes.find(n => n.id === selectedEdge);
  const layout = layoutFlow(flow?.nodes ?? [], columns);
  const control = async (action: SwarmFlowAction) => {
    if (!flow || busy || stale) return;
    setBusy(true);
    setError(false);
    try {
      const result = await window.electron.cowork.controlSwarmFlow(
        sessionId,
        flow.id,
        flow.revision,
        action,
      );
      setError(!result.success);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      refreshFlows();
    }
  };
  const button = (label: string, Icon: typeof PauseIcon, action: () => void, disabled = false) => (
    <button
      type="button"
      title={t(label)}
      aria-label={t(label)}
      disabled={disabled}
      onClick={action}
      className="rounded-lg p-2 text-secondary hover:bg-surface-raised disabled:opacity-40"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
  return (
    <section
      ref={container}
      className="swarm-panel flex h-full min-h-0 flex-col bg-surface text-foreground"
    >
      {node && flow ? (
        <SwarmFlowDetailPanel
          key={JSON.stringify([sessionId, flow.id, node.id, source?.id])}
          sessionId={sessionId}
          flowId={flow.id}
          node={node}
          source={source}
          active={active}
          onChanged={refreshFlows}
          onBack={() => {
            setSelected(undefined);
            setSelectedEdge(undefined);
          }}
        />
      ) : (
        <>
          <header className="swarm-flow-header shrink-0 border-b border-border">
            {flow && (
              <span
                className={`swarm-flow-status swarm-flow-status-${flow.status}`}
                title={t('flowStatus_' + flow.status)}
                role="img"
                aria-label={t('flowStatus_' + flow.status)}
              >
                {flow.status === 'running' ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className={`h-4 w-4${active ? ' swarm-spinner' : ''}`}
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="9" opacity="0.2" />
                    <path d="M12 3a9 9 0 0 1 9 9" strokeLinecap="round" />
                  </svg>
                ) : (
                  <StatusIcon className="h-4 w-4" aria-hidden="true" />
                )}
              </span>
            )}
            <div className="swarm-flow-title">
              <select
                className="swarm-flow-select"
                aria-label={t('flowHistory')}
                title={flow?.goal ?? t('flowEmptyTitle')}
                value={flow?.id ?? ''}
                onChange={e => {
                  setChosen(e.target.value);
                  resetViewport();
                  setSelected(undefined);
                  setSelectedEdge(undefined);
                }}
              >
                {!flows.length && <option value="">{t('flowEmptyTitle')}</option>}
                {flows.map(f => (
                  <option key={f.id} value={f.id}>
                    {f.goal.slice(0, 50)}
                  </option>
                ))}
              </select>
              {flows.length > 1 && (
                <ChevronDownIcon
                  className="pointer-events-none absolute right-1 top-1 h-4 w-4 text-muted"
                  aria-hidden="true"
                />
              )}
            </div>
            {button('swarmRefresh', ArrowPathIcon, refreshFlows)}
          </header>
          {stale && (
            <p role="status" className="px-3 py-2 text-xs text-amber-600">
              {t('swarmUnavailable')}
            </p>
          )}
          {!flow ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted">
              {t('flowEmpty')}
            </div>
          ) : (
            <div
              ref={viewport.ref}
              {...viewport.handlers}
              className="min-h-0 flex-1 overflow-hidden"
              style={{
                backgroundImage:
                  'radial-gradient(var(--justdo-border, #d5d8de) 1px, transparent 1px)',
                backgroundSize: '18px 18px',
                ...viewport.canvasStyle,
              }}
            >
              <svg
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                style={viewport.svgStyle}
                aria-label={t('flowGraph')}
                role="group"
              >
                <defs>
                  <marker
                    id={marker}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
                  </marker>
                </defs>
                {flow.nodes.flatMap(n =>
                  n.deps.map(dep => {
                    const from = layout.points.get(dep);
                    const to = layout.points.get(n.id);
                    if (!from || !to) return null;
                    const source = flow.nodes.find(item => item.id === dep)!;
                    const highlighted = selected === dep || selected === n.id;
                    const available = source.status === 'done';
                    const edgeState =
                      available && ['running', 'preparing'].includes(n.status)
                        ? 'running'
                        : available
                          ? 'done'
                          : 'queued';
                    return (
                      <g
                        key={dep + ':' + n.id}
                        role="button"
                        tabIndex={0}
                        aria-label={
                          t('flowHandoff') +
                          ': ' +
                          (source.kind === 'work' ? source.title : t('flowKind_' + source.kind)) +
                          ' → ' +
                          (n.kind === 'work' ? n.title : t('flowKind_' + n.kind))
                        }
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          setSelected(n.id);
                          setSelectedEdge(dep);
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelected(n.id);
                            setSelectedEdge(dep);
                          }
                        }}
                      >
                        <path
                          d={edgePath(routeFlowEdge(layout, dep, n.id))}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={16}
                          pointerEvents="stroke"
                        />
                        <path
                          d={edgePath(routeFlowEdge(layout, dep, n.id))}
                          fill="none"
                          className={`swarm-flow-edge swarm-${edgeState}`}
                          stroke="currentColor"
                          opacity={selected && !highlighted ? 0.2 : 0.65}
                          strokeWidth={highlighted ? 2.5 : 1.5}
                          strokeDasharray={available ? undefined : '5 4'}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          markerEnd={dep === n.deps[0] ? `url(#${marker})` : undefined}
                          pointerEvents="none"
                        />
                      </g>
                    );
                  }),
                )}
                {flow.nodes.map(n => {
                  const point = layout.points.get(n.id)!;
                  const Icon = icons[n.status];
                  const stateClass = ['failed', 'uncertain'].includes(n.status)
                    ? 'failed'
                    : ['running', 'preparing'].includes(n.status)
                      ? 'running'
                      : n.status === 'done'
                        ? 'done'
                        : 'queued';
                  const label = n.kind === 'work' ? n.title : t('flowKind_' + n.kind);
                  return (
                    <g
                      key={n.id}
                      className={`swarm-${stateClass}`}
                      transform={`translate(${point.x} ${point.y})`}
                      tabIndex={0}
                      role="button"
                      aria-label={label + ': ' + t('flowNode_' + n.status)}
                      onClick={() => setSelected(n.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelected(n.id);
                        }
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      <title>
                        {label +
                          ' · ' +
                          t('flowNode_' + n.status) +
                          ' · @' +
                          (n.agentName ?? n.agentId ?? 'main')}
                      </title>
                      <rect
                        width="160"
                        height="72"
                        rx={n.kind === 'verify' ? 24 : 14}
                        fill="var(--justdo-surface, white)"
                        stroke="currentColor"
                        strokeWidth={selected === n.id ? 3 : 1.3}
                      />
                      <g transform="translate(70 10)">
                        <g
                          className={
                            active && ['running', 'preparing'].includes(n.status)
                              ? 'swarm-spinner'
                              : undefined
                          }
                        >
                          <Icon width="20" height="20" />
                        </g>
                      </g>
                      <text x="80" y="47" textAnchor="middle" fill="currentColor" fontSize="12">
                        {label.length > 15 ? label.slice(0, 14) + '…' : label}
                      </text>
                      <text
                        x="80"
                        y="63"
                        textAnchor="middle"
                        fill="currentColor"
                        fontSize="10"
                        opacity="0.8"
                      >
                        {'@' + (n.agentName ?? n.agentId ?? 'main').slice(0, 20)}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
          {(flow?.error || error) && (
            <p role="status" className="px-3 py-2 text-xs text-red-600">
              {flow?.error || t('flowControlFailed')}
            </p>
          )}
          <footer className="flex shrink-0 items-center border-t border-border p-2">
            {flow && !['completed', 'cancelled'].includes(flow.status) && (
              <>
                {flow.canRetry &&
                  button('flowRetry', ArrowPathIcon, () => void control('retry'), busy || stale)}
                {flow.status === 'paused'
                  ? button('flowResume', PlayIcon, () => void control('resume'), busy || stale)
                  : button(
                      'flowPause',
                      PauseIcon,
                      () => void control('pause'),
                      busy || stale || flow.status !== 'running',
                    )}
                {button(
                  'flowStop',
                  StopIcon,
                  () => void control('stop'),
                  busy || stale || flow.status === 'stopping',
                )}
              </>
            )}
            <div className="ml-auto flex">
              {button('swarmZoomOut', MinusIcon, viewport.zoomOut)}
              {button('swarmZoomIn', PlusIcon, viewport.zoomIn)}
              {button('swarmFit', ViewfinderCircleIcon, () =>
                viewport.fit(layout.width, layout.height),
              )}
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
