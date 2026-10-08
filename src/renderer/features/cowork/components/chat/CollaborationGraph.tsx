import {
  ArrowUpRightIcon,
  ArrowUturnLeftIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import {
  buildCollaborationEdges,
  COLLABORATION_MESSAGE_BUDGET,
  type CollaborationDelivery,
  type CollaborationRoom,
} from '@shared/cowork/collaboration';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown';
import { normalizeMessage } from '@/libs/openclaw-chat/pipeline/message-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';
import { useOwnerWindow } from '@/shared/dom/ownerDocument';

import { COLLABORATION_PALETTE as PALETTE } from './collaborationPalette';

const STATE_LABELS = {
  queued: 'collaborationQueued',
  dispatching: 'collaborationDispatching',
  accepted: 'collaborationAccepted',
  unknown: 'collaborationUnknown',
  failed: 'collaborationFailed',
} as const;

const VIRTUALIZE_AFTER = 40;
const STATE_ICONS = {
  queued: ClockIcon,
  dispatching: PaperAirplaneIcon,
  accepted: CheckCircleIcon,
  unknown: ExclamationCircleIcon,
  failed: XCircleIcon,
};

function canLoadMessageBody(delivery: CollaborationDelivery): boolean {
  return delivery.state === 'accepted' || (delivery.state === 'unknown' && !!delivery.runId);
}

export function collaborationReceiptKey(deliveries: readonly CollaborationDelivery[]): string {
  return deliveries
    .filter(canLoadMessageBody)
    .map(delivery => `${delivery.id}:${delivery.runId ?? ''}:${delivery.from}:${delivery.to}`)
    .join('|');
}

// Wrap by approximate glyph width so Chinese and Latin names both fit the node.
function nodeLines(name: string): string[] {
  const lines: string[] = [];
  let line = '';
  let width = 0;
  for (const char of Array.from(name)) {
    const size = /[^\x00-\x7f]/.test(char) ? 1 : 0.55;
    if (width + size > 5) {
      lines.push(line);
      line = '';
      width = 0;
    }
    line += char;
    width += size;
  }
  if (line) lines.push(line);
  return lines.length > 3
    ? [...lines.slice(0, 2), `${Array.from(lines[2]).slice(0, -1).join('')}…`]
    : lines;
}

export function renderCollaborationMessageMarkdown(content: string): string {
  return toSanitizedMarkdownHtml(content);
}

function CollaborationMessageMarkdown({ content }: { content: string }) {
  const html = useMemo(() => renderCollaborationMessageMarkdown(content), [content]);
  return (
    <div
      className="prose prose-sm block max-w-none break-words text-left text-foreground dark:prose-invert prose-a:text-primary prose-code:break-words prose-p:my-0 prose-pre:my-1 prose-pre:overflow-auto prose-pre:rounded-lg prose-pre:bg-background prose-pre:text-xs"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function formatCollaborationTimestamp(date: Date): string {
  return date.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function readCollaborationMessage(
  raw: GatewayMessage,
  receiptId: string,
  sourceSessionKey: string,
): string | undefined {
  const provenance = raw.provenance as Record<string, unknown> | undefined;
  if (
    ![receiptId, `${receiptId}:user`].includes(String(raw.idempotencyKey)) ||
    provenance?.kind !== 'inter_session' ||
    !['collaboration_send', 'sessions_send'].includes(String(provenance.sourceTool)) ||
    provenance.sourceSessionKey !== sourceSessionKey
  )
    return undefined;
  return normalizeMessage(raw)
    .content.filter(item => item.type === 'text' && 'text' in item && !!item.text)
    .map(item => ('text' in item ? item.text : '') ?? '')
    .join('\n')
    .trim();
}

interface CollaborationGraphProps {
  room: CollaborationRoom;
  deliveries: readonly CollaborationDelivery[];
  names: Readonly<Record<string, string>>;
  statuses?: Readonly<Record<string, string>>;
  onSelectMember: (sessionId: string) => void;
  onSelectMessage?: (delivery: CollaborationDelivery) => void;
  messageTextCache?: Map<string, string>;
}

/** Receives routing metadata only; native history supplies message content on navigation. */
export default function CollaborationGraph(props: CollaborationGraphProps) {
  return <CollaborationGraphContent key={props.room.id} {...props} />;
}

function CollaborationGraphContent({
  room,
  deliveries,
  names,
  statuses = {},
  onSelectMember,
  onSelectMessage,
  messageTextCache,
}: CollaborationGraphProps) {
  const ownerWindow = useOwnerWindow();
  const containerRef = useRef<HTMLElement>(null);
  const [timelineSize, setTimelineSize] = useState(35);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const dividerDrag = useRef<{ id: number; y: number; size: number; moved: boolean }>();
  const timelineId = useId();
  const resizeTimeline = (size: number) => setTimelineSize(Math.max(15, Math.min(70, size)));
  const svgRef = useRef<SVGSVGElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [focusedGraphItem, setFocusedGraphItem] = useState<string>();
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean }>();
  const suppressClick = useRef(false);
  const denseGraph = room.members.length > 6;
  const height = room.members.length === 2 ? 210 : denseGraph ? 420 : 350;
  const nodeRadius = denseGraph ? 28 : 34;
  useEffect(() => {
    setViewport({ x: 0, y: 0, scale: 1 });
    drag.current = undefined;
    suppressClick.current = false;
  }, [room.id]);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // SVG uses centered aspect-ratio fitting; include the extra canvas space.
      const fit = Math.min(rect.width / 500, rect.height / height);
      const x = (event.clientX - rect.left - (rect.width - 500 * fit) / 2) / fit;
      const y = (event.clientY - rect.top - (rect.height - height * fit) / 2) / fit;
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      setViewport(current => {
        const scale = Math.min(3, Math.max(0.5, current.scale * Math.exp(-delta * 0.002)));
        const ratio = scale / current.scale;
        return { scale, x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio };
      });
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  }, [height]);
  const markerId = useId().replace(/:/g, '');
  const [selection, setSelection] = useState<{
    roomId: string;
    left: string;
    right: string;
  }>();
  const edges = useMemo(() => buildCollaborationEdges(room, deliveries), [room, deliveries]);
  const positions = useMemo(() => {
    if (room.members.length === 2)
      return new Map(
        room.members.map((member, index) => [
          member.agentId,
          { x: index === 0 ? 125 : 375, y: 110 },
        ]),
      );
    if (room.members.length <= 6)
      return new Map(
        room.members.map((member, index) => {
          const angle = -Math.PI / 2 + (index * 2 * Math.PI) / room.members.length;
          return [
            member.agentId,
            { x: 250 + Math.cos(angle) * 132, y: 165 + Math.sin(angle) * 92 },
          ];
        }),
      );
    const anchorIndex = Math.max(
      0,
      room.members.findIndex(member => member.sessionId === room.anchorSessionId),
    );
    const anchor = room.members[anchorIndex];
    const peers = room.members.filter((_, index) => index !== anchorIndex);
    return new Map([
      [anchor.agentId, { x: 250, y: 195 }],
      ...peers.map((member, index) => {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / peers.length;
        return [
          member.agentId,
          { x: 250 + Math.cos(angle) * 195, y: 195 + Math.sin(angle) * 145 },
        ] as const;
      }),
    ]);
  }, [room.anchorSessionId, room.members]);
  const selectedPair = selection?.roomId === room.id ? selection : undefined;
  const belongsToSelectedPair = (from: string, to: string) =>
    !!selectedPair &&
    ((from === selectedPair.left && to === selectedPair.right) ||
      (from === selectedPair.right && to === selectedPair.left));
  const unfilteredVisible = edges
    .filter(edge => !selectedPair || belongsToSelectedPair(edge.from, edge.to))
    .flatMap(edge => edge.deliveries)
    .sort((a, b) =>
      selectedPair
        ? a.createdAt - b.createdAt || a.id.localeCompare(b.id)
        : b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
  const [searchQuery, setSearchQuery] = useState('');
  const [messageTexts, setMessageTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(messageTextCache ?? []),
  );
  const [messageLoadStates, setMessageLoadStates] = useState<
    Record<string, 'loading' | 'loaded' | 'unavailable'>
  >({});
  const [messageRetry, setMessageRetry] = useState(0);
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const visible = useMemo(
    () =>
      normalizedSearch
        ? unfilteredVisible.filter(delivery =>
            [
              names[delivery.from] || delivery.from,
              names[delivery.to] || delivery.to,
              messageTexts[delivery.id] || '',
            ].some(value => value.toLocaleLowerCase().includes(normalizedSearch)),
          )
        : unfilteredVisible,
    [messageTexts, names, normalizedSearch, unfilteredVisible],
  );
  const needsBodies = !!selectedPair || !!normalizedSearch;
  const selectedDeliveryKey =
    selectedPair || normalizedSearch ? collaborationReceiptKey(unfilteredVisible) : '';
  useEffect(() => {
    const loadable = unfilteredVisible.filter(canLoadMessageBody);
    setMessageLoadStates(
      Object.fromEntries(
        loadable.map(
          delivery =>
            [
              delivery.id,
              messageTextCache?.has(delivery.id) || messageTexts[delivery.id]
                ? 'loaded'
                : 'loading',
            ] as const,
        ),
      ),
    );
    if (!selectedPair && !normalizedSearch) return;
    const missing = loadable.filter(
      delivery => !messageTextCache?.has(delivery.id) && !messageTexts[delivery.id],
    );
    if (!missing.length) return;
    if (!window.electron?.collaboration?.readMessages) {
      setMessageLoadStates(
        Object.fromEntries(missing.map(delivery => [delivery.id, 'unavailable'] as const)),
      );
      return;
    }
    let disposed = false;
    const batches = Array.from(
      { length: Math.ceil(missing.length / COLLABORATION_MESSAGE_BUDGET) },
      (_, index) =>
        missing.slice(
          index * COLLABORATION_MESSAGE_BUDGET,
          index * COLLABORATION_MESSAGE_BUDGET + COLLABORATION_MESSAGE_BUDGET,
        ),
    );
    void (async () => {
      for (const batch of batches) {
        if (disposed) return;
        const additions: Record<string, string> = {};
        const resolutions: Record<string, 'loaded' | 'unavailable'> = Object.fromEntries(
          batch.map(delivery => [delivery.id, 'unavailable'] as const),
        );
        try {
          const result = await window.electron.collaboration.readMessages(
            room.anchorSessionId,
            batch.map(delivery => delivery.id),
          );
          if (disposed) return;
          if (result.success) {
            for (const item of result.value) {
              const delivery = batch.find(candidate => candidate.id === item.deliveryId);
              const source = delivery
                ? room.members.find(member => member.agentId === delivery.from)
                : undefined;
              if (!delivery || !source || !item.message || typeof item.message !== 'object')
                continue;
              const text = readCollaborationMessage(
                item.message as GatewayMessage,
                delivery.runId || delivery.id,
                source.sessionKey,
              );
              if (!text) continue;
              additions[delivery.id] = text;
              resolutions[delivery.id] = 'loaded';
              messageTextCache?.set(delivery.id, text);
            }
          }
        } catch {
          // A failed batch must not discard successful lookups or stop later batches.
        }
        if (disposed) return;
        if (Object.keys(additions).length)
          setMessageTexts(current => ({ ...current, ...additions }));
        setMessageLoadStates(current => ({ ...current, ...resolutions }));
      }
    })();
    return () => {
      disposed = true;
    };
    // The compact key changes only when the selected receipts change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    room.id,
    selectedPair?.left,
    selectedPair?.right,
    selectedDeliveryKey,
    needsBodies,
    messageRetry,
  ]);
  const virtualized = visible.length > VIRTUALIZE_AFTER;
  const virtualizer = useVirtualizer({
    count: virtualized ? visible.length : 0,
    getScrollElement: () => timelineScrollRef.current,
    getItemKey: index => `${selectedPair ? 'conversation' : 'timeline'}:${visible[index].id}`,
    estimateSize: () => (selectedPair ? 92 : 40),
    initialRect: { width: 500, height: 300 },
    observeElementRect: (instance, callback) => {
      const element = instance.scrollElement;
      if (!element) return;
      const update = () => {
        const rect = element.getBoundingClientRect();
        callback({ width: rect.width || 500, height: rect.height || 300 });
      };
      update();
      if (!ownerWindow.ResizeObserver) return;
      const observer = new ownerWindow.ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    },
    overscan: 8,
  });
  const deliveryRows = virtualized
    ? virtualizer.getVirtualItems().map(item => ({ delivery: visible[item.index], item }))
    : visible.map(delivery => ({ delivery, item: undefined }));
  const name = (id: string) => names[id] || id;
  const palette = (id: string) =>
    PALETTE[
      Math.max(
        0,
        room.members.findIndex(member => member.agentId === id),
      ) % PALETTE.length
    ];

  return (
    <section
      aria-label={i18nService.t('collaborationGraph')}
      ref={containerRef}
      className="flex h-full min-h-0 flex-col p-3"
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 500 ${height}`}
          style={{ touchAction: 'none', height: '100%' }}
          onDoubleClick={event => {
            if (!(event.target as Element).closest('[role="button"]'))
              setViewport({ x: 0, y: 0, scale: 1 });
          }}
          tabIndex={0}
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            if (event.key === '0') {
              event.preventDefault();
              setViewport({ x: 0, y: 0, scale: 1 });
            } else if (event.key === '+' || event.key === '=') {
              event.preventDefault();
              setViewport(current => ({ ...current, scale: Math.min(3, current.scale * 1.2) }));
            } else if (event.key === '-' || event.key === '_') {
              event.preventDefault();
              setViewport(current => ({ ...current, scale: Math.max(0.5, current.scale / 1.2) }));
            }
          }}
          onPointerDown={event => {
            if (event.button !== 0) return;
            suppressClick.current = false;
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              moved: false,
            };
          }}
          onPointerMove={event => {
            const current = drag.current;
            if (!current || current.id !== event.pointerId) return;
            const dx = event.clientX - current.x;
            const dy = event.clientY - current.y;
            if (!current.moved && Math.hypot(dx, dy) < 4) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            current.moved = true;
            suppressClick.current = true;
            current.x = event.clientX;
            current.y = event.clientY;
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width && rect.height) {
              const fit = Math.min(rect.width / 500, rect.height / height);
              setViewport(view => ({
                ...view,
                x: view.x + dx / fit,
                y: view.y + dy / fit,
              }));
            }
          }}
          onPointerUp={() => {
            drag.current = undefined;
          }}
          onPointerCancel={() => {
            drag.current = undefined;
          }}
          onLostPointerCapture={() => {
            drag.current = undefined;
          }}
          onPointerLeave={() => {
            if (!drag.current?.moved) drag.current = undefined;
          }}
          onClickCapture={event => {
            if (suppressClick.current && event.detail !== 0) {
              event.stopPropagation();
              suppressClick.current = false;
            }
          }}
          className="block w-full overflow-hidden select-none cursor-grab active:cursor-grabbing"
          aria-label={i18nService.t('collaborationGraph')}
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
            {edges.map(edge => {
              const focusKey = `edge:${edge.from}:${edge.to}`;
              const source = positions.get(edge.from)!;
              const target = positions.get(edge.to)!;
              const dx = target.x - source.x;
              const dy = target.y - source.y;
              const length = Math.hypot(dx, dy);
              const ux = dx / length;
              const uy = dy / length;
              const start = {
                x: source.x + ux * (nodeRadius + 4),
                y: source.y + uy * (nodeRadius + 4),
              };
              const end = {
                x: target.x - ux * (nodeRadius + 8),
                y: target.y - uy * (nodeRadius + 8),
              };
              const control = {
                x: (source.x + target.x) / 2 - uy * 32,
                y: (source.y + target.y) / 2 + ux * 32,
              };
              const curve = `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
              const label = `${name(edge.from)} → ${name(edge.to)} (${edge.deliveries.length})`;
              const fromIndex = room.members.findIndex(member => member.agentId === edge.from);
              const toIndex = room.members.findIndex(member => member.agentId === edge.to);
              const pair =
                fromIndex < toIndex
                  ? { left: edge.from, right: edge.to }
                  : { left: edge.to, right: edge.from };
              const pairSelected = belongsToSelectedPair(edge.from, edge.to);
              const select = () => {
                setTimelineCollapsed(false);
                setSelection(current =>
                  current?.roomId === room.id &&
                  current.left === pair.left &&
                  current.right === pair.right
                    ? undefined
                    : { roomId: room.id, ...pair },
                );
              };
              const color = palette(edge.from).stroke;
              return (
                <g
                  key={`${edge.from}:${edge.to}`}
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  aria-pressed={pairSelected}
                  aria-controls={timelineId}
                  onFocus={() => setFocusedGraphItem(focusKey)}
                  onBlur={() =>
                    setFocusedGraphItem(current => (current === focusKey ? undefined : current))
                  }
                  onClick={select}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      select();
                    }
                  }}
                  className="cursor-pointer outline-none transition-opacity duration-150"
                  opacity={selectedPair && !pairSelected ? 0.2 : 1}
                >
                  <title>{label}</title>
                  <path d={curve} fill="none" stroke="transparent" strokeWidth="18" />
                  {focusedGraphItem === focusKey && (
                    <path
                      d={curve}
                      fill="none"
                      stroke={color}
                      strokeWidth="9"
                      strokeOpacity="0.22"
                    />
                  )}
                  <path
                    d={curve}
                    fill="none"
                    stroke={color}
                    strokeWidth={pairSelected ? 3.5 : 2}
                    strokeDasharray={edge.accepted ? undefined : '5 4'}
                    markerEnd={`url(#${markerId})`}
                  />
                  <text
                    x={(start.x + 2 * control.x + end.x) / 4}
                    y={(start.y + 2 * control.y + end.y) / 4 - 5}
                    textAnchor="middle"
                    fontSize="12"
                    fill={color}
                  >
                    {edge.deliveries.length}
                  </text>
                </g>
              );
            })}
            {room.members.map(member => {
              const focusKey = `member:${member.agentId}`;
              const position = positions.get(member.agentId)!;
              const colors = palette(member.agentId);
              const lines = nodeLines(name(member.agentId));
              const labelAbove = room.members.length > 2 && position.y < 165;
              return (
                <g
                  key={member.agentId}
                  role="button"
                  tabIndex={0}
                  aria-label={name(member.agentId)}
                  onFocus={() => setFocusedGraphItem(focusKey)}
                  onBlur={() =>
                    setFocusedGraphItem(current => (current === focusKey ? undefined : current))
                  }
                  onClick={() => onSelectMember(member.sessionId)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectMember(member.sessionId);
                    }
                  }}
                  className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <title>{name(member.agentId)}</title>
                  {focusedGraphItem === focusKey && (
                    <circle
                      cx={position.x}
                      cy={position.y}
                      r={nodeRadius + 6}
                      fill="none"
                      stroke={colors.stroke}
                      strokeWidth="4"
                      strokeOpacity="0.24"
                    />
                  )}
                  <circle
                    cx={position.x}
                    cy={position.y}
                    r={nodeRadius}
                    stroke={colors.stroke}
                    strokeWidth="1.5"
                    className={colors.fill}
                  />
                  <text
                    x={position.x}
                    y={position.y - ((lines.length - 1) * 13) / 2 + 4}
                    textAnchor="middle"
                    fontSize={
                      denseGraph ? (lines.length > 1 ? 8.5 : 9.5) : lines.length > 1 ? 10 : 11
                    }
                    fontWeight="600"
                    className={colors.text}
                  >
                    {lines.map((line, index) => (
                      <tspan key={index} x={position.x} dy={index === 0 ? 0 : 13}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                  {statuses[member.sessionId] && (
                    <text
                      x={position.x}
                      y={position.y + (labelAbove ? -46 : 52)}
                      textAnchor="middle"
                      fontSize="11"
                      className="fill-slate-500 dark:fill-slate-400"
                    >
                      {statuses[member.sessionId]}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label={i18nService.t('collaborationTimelineResize')}
        aria-controls={timelineId}
        aria-valuemin={0}
        aria-valuemax={70}
        aria-valuenow={timelineCollapsed ? 0 : timelineSize}
        title={i18nService.t('collaborationTimelineResize')}
        style={{ touchAction: 'none' }}
        className="flex h-7 shrink-0 cursor-row-resize select-none items-center justify-center gap-2 border-t border-border text-xs text-secondary hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dividerDrag.current = {
            id: event.pointerId,
            y: event.clientY,
            size: timelineCollapsed ? 0 : timelineSize,
            moved: false,
          };
        }}
        onPointerMove={event => {
          const current = dividerDrag.current;
          const bounds = containerRef.current?.getBoundingClientRect();
          if (!current || current.id !== event.pointerId || !bounds?.height) return;
          const delta = event.clientY - current.y;
          if (!current.moved && Math.abs(delta) < 4) return;
          current.moved = true;
          const size = current.size - (delta / bounds.height) * 100;
          setTimelineCollapsed(size < 8);
          resizeTimeline(size);
        }}
        onPointerUp={event => {
          const current = dividerDrag.current;
          if (current?.id !== event.pointerId) return;
          if (!current.moved) setTimelineCollapsed(value => !value);
          dividerDrag.current = undefined;
        }}
        onPointerCancel={() => {
          dividerDrag.current = undefined;
        }}
        onLostPointerCapture={() => {
          dividerDrag.current = undefined;
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setTimelineCollapsed(value => !value);
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            setTimelineCollapsed(false);
            resizeTimeline(
              (timelineCollapsed ? 0 : timelineSize) + (event.key === 'ArrowUp' ? 5 : -5),
            );
          }
        }}
      >
        <span aria-hidden="true">{timelineCollapsed ? '▴' : '▾'}</span>
        {timelineCollapsed ? (
          i18nService.t('collaborationTimeline')
        ) : (
          <span aria-hidden="true" className="h-1 w-8 rounded-full bg-current opacity-40" />
        )}
      </div>
      <div
        id={timelineId}
        hidden={timelineCollapsed}
        className="flex min-h-0 shrink-0 flex-col"
        style={{
          height: timelineCollapsed ? 0 : `${timelineSize}%`,
          display: timelineCollapsed ? 'none' : undefined,
        }}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 pb-2">
          <h3 className="col-start-2 min-w-0 truncate text-center text-xs font-medium text-secondary">
            {selectedPair
              ? i18nService
                  .t('collaborationConversation')
                  .replace('{left}', name(selectedPair.left))
                  .replace('{right}', name(selectedPair.right))
              : i18nService.t('collaborationTimeline')}
          </h3>
          {selectedPair && (
            <button
              type="button"
              onClick={() => setSelection(undefined)}
              className="col-start-3 justify-self-end text-xs text-primary"
            >
              {i18nService.t('collaborationShowAll')}
            </button>
          )}
        </div>
        {needsBodies &&
          unfilteredVisible.some(delivery => messageLoadStates[delivery.id] === 'unavailable') && (
            <button
              type="button"
              className="mb-2 self-start text-xs text-primary disabled:opacity-50"
              disabled={unfilteredVisible.some(
                delivery => messageLoadStates[delivery.id] === 'loading',
              )}
              onClick={() => setMessageRetry(value => value + 1)}
            >
              {i18nService.t('sessionDetailsRetry')}
            </button>
          )}
        {unfilteredVisible.length > 0 && (
          <label className="relative mb-2 block">
            <MagnifyingGlassIcon
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-secondary"
              aria-hidden="true"
            />
            <span className="sr-only">{i18nService.t('collaborationSearch')}</span>
            <input
              type="search"
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder={i18nService.t('collaborationSearch')}
              className="h-7 w-full rounded-md border border-border bg-background py-1 pl-7 pr-2 text-xs text-foreground outline-none placeholder:text-secondary focus:border-primary"
            />
          </label>
        )}
        <div ref={timelineScrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="text-sm text-slate-500">{i18nService.t('collaborationNoMessages')}</p>
          ) : selectedPair ? (
            <div className="min-w-0">
              <ol
                className={`min-w-0 px-1 pb-2 ${virtualized ? 'relative' : 'space-y-3'}`}
                style={virtualized ? { height: virtualizer.getTotalSize() } : undefined}
                aria-label={i18nService
                  .t('collaborationConversation')
                  .replace('{left}', name(selectedPair.left))
                  .replace('{right}', name(selectedPair.right))}
              >
                {deliveryRows.map(({ delivery, item }) => {
                  const fromLeft = delivery.from === selectedPair.left;
                  const colors = palette(delivery.from);
                  const StateIcon = STATE_ICONS[delivery.state];
                  const action = i18nService.t(
                    delivery.inReplyTo ? 'collaborationReply' : 'collaborationMessageSent',
                  );
                  const messageText = messageTexts[delivery.id];
                  const messageDisplay = messageText
                    ? messageText
                    : !canLoadMessageBody(delivery)
                      ? action
                      : messageLoadStates[delivery.id] === 'loading'
                        ? i18nService.t('collaborationMessageLoading')
                        : i18nService.t('collaborationMessageUnavailable');
                  const state = i18nService.t(STATE_LABELS[delivery.state]);
                  const date = new Date(delivery.createdAt);
                  return (
                    <li
                      key={delivery.id}
                      ref={item ? virtualizer.measureElement : undefined}
                      data-index={item?.index}
                      style={
                        item
                          ? {
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              transform: `translateY(${item.start}px)`,
                            }
                          : undefined
                      }
                      className={`flex items-start gap-2 ${item ? 'pb-3' : ''} ${fromLeft ? 'justify-start' : 'flex-row-reverse justify-start'}`}
                    >
                      <span
                        title={name(delivery.from)}
                        aria-hidden="true"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white shadow-sm"
                        style={{ backgroundColor: colors.stroke }}
                      >
                        {Array.from(name(delivery.from).trim())[0]?.toLocaleUpperCase() || '?'}
                      </span>
                      <div
                        className={`flex min-w-0 max-w-[75%] flex-col ${fromLeft ? 'items-start' : 'items-end'}`}
                      >
                        <div
                          role="button"
                          tabIndex={onSelectMessage ? 0 : undefined}
                          aria-disabled={!onSelectMessage}
                          onClick={event => {
                            if ((event.target as Element).closest('a')) return;
                            onSelectMessage?.(delivery);
                          }}
                          onKeyDown={event => {
                            if (onSelectMessage && (event.key === 'Enter' || event.key === ' ')) {
                              event.preventDefault();
                              onSelectMessage(delivery);
                            }
                          }}
                          aria-label={`${name(delivery.from)} ${messageDisplay} ${date.toLocaleString()} ${state}`}
                          className={`min-w-0 max-w-full rounded-2xl border px-3 py-2 text-left text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${onSelectMessage ? 'cursor-pointer hover:brightness-95' : ''} ${
                            fromLeft
                              ? 'rounded-bl-sm border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800'
                              : 'rounded-br-sm border-primary/20 bg-primary/5'
                          }`}
                        >
                          {messageText ? (
                            <CollaborationMessageMarkdown content={messageText} />
                          ) : (
                            <span className="block min-w-0 break-words text-secondary">
                              {messageDisplay}
                            </span>
                          )}
                        </div>
                        <span
                          className={`mt-1 flex max-w-full items-center gap-1.5 px-1 text-[10px] leading-none text-secondary ${fromLeft ? 'flex-row' : 'flex-row-reverse'}`}
                        >
                          <strong className="min-w-0 truncate font-medium">
                            {name(delivery.from)}
                          </strong>
                          <time
                            dateTime={date.toISOString()}
                            title={date.toLocaleString()}
                            className="shrink-0 tabular-nums text-secondary"
                          >
                            {formatCollaborationTimestamp(date)}
                          </time>
                          <span
                            aria-label={state}
                            title={state}
                            className={`inline-flex shrink-0 ${
                              delivery.state === 'failed'
                                ? 'text-red-600 dark:text-red-400'
                                : delivery.state === 'unknown'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : delivery.state === 'accepted'
                                    ? 'text-teal-600 dark:text-teal-400'
                                    : 'text-secondary'
                            }`}
                          >
                            <StateIcon className="h-3.5 w-3.5" aria-hidden="true" />
                          </span>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : (
            <ol
              className={`min-w-0 ${virtualized ? 'relative' : 'divide-y divide-border/50'}`}
              style={virtualized ? { height: virtualizer.getTotalSize() } : undefined}
              aria-label={i18nService.t('collaborationTimeline')}
            >
              {deliveryRows.map(({ delivery, item }) => {
                const StateIcon = STATE_ICONS[delivery.state];
                const ActionIcon = delivery.inReplyTo ? ArrowUturnLeftIcon : ArrowUpRightIcon;
                const action = i18nService.t(
                  delivery.inReplyTo ? 'collaborationReply' : 'collaborationMessageSent',
                );
                const state = i18nService.t(STATE_LABELS[delivery.state]);
                const date = new Date(delivery.createdAt);
                const direction = `${name(delivery.from)} → ${name(delivery.to)}`;
                return (
                  <li
                    key={delivery.id}
                    ref={item ? virtualizer.measureElement : undefined}
                    data-index={item?.index}
                    style={
                      item
                        ? {
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${item.start}px)`,
                          }
                        : undefined
                    }
                    className={item ? 'border-b border-border/50' : undefined}
                  >
                    <button
                      type="button"
                      disabled={!onSelectMessage}
                      onClick={() => onSelectMessage?.(delivery)}
                      aria-label={`${direction} ${action} ${date.toLocaleString()} ${state}`}
                      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-xs enabled:hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <span title={action} className="shrink-0 text-secondary">
                        <ActionIcon className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only">{action}</span>
                      </span>
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: palette(delivery.from).stroke }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate" title={direction}>
                        {direction}
                      </span>
                      <time
                        dateTime={date.toISOString()}
                        title={date.toLocaleString()}
                        className="shrink-0 tabular-nums text-secondary"
                      >
                        {formatCollaborationTimestamp(date)}
                      </time>
                      <span
                        title={state}
                        className={`shrink-0 ${delivery.state === 'failed' ? 'text-red-600 dark:text-red-400' : delivery.state === 'unknown' ? 'text-amber-600 dark:text-amber-400' : delivery.state === 'accepted' ? 'text-teal-600 dark:text-teal-400' : 'text-secondary'}`}
                      >
                        <StateIcon className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only">{state}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
