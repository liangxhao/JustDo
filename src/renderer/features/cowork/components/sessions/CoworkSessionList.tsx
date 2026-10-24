import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { ChatBubbleLeftRightIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { SESSION_LIST_PAGE_SIZE, type SessionDirectoryEntry } from '@shared/cowork/sessionDirectory';
import { OpenClawExtensionId } from '@shared/plugins/nativeIds';
import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import CoworkSessionItem from '@/features/cowork/components/sessions/CoworkSessionItem';
import CreateGroupModal from '@/features/cowork/components/sessions/CreateGroupModal';
import SessionGroupHeader from '@/features/cowork/components/sessions/SessionGroupHeader';
import SessionGroupPanel from '@/features/cowork/components/sessions/SessionGroupPanel';
import {
  selectExpandedGroupIds,
  selectGroups,
  selectSessionDirectory,
  selectUnreadSessionIds,
} from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import {
  deleteGroup as deleteGroupAction,
  reorderGroups,
  toggleGroupExpanded,
  updateGroup,
} from '@/features/cowork/coworkSlice';
import type {
  CoworkSessionSummary,
  CreateGroupInput,
  SessionGroup,
  UpdateGroupInput,
} from '@/features/cowork/coworkTypes';
import {
  DEFAULT_COLLAPSED_SESSION_DATE_GROUP_KEYS,
  groupSessionsByDate,
  partitionSidebarSessions,
  type SessionDateGroupKey,
} from '@/features/cowork/sessionPresentation';
import { useExtensionAvailability } from '@/features/plugins/extensions/useExtensionEnablement';
import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';

import { useCollaborationRooms } from '../collaboration/CollaborationPanel';
import { useTeamDiscussionRooms } from '../discussions/teamDiscussionNavigation';
import { useSwarmWorkflowActivity } from '../swarm-workflow/useSwarmWorkflowActivity';
import { collectRelatedRunningSessionIds } from './sessionListActivity';
import SessionListPageFooter, { type SessionListPageFooterProps } from './SessionListPageFooter';

type ListDirectoryEntry = SessionDirectoryEntry & Pick<CoworkSessionSummary, 'collaboration'>;

interface DateGroupPage {
  key: SessionDateGroupKey;
  count: number;
  isCollapsed: boolean;
  sessions: CoworkSessionSummary[];
  footer: SessionListPageFooterProps;
}

interface UngroupedDroppableZoneProps {
  unGroupedSessions: CoworkSessionSummary[];
  unreadSessionIdSet: Set<string>;
  runtimeRunningSessionIds: Set<string>;
  currentSessionId: string | null;
  isBatchMode: boolean;
  selectedIds: Set<string>;
  showBatchOption?: boolean;
  groups: SessionGroup[];
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onExportSession: (sessionId: string) => void;
  onCopySession: (sessionId: string) => void;
  onCollaborationSession?: (sessionId: string) => void;
  onTogglePinned: (sessionId: string, pinned: boolean) => void;
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
  onMoveToGroup: (sessionId: string, groupId: string | null) => void;
  showDateGroups: boolean;
  dateGroups: DateGroupPage[];
  onToggleDateGroup: (key: SessionDateGroupKey) => void;
}

const dateGroupLabels: Record<SessionDateGroupKey, string> = {
  pinned: 'sessionGroupPinned',
  today: 'sessionGroupToday',
  yesterday: 'sessionGroupYesterday',
  previous7Days: 'sessionGroupPrevious7Days',
  previous30Days: 'sessionGroupPrevious30Days',
  earlier: 'sessionGroupEarlier',
};

const UngroupedDroppableZone: React.FC<UngroupedDroppableZoneProps> = ({
  unGroupedSessions,
  unreadSessionIdSet,
  runtimeRunningSessionIds,
  currentSessionId,
  isBatchMode,
  selectedIds,
  showBatchOption,
  groups,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onExportSession,
  onCopySession,
  onCollaborationSession,
  onTogglePinned,
  onToggleSelection,
  onEnterBatchMode,
  onMoveToGroup,
  showDateGroups,
  dateGroups,
  onToggleDateGroup,
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: 'ungrouped' });

  const renderSession = (session: CoworkSessionSummary) => (
    <CoworkSessionItem
      key={session.id}
      session={session}
      hasUnread={unreadSessionIdSet.has(session.id)}
      isRuntimeRunning={runtimeRunningSessionIds.has(session.id)}
      isActive={session.id === currentSessionId}
      isBatchMode={isBatchMode}
      isSelected={selectedIds.has(session.id)}
      showBatchOption={showBatchOption}
      groups={groups}
      onSelect={() => onSelectSession(session.id)}
      onDelete={() => onDeleteSession(session.id)}
      onRename={title => onRenameSession(session.id, title)}
      onExport={() => onExportSession(session.id)}
      onCopy={() => onCopySession(session.id)}
      onCollaboration={
        onCollaborationSession ? () => onCollaborationSession(session.id) : undefined
      }
      onTogglePinned={() => onTogglePinned(session.id, !session.pinned)}
      onToggleSelection={() => onToggleSelection(session.id)}
      onEnterBatchMode={() => onEnterBatchMode(session.id)}
      onMoveToGroup={groupId => onMoveToGroup(session.id, groupId)}
    />
  );

  return (
    <div ref={setNodeRef} className="mt-1.5">
      <div className="px-2.5 py-1">
        <span className="text-xs font-medium text-secondary">{i18nService.t('coworkHistory')}</span>
      </div>
      <div className={isOver ? 'rounded-lg bg-blue-500/10 ring-1 ring-blue-400/30' : ''}>
        {showDateGroups
          ? dateGroups.map(group => {
              const isCollapsed = group.isCollapsed;
              const label = i18nService.t(dateGroupLabels[group.key]);
              return (
                <section key={group.key} className="mb-1 last:mb-0">
                  <button
                    type="button"
                    onClick={() => onToggleDateGroup(group.key)}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-raised"
                    aria-expanded={!isCollapsed}
                    aria-label={`${label} · ${group.count} · ${i18nService.t(
                      isCollapsed ? 'expand' : 'collapse',
                    )}`}
                  >
                    <ChevronRightIcon
                      className={`h-3.5 w-3.5 shrink-0 text-secondary transition-transform ${
                        isCollapsed ? '' : 'rotate-90'
                      }`}
                    />
                    <span className="text-xs font-semibold text-foreground/80">{label}</span>
                    <span className="ml-auto min-w-5 px-1.5 py-0.5 text-center text-[10px] font-medium tabular-nums text-secondary">
                      {group.count}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="space-y-0.5">
                      {group.sessions.map(renderSession)}
                      <SessionListPageFooter {...group.footer} />
                    </div>
                  )}
                </section>
              );
            })
          : unGroupedSessions.map(renderSession)}
      </div>
    </div>
  );
};

