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
import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import CoworkSessionItem from '@/features/cowork/components/CoworkSessionItem';
import CreateGroupModal from '@/features/cowork/components/CreateGroupModal';
import SessionGroupHeader from '@/features/cowork/components/SessionGroupHeader';
import SessionGroupPanel from '@/features/cowork/components/SessionGroupPanel';
import {
  selectExpandedGroupIds,
  selectGroups,
  selectUnreadSessionIds,
} from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import {
  deleteGroup as deleteGroupAction,
  moveSessionToGroup,
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
  type SessionDateGroupKey,
} from '@/features/cowork/sessionPresentation';
import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';

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
  onTogglePinned: (sessionId: string, pinned: boolean) => void;
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
  onMoveToGroup: (sessionId: string, groupId: string | null) => void;
  showDateGroups: boolean;
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
  onTogglePinned,
  onToggleSelection,
  onEnterBatchMode,
  onMoveToGroup,
  showDateGroups,
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: 'ungrouped' });
  const [collapsedDateGroupKeys, setCollapsedDateGroupKeys] = useState<Set<SessionDateGroupKey>>(
    new Set(DEFAULT_COLLAPSED_SESSION_DATE_GROUP_KEYS),
  );
  const [calendarRefreshKey, setCalendarRefreshKey] = useState(() => Date.now());

  useEffect(() => {
    if (!showDateGroups) return;

    let midnightTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleNextMidnight = () => {
      if (midnightTimer) clearTimeout(midnightTimer);
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      midnightTimer = setTimeout(
        () => {
          setCalendarRefreshKey(Date.now());
          scheduleNextMidnight();
        },
        Math.max(1, nextMidnight - Date.now() + 100),
      );
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        setCalendarRefreshKey(Date.now());
        scheduleNextMidnight();
      }
    };

    scheduleNextMidnight();
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      if (midnightTimer) clearTimeout(midnightTimer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [showDateGroups]);

  const dateGroups = useMemo(
    () => (showDateGroups ? groupSessionsByDate(unGroupedSessions, calendarRefreshKey) : []),
    [calendarRefreshKey, showDateGroups, unGroupedSessions],
  );

  const toggleDateGroup = (key: SessionDateGroupKey) => {
    setCollapsedDateGroupKeys(current => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

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
      onTogglePinned={() => onTogglePinned(session.id, !session.pinned)}
      onToggleSelection={() => onToggleSelection(session.id)}
      onEnterBatchMode={() => onEnterBatchMode(session.id)}
      onMoveToGroup={groupId => onMoveToGroup(session.id, groupId)}
    />
  );

  return (
    <div ref={setNodeRef} className="mt-2">
      <div className="px-2.5 pt-2 pb-1">
        <span className="text-xs font-medium text-secondary">{i18nService.t('coworkHistory')}</span>
      </div>
      <div className={isOver ? 'rounded-lg bg-blue-500/10 ring-1 ring-blue-400/30' : ''}>
        {showDateGroups
          ? dateGroups.map(group => {
              const isCollapsed = collapsedDateGroupKeys.has(group.key);
              const label = i18nService.t(dateGroupLabels[group.key]);
              return (
                <section key={group.key} className="mb-1 last:mb-0">
                  <button
                    type="button"
                    onClick={() => toggleDateGroup(group.key)}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-raised"
                    aria-expanded={!isCollapsed}
                    aria-label={`${label} · ${group.sessions.length} · ${i18nService.t(
                      isCollapsed ? 'expand' : 'collapse',
                    )}`}
                  >
                    <ChevronRightIcon
                      className={`h-3.5 w-3.5 shrink-0 text-secondary transition-transform ${
                        isCollapsed ? '' : 'rotate-90'
                      }`}
                    />
                    <span className="text-xs font-semibold text-foreground/80">{label}</span>
                    <span className="ml-auto min-w-5 rounded-full bg-surface-raised px-1.5 py-0.5 text-center text-[10px] font-medium tabular-nums text-secondary">
                      {group.sessions.length}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="space-y-0.5">{group.sessions.map(renderSession)}</div>
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
  isLoading?: boolean;
  currentSessionId: string | null;
  isBatchMode: boolean;
  selectedIds: Set<string>;
  showBatchOption?: boolean;
  showCreateGroupButton?: boolean;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
  groupRecentSessionsByDate?: boolean;
}

const UngroupedSessionList: React.FC<UngroupedSessionListProps> = ({
  sessions,
  isLoading = false,
  currentSessionId,
  isBatchMode,
  selectedIds,
  showBatchOption = true,
  showCreateGroupButton = true,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onToggleSelection,
  onEnterBatchMode,
  groupRecentSessionsByDate = false,
}) => {
  const dispatch = useDispatch();
  const unreadSessionIds = useSelector(selectUnreadSessionIds);
  const sessionRuntimeActivity = useSelector(
    (state: RootState) => state.cowork.sessionRuntimeActivity,
  );
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
  const runtimeRunningSessionIds = useMemo(
    () =>
      new Set(
        Object.entries(sessionRuntimeActivity)
          .filter(([, running]) => running)
          .map(([sessionId]) => sessionId),
      ),
    [sessionRuntimeActivity],
  );
  const groups = useSelector(selectGroups);
  const expandedGroupIds = useSelector(selectExpandedGroupIds);

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
      const session = sessions.find(s => s.id === activeId);
      setActiveSession(session || null);
    } else {
      setActiveSession(null);
    }
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
      await coworkService.moveSessionToGroup(sessionId, groupId);
      dispatch(moveSessionToGroup({ sessionId, groupId }));
    } else if (targetId === 'ungrouped') {
      await coworkService.moveSessionToGroup(sessionId, null);
      dispatch(moveSessionToGroup({ sessionId, groupId: null }));
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
    const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return b.createdAt - a.createdAt;
    };
    const pinned = sessions.filter(s => !s.groupId && s.pinned).sort(sortByRecentActivity);
    const unpinned = sessions.filter(s => !s.groupId && !s.pinned).sort(sortByRecentActivity);
    return [...pinned, ...unpinned];
  }, [sessions]);

  // Grouped sessions by group ID
  const groupedSessionsByGroupId = useMemo(() => {
    const result: Record<string, CoworkSessionSummary[]> = {};
    for (const group of groups) {
      const groupSessions = sessions.filter(s => s.groupId === group.id);
      const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary) => {
        if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
        return b.createdAt - a.createdAt;
      };
      const pinned = groupSessions.filter(s => s.pinned).sort(sortByRecentActivity);
      const unpinned = groupSessions.filter(s => !s.pinned).sort(sortByRecentActivity);
      result[group.id] = [...pinned, ...unpinned];
    }
    return result;
  }, [sessions, groups]);

  if (sessions.length === 0 && isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <svg
          className="animate-spin h-6 w-6 text-secondary/60"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="space-y-px">
        {/* 对话分组 section */}
        <div className="flex items-center justify-between px-2.5 pt-2 pb-1">
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
        {groups.length > 0 && (
          <>
            {groups.map((group, index) => {
              const groupSessions = groupedSessionsByGroupId[group.id] || [];
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
                    group={group}
                    sessions={groupSessions}
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
                    onTogglePinned={handleTogglePinned}
                    onToggleSelection={onToggleSelection}
                    onEnterBatchMode={onEnterBatchMode}
                    onMoveToGroup={async (sessionId, groupId) => {
                      await coworkService.moveSessionToGroup(sessionId, groupId);
                      dispatch(moveSessionToGroup({ sessionId, groupId }));
                    }}
                  />
                </React.Fragment>
              );
            })}
          </>
        )}

        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 px-4">
            <ChatBubbleLeftRightIcon className="h-10 w-10 text-secondary/40 mb-3" />
            <p className="text-sm font-medium text-secondary mb-1">
              {i18nService.t('coworkNoSessions')}
            </p>
          </div>
        ) : (
          <UngroupedDroppableZone
            unGroupedSessions={unGroupedSessions}
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
            onTogglePinned={handleTogglePinned}
            onToggleSelection={onToggleSelection}
            onEnterBatchMode={onEnterBatchMode}
            showDateGroups={groupRecentSessionsByDate}
            onMoveToGroup={async (sessionId, groupId) => {
              await coworkService.moveSessionToGroup(sessionId, groupId);
              dispatch(moveSessionToGroup({ sessionId, groupId }));
            }}
          />
        )}
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
