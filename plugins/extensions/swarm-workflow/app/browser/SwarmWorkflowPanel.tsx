import { edgePath, layoutFlow, routeFlowEdge } from '../../browser/graph/layout';
import { useWorkflowVisibility } from '../../browser/visibility';
import { useSwarmWorkflowPanelState } from './workflowBrowserState';
export { layoutFlow, routeFlowEdge } from '../../browser/graph/layout';
import './swarmGraph.css';
import './swarmWorkflow.css';

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  MinusIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ShareIcon,
  StopIcon,
  ViewfinderCircleIcon,
} from '@heroicons/react/24/outline';
import type { SwarmWorkflowResult } from '../../contracts/workflow';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { i18nService } from './ui';
import { useOwnerWindow } from './ui';

import SwarmWorkflowBatchPanel from './SwarmWorkflowBatchPanel';
import SwarmWorkflowDetailPanel from './SwarmWorkflowDetailPanel';
import { useSwarmWorkflowGraphViewport } from './useSwarmWorkflowGraphViewport';

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
export default function SwarmWorkflowPanel({
  sessionId,
  active = true,
  snapshot,
  onRefresh,
}: {
  sessionId: string;
  active?: boolean;
  snapshot?: SwarmWorkflowResult;
  onRefresh?: () => void;
}) {
  const ownerWindow = useOwnerWindow();
  const visible = useWorkflowVisibility(ownerWindow.document);
  active = active && visible;
  const t = (key: string) => i18nService.t(key);
  const {
    flows,
    flow,
    node,
    source,
    selected,
    stale,
    busy,
    error,
    actions,
    control,
    refreshFlows,
    selectFlow,
    setSelected,
    setSelectedEdge,
  } = useSwarmWorkflowPanelState({
    sessionId,
    active,
    snapshot,
    onRefresh,
  });
  const container = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLElement>(null);
  const [columns, setColumns] = useState(2);
  useEffect(() => {
    if (!container.current || !ownerWindow.ResizeObserver) return;
    const observer = new ownerWindow.ResizeObserver(([entry]) =>
      setColumns(entry.contentRect.width < 560 ? 2 : 3),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [ownerWindow]);
  const marker = useId().replace(/:/g, '');
  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    if (!active || !tabs) return;
    const revealSelectedTab = () => {
      const selected = tabs.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (!selected) return;
      const bounds = tabs.getBoundingClientRect();
      const selectedBounds = selected.getBoundingClientRect();
      if (!bounds.width || !selectedBounds.width) return;
      if (selectedBounds.left < bounds.left + 12) {
        tabs.scrollLeft -= bounds.left + 12 - selectedBounds.left;
      } else if (selectedBounds.right > bounds.right - 12) {
        tabs.scrollLeft += selectedBounds.right - bounds.right + 12;
      }
    };
    revealSelectedTab();
    if (!ownerWindow.ResizeObserver) return;
    const observer = new ownerWindow.ResizeObserver(revealSelectedTab);
    observer.observe(tabs);
    return () => observer.disconnect();
  }, [active, flow?.id, flows.length, ownerWindow]);
  const StatusIcon = flow ? flowIcons[flow.status] : ClockIcon;
  const layout = layoutFlow(flow?.nodes ?? [], columns);
  const viewport = useSwarmWorkflowGraphViewport({
    key: JSON.stringify([sessionId, flow?.id]),
    width: layout.width,
    height: layout.height,
    active,
  });
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
      {flows.length > 0 && (
        <nav
          ref={tabsRef}
          className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border-subtle bg-background px-3"
          aria-label={t('swarmWorkflowHistory')}
        >
          {flows.map(item => (
            <button
              key={item.id}
              type="button"
              title={item.goal}
              className="inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-[13px] font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary aria-pressed:border-border-input aria-pressed:bg-primary-muted aria-pressed:text-primary"
              aria-pressed={flow?.id === item.id}
              onClick={() => {
                selectFlow(item.id);
              }}
            >
              <ShareIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{item.goal}</span>
            </button>
          ))}
        </nav>
      )}
      {node?.kind === 'batch' && !source && flow ? (
        <SwarmWorkflowBatchPanel
          key={JSON.stringify([sessionId, flow.id, node.id])}
          sessionId={sessionId}
          flow={flow}
          stage={node}
          active={active}
          onBack={() => {
            setSelected(undefined);
            setSelectedEdge(undefined);
          }}
          onChanged={refreshFlows}
        />
      ) : node && flow ? (
        <SwarmWorkflowDetailPanel
          key={JSON.stringify([sessionId, flow.id, node.id, source?.id])}
          sessionId={sessionId}
          flowId={flow.id}
          revision={flow.revision}
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
          <header className="swarm-workflow-header shrink-0 border-b border-border">
            {flow && (
              <span
                className={`swarm-workflow-status swarm-workflow-status-${flow.status}`}
                title={t('swarmWorkflowStatus_' + flow.status)}
                role="img"
                aria-label={t('swarmWorkflowStatus_' + flow.status)}
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
            <div className="swarm-workflow-title" title={flow?.goal ?? t('swarmWorkflowTitle')}>
              {flow?.goal ?? t('swarmWorkflowTitle')}
            </div>
            {button('swarmWorkflowRefresh', ArrowPathIcon, refreshFlows)}
          </header>
          {stale && (
            <p role="status" className="px-3 py-2 text-xs text-amber-600">
              {t('swarmWorkflowUnavailable')}
            </p>
          )}
          {!flow ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted">
              {t('swarmWorkflowEmpty')}
            </div>
          ) : (
            <div
              ref={viewport.ref}
              {...viewport.handlers}
              className="min-h-0 flex-1 overflow-hidden"
              style={viewport.canvasStyle}
            >
              <svg
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                style={viewport.svgStyle}
                aria-label={t('swarmWorkflowGraph')}
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
                          t('swarmWorkflowHandoff') +
                          ': ' +
                          (source.kind === 'work'
                            ? source.title
                            : t('swarmWorkflowKind_' + source.kind)) +
                          ' → ' +
                          (n.kind === 'work' ? n.title : t('swarmWorkflowKind_' + n.kind))
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
                          className={`swarm-workflow-edge swarm-${edgeState}`}
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
                  const label = ['work', 'batch'].includes(n.kind)
                    ? n.title
                    : t('swarmWorkflowKind_' + n.kind);
                  return (
                    <g
                      key={n.id}
                      className={`swarm-${stateClass}`}
                      transform={`translate(${point.x} ${point.y})`}
                      tabIndex={0}
                      role="button"
                      aria-label={label + ': ' + t('swarmWorkflowNode_' + n.status)}
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
                          t('swarmWorkflowNode_' + n.status) +
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
                        {n.kind === 'batch'
                          ? `${n.batchCounts?.done ?? 0} / ${n.batchCounts?.total ?? '…'} · @${(n.agentName ?? n.agentId ?? 'main').slice(0, 12)}`
                          : '@' + (n.agentName ?? n.agentId ?? 'main').slice(0, 20)}
                      </text>
                      {n.kind === 'batch' && n.batchCounts?.total && (
                        <rect
                          x="14"
                          y="69"
                          width={(132 * n.batchCounts.done) / n.batchCounts.total}
                          height="2"
                          rx="1"
                          fill="currentColor"
                        />
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
          {(flow?.error || error) && (
            <p role="status" className="px-3 py-2 text-xs text-red-600">
              {flow?.error || t('swarmWorkflowControlFailed')}
            </p>
          )}
          <footer className="flex shrink-0 items-center border-t border-border p-2">
            {flow && !['completed', 'cancelled'].includes(flow.status) && (
              <>
                {actions.retry &&
                  button(
                    'swarmWorkflowRetry',
                    ArrowPathIcon,
                    () => void control('retry'),
                    busy || stale,
                  )}
                {flow.status === 'paused'
                  ? button(
                      'swarmWorkflowResume',
                      PlayIcon,
                      () => void control('resume'),
                      busy || stale || !actions.resume,
                    )
                  : button(
                      'swarmWorkflowPause',
                      PauseIcon,
                      () => void control('pause'),
                      busy || stale || !actions.pause,
                    )}
                {button(
                  'swarmWorkflowStop',
                  StopIcon,
                  () => void control('stop'),
                  busy || stale || !actions.stop,
                )}
              </>
            )}
            <div className="ml-auto flex">
              {button('swarmWorkflowZoomOut', MinusIcon, viewport.zoomOut)}
              {button('swarmWorkflowZoomIn', PlusIcon, viewport.zoomIn)}
              {button('swarmWorkflowFit', ViewfinderCircleIcon, () =>
                viewport.fit(layout.width, layout.height),
              )}
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