interface UngroupedSessionListProps {
  sessions: CoworkSessionSummary[];
  directory?: SessionDirectoryEntry[];
  onVisibleSessionIdsChange?: (sessionIds: string[]) => void;
  isLoading?: boolean;
  loadFailed?: boolean;
  currentSessionId: string | null;
  isBatchMode: boolean;
  selectedIds: Set<string>;
  showBatchOption?: boolean;
  showCreateGroupButton?: boolean;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onExportSession: (sessionId: string) => void;
  onCopySession: (sessionId: string) => void;
  onCollaborationSession?: (sessionId: string) => void;
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
  groupRecentSessionsByDate?: boolean;
}

const UngroupedSessionList: React.FC<UngroupedSessionListProps> = ({
  sessions: inputSessions,
  directory: inputDirectory = inputSessions,
  onVisibleSessionIdsChange,
  isLoading = false,
  loadFailed = false,
  currentSessionId,
  isBatchMode,
  selectedIds,
  showBatchOption = true,
  showCreateGroupButton = true,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onExportSession,
  onCopySession,
  onCollaborationSession,
  onToggleSelection,
  onEnterBatchMode,
  groupRecentSessionsByDate = false,
}) => {
  const dispatch = useDispatch();
  const rooms = useCollaborationRooms();
  const discussions = useTeamDiscussionRooms();
  const swarmAvailability = useExtensionAvailability(OpenClawExtensionId.SWARM_WORKFLOW);
  const workflowActivity = useSwarmWorkflowActivity(
    inputDirectory.map(session => session.id),
    swarmAvailability,
  );
  const allSessions = useSelector(selectSessionDirectory);
  const unreadSessionIds = useSelector(selectUnreadSessionIds);
  const sessionRuntimeActivity = useSelector(
    (state: RootState) => state.cowork.sessionRuntimeActivity,
  );
  const directory = useMemo<ListDirectoryEntry[]>(
    () =>
      inputDirectory.map(session => {
        const room = rooms.find(room => room.anchorSessionId === session.id);
        if (!room) return session;
        const members = allSessions.filter(item =>
          room.members.some(member => member.sessionId === item.id),
        );
        const running =
          room.members.some(member => sessionRuntimeActivity[member.sessionId]) ||
          members.some(item => item.status === 'running');
        return {
          ...session,
          status: room.deleting
            ? ('error' as const)
            : running
              ? ('running' as const)
              : session.status,
          updatedAt: Math.max(session.updatedAt, ...members.map(item => item.updatedAt)),
          collaboration: { memberCount: room.members.length, deleting: Boolean(room.deleting) },
        };
      }),
    [inputDirectory, rooms, allSessions, sessionRuntimeActivity],
  );
  const summaryById = useMemo(
    () => new Map(inputSessions.map(session => [session.id, session])),
    [inputSessions],
  );
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
  const runtimeRunningSessionIds = useMemo(
    () =>
      new Set([
        ...Object.entries(sessionRuntimeActivity)
          .filter(([, running]) => running)
          .map(([sessionId]) => sessionId),
        ...directory.filter(session => session.status === 'running').map(session => session.id),
        ...collectRelatedRunningSessionIds(rooms, discussions, sessionRuntimeActivity),
        ...Object.keys(workflowActivity).filter(sessionId => workflowActivity[sessionId]),
      ]),
    [sessionRuntimeActivity, directory, rooms, discussions, workflowActivity],
  );
  const groups = useSelector(selectGroups);
  const expandedGroupIds = useSelector(selectExpandedGroupIds);
  const {
    cli: cliSessions,
    browserExtension: browserExtensionSessions,
    regular: regularSessions,
  } = useMemo(() => partitionSidebarSessions(directory), [directory]);
  const [expandedSourceGroupIds, setExpandedSourceGroupIds] = useState<Set<string>>(new Set());
  const currentSourceGroupId = cliSessions.some(session => session.id === currentSessionId)
    ? 'cli'
    : browserExtensionSessions.some(session => session.id === currentSessionId)
      ? 'browserExtension'
      : null;
  const sourceGroups = [
    { id: 'cli', sessions: cliSessions, label: 'agentCliSessionGroup', color: '#478f94' },
    {
      id: 'browserExtension',
      sessions: browserExtensionSessions,
      label: 'browserExtensionSessionGroup',
      color: '#359daf',
    },
  ];

  useEffect(() => {
    if (currentSourceGroupId) {
      setExpandedSourceGroupIds(current => new Set(current).add(currentSourceGroupId));
    }
  }, [currentSessionId, currentSourceGroupId]);

  // DnD state
  const [activeSession, setActiveSession] = useState<CoworkSessionSummary | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const activeId = event.active.id as string;
    // Only show drag overlay for sessions, not groups
    if (!activeId.startsWith('group-drag-')) {
      const session = summaryById.get(activeId);
      setActiveSession(session || null);
    } else {
      setActiveSession(null);
    }
  };

  const handleMoveToGroup = async (sessionId: string, groupId: string | null) => {
    if (!regularSessions.some(session => session.id === sessionId)) return;
    if (groupId !== null && !groups.some(group => group.id === groupId)) return;
    await coworkService.moveSessionToGroup(sessionId, groupId);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveSession(null);
    if (!over) return;

    const activeId = String(active.id);
    const targetId = String(over.id);

    // Group reordering
    if (activeId.startsWith('group-drag-')) {
      const draggedGroupId = activeId.replace('group-drag-', '');
      // Handle dropping onto another group header
      if (targetId.startsWith('group-') && !targetId.startsWith('group-drag-')) {
        const targetGroupId = targetId.replace('group-', '');
        if (draggedGroupId !== targetGroupId) {
          const fromIndex = groups.findIndex(g => g.id === draggedGroupId);
          const toIndex = groups.findIndex(g => g.id === targetGroupId);
          if (fromIndex < 0 || toIndex < 0) return;
          const newOrder = [...groups];
          const [moved] = newOrder.splice(fromIndex, 1);
          newOrder.splice(toIndex, 0, moved);
          const newSortOrders = newOrder.map((g, i) => ({ id: g.id, sortOrder: i }));
          for (const { id, sortOrder } of newSortOrders) {
            await coworkService.updateGroup(id, { sortOrder });
          }
          dispatch(reorderGroups(newOrder.map(g => g.id)));
        }
      }
      return;
    }

    // Session moving
    const sessionId = activeId;
    if (targetId.startsWith('group-') && !targetId.startsWith('group-drag-')) {
      const groupId = targetId.replace('group-', '');
      await handleMoveToGroup(sessionId, groupId);
    } else if (targetId === 'ungrouped') {
      await handleMoveToGroup(sessionId, null);
    }
  };

  // Group handlers
  const [isCreateGroupOpen, setIsCreateGroupOpen] = useState(false);

  const handleToggleGroupExpand = (groupId: string) => {
    dispatch(toggleGroupExpanded(groupId));
  };

  const handleCreateGroup = async (input: CreateGroupInput) => {
    await coworkService.createGroup(input);
  };

  const handleUpdateGroup = async (id: string, input: UpdateGroupInput) => {
    await coworkService.updateGroup(id, input);
    dispatch(updateGroup({ id, updates: input }));
  };

  const handleDeleteGroup = async (groupId: string) => {
    await coworkService.deleteGroup(groupId);
    dispatch(deleteGroupAction(groupId));
  };

  const handleTogglePinned = async (sessionId: string, pinned: boolean) => {
    let succeeded = false;
    try {
      succeeded = await coworkService.setSessionPinned(sessionId, pinned);
    } catch {
      succeeded = false;
    }
    if (!succeeded) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t('updateConversationPinFailed'),
        }),
      );
    }
  };

  const handleMoveGroupUp = async (index: number) => {
    if (index <= 0) return;
    const newOrder = [...groups];
    [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
    const groupIds = newOrder.map(g => g.id);
    await coworkService.reorderGroups(groupIds);
    dispatch(reorderGroups(groupIds));
  };

  const handleMoveGroupDown = async (index: number) => {
    if (index >= groups.length - 1) return;
    const newOrder = [...groups];
    [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
    const groupIds = newOrder.map(g => g.id);
    await coworkService.reorderGroups(groupIds);
    dispatch(reorderGroups(groupIds));
  };

  // Separate ungrouped sessions
  const unGroupedSessions = useMemo(() => {
    const sortByRecentActivity = (a: ListDirectoryEntry, b: ListDirectoryEntry) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
    };
    const pinned = regularSessions.filter(s => !s.groupId && s.pinned).sort(sortByRecentActivity);
    const unpinned = regularSessions
      .filter(s => !s.groupId && !s.pinned)
      .sort(sortByRecentActivity);
    return [...pinned, ...unpinned];
  }, [regularSessions]);

  // Grouped sessions by group ID
  const groupedSessionsByGroupId = useMemo(() => {
    const result = new Map<string, ListDirectoryEntry[]>(groups.map(group => [group.id, []]));
    for (const session of regularSessions) {
      if (session.groupId) result.get(session.groupId)?.push(session);
    }
    for (const sessions of result.values()) {
      sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    }
    return result;
  }, [regularSessions, groups]);

  const [collapsedDateGroupKeys, setCollapsedDateGroupKeys] = useState<Set<SessionDateGroupKey>>(
    () => new Set(DEFAULT_COLLAPSED_SESSION_DATE_GROUP_KEYS),
  );
  const [calendarRefreshKey, setCalendarRefreshKey] = useState(() => Date.now());
  const [pageLimits, setPageLimits] = useState<Record<string, number>>({});
  const [failedRequestKey, setFailedRequestKey] = useState<string | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  useEffect(() => {
    if (!groupRecentSessionsByDate) return;
    let midnightTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleNextMidnight = () => {
      if (midnightTimer) clearTimeout(midnightTimer);
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      midnightTimer = setTimeout(() => {
        setCalendarRefreshKey(Date.now());
        scheduleNextMidnight();
      }, Math.max(1, nextMidnight - Date.now() + 100));
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setCalendarRefreshKey(Date.now());
      scheduleNextMidnight();
    };
    scheduleNextMidnight();
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      if (midnightTimer) clearTimeout(midnightTimer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [groupRecentSessionsByDate]);

  const dateGroups = useMemo(
    () => groupSessionsByDate(unGroupedSessions, calendarRefreshKey),
    [unGroupedSessions, calendarRefreshKey],
  );
  const pageEntries = (key: string, entries: ListDirectoryEntry[], all = false) =>
    all ? entries : entries.slice(0, pageLimits[key] ?? SESSION_LIST_PAGE_SIZE);
  const visibleEntries = [
    ...sourceGroups.flatMap(group => expandedSourceGroupIds.has(group.id)
      ? pageEntries(`source:${group.id}`, group.sessions) : []),
    ...groups.flatMap(group => expandedGroupIds.includes(group.id)
      ? pageEntries(`group:${group.id}`, groupedSessionsByGroupId.get(group.id) ?? []) : []),
    ...(groupRecentSessionsByDate
      ? dateGroups.flatMap(group => collapsedDateGroupKeys.has(group.key)
        ? [] : pageEntries(`date:${group.key}`, group.sessions,
          !DEFAULT_COLLAPSED_SESSION_DATE_GROUP_KEYS.includes(group.key)))
      : unGroupedSessions),
  ];
  const missingIds = visibleEntries.filter(entry => !summaryById.has(entry.id)).map(entry => entry.id);
  const requestKey = JSON.stringify(missingIds);
  useEffect(() => {
    if (requestKey === '[]') return;
    let cancelled = false;
    setFailedRequestKey(null);
    void coworkService.ensureSessionSummaries(JSON.parse(requestKey) as string[]).then(
      succeeded => {
        if (!cancelled && !succeeded) setFailedRequestKey(requestKey);
      },
      () => {
        if (!cancelled) setFailedRequestKey(requestKey);
      },
    );
    return () => { cancelled = true; };
  }, [requestKey, retryRevision]);

  const visibleIdsKey = JSON.stringify(
    visibleEntries.filter(entry => summaryById.has(entry.id)).map(entry => entry.id),
  );
  useEffect(() => {
    onVisibleSessionIdsChange?.(JSON.parse(visibleIdsKey) as string[]);
  }, [visibleIdsKey, onVisibleSessionIdsChange]);

  const resolveSummaries = (entries: ListDirectoryEntry[]): CoworkSessionSummary[] =>
    entries.flatMap(entry => {
      const summary = summaryById.get(entry.id);
      return summary ? [{ ...summary, ...entry }] : [];
    });
  const pageProps = (key: string, entries: ListDirectoryEntry[], all = false) => {
    const page = pageEntries(key, entries, all);
    const missing = page.some(entry => !summaryById.has(entry.id));
    const failed = missing && failedRequestKey === requestKey;
    return {
      sessions: resolveSummaries(page),
      isLoading: missing && !failed,
      loadFailed: failed,
      hasMore: page.length < entries.length,
      onRetry: () => setRetryRevision(revision => revision + 1),
      onShowMore: () => setPageLimits(current => ({
        ...current,
        [key]: (current[key] ?? SESSION_LIST_PAGE_SIZE) + SESSION_LIST_PAGE_SIZE,
      })),
    };
  };
  const toggleDateGroup = (key: SessionDateGroupKey) => {
    setCollapsedDateGroupKeys(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (directory.length === 0 && isLoading) {
    return (
      <div
        role="status"
        aria-label={i18nService.t('startupSessionsLoading')}
        className="space-y-1 px-2.5 pt-4"
      >
        <div aria-hidden="true" className="mb-4 h-2 w-14 rounded-full bg-secondary opacity-15" />
        {['w-4/5', 'w-3/5', 'w-2/3'].map(width => (
          <div
            key={width}
            aria-hidden="true"
            className="rounded-xl px-1 py-3 motion-safe:animate-pulse"
          >
            <div className={`h-2 rounded-full bg-secondary opacity-20 ${width}`} />
            <div className="mt-2.5 h-1.5 w-1/3 rounded-full bg-secondary opacity-10" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="space-y-px">
        {/* 对话分组 section */}
        <div className="flex items-center justify-between px-2.5 py-1">
          <span className="text-xs font-medium text-secondary">
            {i18nService.t('groupedSessions')}
          </span>
          {showCreateGroupButton && (
            <button
              type="button"
              onClick={() => setIsCreateGroupOpen(true)}
              className="h-5 w-5 inline-flex items-center justify-center rounded text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
              aria-label="Create new group"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="h-3.5 w-3.5"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
        </div>
        {sourceGroups.map(sourceGroup => {
          if (sourceGroup.sessions.length === 0) return null;
          const isExpanded = expandedSourceGroupIds.has(sourceGroup.id);
          return (
            <React.Fragment key={sourceGroup.id}>
              <button
                type="button"
                className="session-group-header w-full"
                onClick={() =>
                  setExpandedSourceGroupIds(current => {
                    const next = new Set(current);
                    if (next.has(sourceGroup.id)) next.delete(sourceGroup.id);
                    else next.add(sourceGroup.id);
                    return next;
                  })
                }
                aria-expanded={isExpanded}
              >
                <span
                  className="group-indicator"
                  style={{ '--group-color': sourceGroup.color } as React.CSSProperties}
                  aria-hidden="true"
                >
                  <ChatBubbleLeftRightIcon />
                </span>
                <span className="group-name">{i18nService.t(sourceGroup.label)}</span>
                <span className="group-count">{sourceGroup.sessions.length}</span>
                <ChevronRightIcon className={`chevron-icon ${isExpanded ? 'rotate-90' : ''}`} />
              </button>
              <SessionGroupPanel
                {...pageProps(`source:${sourceGroup.id}`, sourceGroup.sessions)}
                groups={[]}
                isExpanded={isExpanded}
                currentSessionId={currentSessionId}
                unreadSessionIds={unreadSessionIds}
                runtimeRunningSessionIds={runtimeRunningSessionIds}
                isBatchMode={isBatchMode}
                selectedIds={selectedIds}
                onSelectSession={onSelectSession}
                onDeleteSession={onDeleteSession}
                onRename={onRenameSession}
                onExportSession={onExportSession}
                onCopySession={onCopySession}
                onCollaborationSession={onCollaborationSession}
                onTogglePinned={handleTogglePinned}
                onToggleSelection={onToggleSelection}
                onEnterBatchMode={onEnterBatchMode}
              />
            </React.Fragment>
          );
        })}
        {groups.length > 0 && (
          <>
            {groups.map((group, index) => {
              const groupSessions = groupedSessionsByGroupId.get(group.id) ?? [];
              const isExpanded = expandedGroupIds.includes(group.id);
              return (
                <React.Fragment key={group.id}>
                  <SessionGroupHeader
                    group={group}
                    sessionCount={groupSessions.length}
                    isExpanded={isExpanded}
                    onToggleExpand={() => handleToggleGroupExpand(group.id)}
                    onRename={name => handleUpdateGroup(group.id, { name })}
                    onUpdateColor={color => handleUpdateGroup(group.id, { color })}
                    onDelete={() => handleDeleteGroup(group.id)}
                    onMoveUp={index > 0 ? () => handleMoveGroupUp(index) : undefined}
                    onMoveDown={
                      index < groups.length - 1 ? () => handleMoveGroupDown(index) : undefined
                    }
                  />
                  <SessionGroupPanel
                    {...pageProps(`group:${group.id}`, groupSessions)}
                    groups={groups}
                    isExpanded={isExpanded}
                    currentSessionId={currentSessionId}
                    unreadSessionIds={unreadSessionIds}
                    runtimeRunningSessionIds={runtimeRunningSessionIds}
                    isBatchMode={isBatchMode}
                    selectedIds={selectedIds}
                    onSelectSession={onSelectSession}
                    onDeleteSession={onDeleteSession}
                    onRename={onRenameSession}
                    onExportSession={onExportSession}
                    onCopySession={onCopySession}
                    onCollaborationSession={onCollaborationSession}
                    onTogglePinned={handleTogglePinned}
                    onToggleSelection={onToggleSelection}
                    onEnterBatchMode={onEnterBatchMode}
                    onMoveToGroup={handleMoveToGroup}
                  />
                </React.Fragment>
              );
            })}
          </>
        )}

        {directory.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 px-4">
            <ChatBubbleLeftRightIcon className="h-10 w-10 text-secondary/40 mb-3" />
            <p className="text-sm font-medium text-secondary mb-1">
              {i18nService.t(loadFailed ? 'startupSessionsError' : 'coworkNoSessions')}
            </p>
          </div>
        ) : regularSessions.length > 0 ? (
          <UngroupedDroppableZone
            unGroupedSessions={groupRecentSessionsByDate ? [] : resolveSummaries(unGroupedSessions)}
            dateGroups={dateGroups.map(group => {
              const { sessions, ...footer } = pageProps(`date:${group.key}`, group.sessions,
                !DEFAULT_COLLAPSED_SESSION_DATE_GROUP_KEYS.includes(group.key));
              return {
                key: group.key,
                count: group.sessions.length,
                isCollapsed: collapsedDateGroupKeys.has(group.key),
                sessions,
                footer,
              };
            })}
            onToggleDateGroup={toggleDateGroup}
            unreadSessionIdSet={unreadSessionIdSet}
            runtimeRunningSessionIds={runtimeRunningSessionIds}
            currentSessionId={currentSessionId}
            isBatchMode={isBatchMode}
            selectedIds={selectedIds}
            showBatchOption={showBatchOption}
            groups={groups}
            onSelectSession={onSelectSession}
            onDeleteSession={onDeleteSession}
            onRenameSession={onRenameSession}
            onExportSession={onExportSession}
            onCopySession={onCopySession}
            onCollaborationSession={onCollaborationSession}
            onTogglePinned={handleTogglePinned}
            onToggleSelection={onToggleSelection}
            onEnterBatchMode={onEnterBatchMode}
            showDateGroups={groupRecentSessionsByDate}
            onMoveToGroup={handleMoveToGroup}
          />
        ) : null}
      </div>

      {/* Drag overlay */}
      <DragOverlay>
        {activeSession && (
          <div className="px-3 py-2 rounded-lg bg-surface-raised shadow-lg border border-border opacity-90">
            <div className="text-xs font-medium text-foreground truncate">
              {activeSession.title}
            </div>
          </div>
        )}
      </DragOverlay>

      {showCreateGroupButton && (
        <CreateGroupModal
          isOpen={isCreateGroupOpen}
          onClose={() => setIsCreateGroupOpen(false)}
          onCreate={handleCreateGroup}
          existingColors={groups.map(g => g.color)}
        />
      )}
    </DndContext>
  );
};

export default UngroupedSessionList;
