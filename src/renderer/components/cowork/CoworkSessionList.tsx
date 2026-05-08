import React, { useMemo, useState, useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  DndContext,
  DragOverlay,
  useSensor,
  useSensors,
  useDroppable,
  PointerSensor,
  DragStartEvent,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  selectUnreadSessionIds,
  selectGroups,
  selectExpandedGroupIds,
} from '../../store/selectors/coworkSelectors';
import { RootState } from '../../store';
import {
  moveSessionToGroup,
  toggleGroupExpanded,
  updateGroup,
  deleteGroup as deleteGroupAction,
  reorderGroups,
} from '../../store/slices/coworkSlice';
import type {
  CoworkSessionSummary,
  UpdateGroupInput,
  CreateGroupInput,
  SessionGroup,
} from '../../types/cowork';
import CoworkSessionItem from './CoworkSessionItem';
import SessionGroupHeader from './SessionGroupHeader';
import SessionGroupPanel from './SessionGroupPanel';
import SubAgentList, { SubTaskInfo } from './SubAgentList';
import CreateGroupModal from './CreateGroupModal';
import SubTaskDetailDrawer from './SubTaskDetailDrawer';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';

interface UngroupedDroppableZoneProps {
  unGroupedSessions: CoworkSessionSummary[];
  unreadSessionIdSet: Set<string>;
  currentSessionId: string | null;
  isBatchMode: boolean;
  selectedIds: Set<string>;
  showBatchOption?: boolean;
  groups: SessionGroup[];
  enrichedSubTasks: SubTaskInfo[];
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
  setActiveSubTask: React.Dispatch<
    React.SetStateAction<{
      agentId: string;
      displayName?: string;
      parentSessionId: string;
      status: 'pending' | 'running' | 'done' | 'failed';
    } | null>
  >;
  onMoveToGroup: (sessionId: string, groupId: string | null) => void;
  collapsedSubagentSessions: Set<string>;
  onToggleSubagentCollapse: (sessionId: string) => void;
}

const UngroupedDroppableZone: React.FC<UngroupedDroppableZoneProps> = ({
  unGroupedSessions,
  unreadSessionIdSet,
  currentSessionId,
  isBatchMode,
  selectedIds,
  showBatchOption,
  groups,
  enrichedSubTasks,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onToggleSelection,
  onEnterBatchMode,
  setActiveSubTask,
  onMoveToGroup,
  collapsedSubagentSessions,
  onToggleSubagentCollapse,
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: 'ungrouped' });

  return (
    <div ref={setNodeRef} className="mt-2">
      <div className="px-2.5 pt-2 pb-1">
        <span className="text-xs font-medium text-secondary">{i18nService.t('coworkHistory')}</span>
      </div>
      <div className={isOver ? 'rounded-lg bg-blue-500/10 ring-1 ring-blue-400/30' : ''}>
        {unGroupedSessions.map(session => (
          <React.Fragment key={session.id}>
            <CoworkSessionItem
              session={session}
              hasUnread={unreadSessionIdSet.has(session.id)}
              isActive={session.id === currentSessionId}
              isBatchMode={isBatchMode}
              isSelected={selectedIds.has(session.id)}
              showBatchOption={showBatchOption}
              groups={groups}
              onSelect={() => onSelectSession(session.id)}
              onDelete={() => onDeleteSession(session.id)}
              onRename={title => onRenameSession(session.id, title)}
              onToggleSelection={() => onToggleSelection(session.id)}
              onEnterBatchMode={() => onEnterBatchMode(session.id)}
              onMoveToGroup={async groupId => {
                await coworkService.moveSessionToGroup(session.id, groupId);
                onMoveToGroup(session.id, groupId);
              }}
              hasSubagents={enrichedSubTasks.length > 0}
              subagentsCollapsed={collapsedSubagentSessions.has(session.id)}
              onToggleSubagentCollapse={() => onToggleSubagentCollapse(session.id)}
            />
            <SubAgentList
              sessionId={session.id}
              currentSessionId={currentSessionId}
              enrichedSubTasks={enrichedSubTasks}
              setActiveSubTask={setActiveSubTask}
              isCollapsed={collapsedSubagentSessions.has(session.id)}
            />
          </React.Fragment>
        ))}
        {unGroupedSessions.length === 0 && (
          <div className="px-2.5 py-4 text-center text-xs text-secondary">
            {i18nService.t('coworkNoSessionsHint') || 'Drop sessions here to ungroup'}
          </div>
        )}
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
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
}

const UngroupedSessionList: React.FC<UngroupedSessionListProps> = ({
  sessions,
  isLoading = false,
  currentSessionId,
  isBatchMode,
  selectedIds,
  showBatchOption = true,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onToggleSelection,
  onEnterBatchMode,
}) => {
  const dispatch = useDispatch();
  const unreadSessionIds = useSelector(selectUnreadSessionIds);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
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

  // Subagent collapse state per session
  const [collapsedSubagentSessions, setCollapsedSubagentSessions] = useState<Set<string>>(
    new Set(),
  );

  const handleToggleSubagentCollapse = (sessionId: string) => {
    setCollapsedSubagentSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

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

  // From current session messages extract subtasks
  const currentSession = useSelector((state: RootState) => state.cowork.currentSession);
  const subTasks = useMemo<SubTaskInfo[]>(() => {
    if (!currentSession?.messages) return [];
    const tasks = new Map<string, SubTaskInfo>();

    // First pass: find all sessions_spawn tool_use messages
    for (let i = 0; i < currentSession.messages.length; i++) {
      const msg = currentSession.messages[i];
      const meta = msg.metadata;
      if (!meta) continue;

      if (msg.type === 'tool_use' && meta.toolName === 'sessions_spawn') {
        const input = meta.toolInput as Record<string, unknown> | undefined;
        // Use toolUseId as unique identifier (label may duplicate)
        const toolUseId = meta.toolUseId || '';
        const label = typeof input?.label === 'string' && input.label ? input.label : '';
        const agentId = typeof input?.agentId === 'string' && input.agentId ? input.agentId : '';
        const task = typeof input?.task === 'string' ? input.task.slice(0, 60) : '';
        // task field stores label for display, agentId is toolUseId for unique key
        if (toolUseId) {
          tasks.set(toolUseId, {
            agentId: toolUseId,
            task: label || agentId || task,
            status: 'pending', // Initially pending (queued, waiting for execution)
          });
        }
      }
    }

    // Second pass: check for tool_result messages to determine if subagent was successfully started
    // A sessions_spawn tool_result means the subagent was started (status changes from pending to running)
    // NOTE: tool_result does NOT mean the subagent has finished execution - completion is tracked
    // by lifecycle events (agent.stopped/agent.completed) which update backend's subagentStatus
    for (let i = 0; i < currentSession.messages.length; i++) {
      const msg = currentSession.messages[i];
      if (msg.type === 'tool_result') {
        const meta = msg.metadata;
        if (!meta) continue;
        const toolUseId = meta.toolUseId as string | undefined;
        if (toolUseId && tasks.has(toolUseId)) {
          const existing = tasks.get(toolUseId)!;
          // If tool_result exists and not isError, subagent was successfully started
          // Change from pending to running (actual completion tracked by backend)
          if (existing.status === 'pending' && !meta.isError) {
            tasks.set(toolUseId, { ...existing, status: 'running' });
          }
          // If tool_result has isError, the subagent failed to start - should be filtered out
          // But this is handled by backend's failedSubagentIds, frontend relies on backendStatuses
        }
      }
    }

    // NOTE: We no longer use session.completed as a fallback to mark all subtasks as 'done'.
    // The backend's getSubagentStatuses (via backendStatuses) is the authoritative source
    // for subagent status. When backendStatuses is available, it will override frontend
    // extraction status in enrichedSubTasks. This prevents showing 'completed' for
    // running subagents when the session status might be stale in Redux.

    return Array.from(tasks.values());
  }, [currentSession?.messages, currentSession?.status]);

  // Poll backend for real-time sub agent status
  const [backendStatuses, setBackendStatuses] = useState<
    Record<string, 'pending' | 'running' | 'done' | 'failed'>
  >({});
  const [backendDisplayLabels, setBackendDisplayLabels] = useState<Record<string, string>>({});
  const isSessionActive = currentSession?.status === 'running';
  const activeSessionId = currentSession?.id;
  const hasRunningRef = React.useRef(false);

  useEffect(() => {
    setBackendStatuses({});
    setBackendDisplayLabels({});
    hasRunningRef.current = false;
  }, [activeSessionId]);

  useEffect(() => {
    hasRunningRef.current =
      Object.values(backendStatuses).some(s => s === 'running') ||
      subTasks.some(t => t.status === 'running');
  }, [backendStatuses, subTasks]);

  useEffect(() => {
    if (!activeSessionId) return;
    if (subTasks.length === 0 && !isSessionActive) return;
    const poll = async () => {
      try {
        const result = await window.electron.cowork.getSubTaskStatus(activeSessionId);
        if (result.success && result.statuses) {
          setBackendStatuses(result.statuses);
          if (result.displayLabels) {
            setBackendDisplayLabels(result.displayLabels);
          }
        }
      } catch {
        /* ignore */
      }
    };
    poll();
    const timer = setInterval(() => {
      if (!hasRunningRef.current && !isSessionActive) {
        clearInterval(timer);
        return;
      }
      poll();
    }, 3000);
    return () => clearInterval(timer);
  }, [activeSessionId, subTasks.length, isSessionActive]);

  // Merge message-extracted subtasks and backend-discovered statuses
  // Use backendDisplayLabels for display (key is toolUseId, unique)
  // Merge subTasks from Redux messages with backendStatuses from CoworkStore API.
  // Backend statuses is the authoritative source - failed subagents are filtered out by backend.
  // If backendStatuses has data, only show subagents that exist in backendStatuses.
  // If backendStatuses is empty (still loading), use frontend subTasks as fallback.
  const enrichedSubTasks = useMemo(() => {
    // If backend has returned statuses, use those as authoritative source
    // This filters out failed subagents that backend has removed from statuses
    if (Object.keys(backendStatuses).length > 0) {
      // Build list from backendStatuses (authoritative)
      const merged: Array<{
        agentId: string;
        task: string;
        status: 'pending' | 'running' | 'done' | 'failed';
        sessionKey?: string;
      }> = [];

      for (const [agentId, status] of Object.entries(backendStatuses)) {
        // Get display label from backend or fallback to frontend extraction
        const frontendTask = subTasks.find(t => t.agentId === agentId);
        const displayLabel = backendDisplayLabels[agentId] || frontendTask?.task || agentId;
        merged.push({
          agentId,
          task: displayLabel,
          status: status as 'pending' | 'running' | 'done' | 'failed',
        });
      }

      return merged;
    }

    // Fallback: use frontend extraction when backend hasn't responded yet
    return subTasks.map(t => ({
      ...t,
      task: backendDisplayLabels[t.agentId] || t.task,
      status: t.status,
    }));
  }, [subTasks, backendStatuses, backendDisplayLabels]);

  // Subtask detail drawer state
  const [activeSubTask, setActiveSubTask] = useState<{
    agentId: string;
    displayName?: string;
    parentSessionId: string;
    status: 'pending' | 'running' | 'done' | 'failed';
  } | null>(null);

  if (unGroupedSessions.length === 0 && sessions.length === 0) {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-10">
          <svg
            className="animate-spin h-6 w-6 dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60"
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
      <div className="flex flex-col items-center justify-center py-10 px-4">
        <ChatBubbleLeftRightIcon className="h-10 w-10 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-3" />
        <p className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('coworkNoSessions')}
        </p>
        <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 text-center">
          {i18nService.t('coworkNoSessionsHint')}
        </p>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="space-y-px">
        {/* 对话分组 section - always show header with create button */}
        <div className="flex items-center justify-between px-2.5 pt-2 pb-1">
          <span className="text-xs font-medium text-secondary">
            {i18nService.t('groupedSessions')}
          </span>
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
                    isBatchMode={isBatchMode}
                    selectedIds={selectedIds}
                    onSelectSession={onSelectSession}
                    onDeleteSession={onDeleteSession}
                    onRename={onRenameSession}
                    onToggleSelection={onToggleSelection}
                    onEnterBatchMode={onEnterBatchMode}
                    onMoveToGroup={async (sessionId, groupId) => {
                      await coworkService.moveSessionToGroup(sessionId, groupId);
                      dispatch(moveSessionToGroup({ sessionId, groupId }));
                    }}
                    enrichedSubTasks={enrichedSubTasks}
                    setActiveSubTask={setActiveSubTask}
                    collapsedSubagentSessions={collapsedSubagentSessions}
                    onToggleSubagentCollapse={handleToggleSubagentCollapse}
                  />
                </React.Fragment>
              );
            })}
          </>
        )}

        {/* 最近对话 section */}
        <UngroupedDroppableZone
          unGroupedSessions={unGroupedSessions}
          unreadSessionIdSet={unreadSessionIdSet}
          currentSessionId={currentSessionId}
          isBatchMode={isBatchMode}
          selectedIds={selectedIds}
          showBatchOption={showBatchOption}
          groups={groups}
          enrichedSubTasks={enrichedSubTasks}
          onSelectSession={onSelectSession}
          onDeleteSession={onDeleteSession}
          onRenameSession={onRenameSession}
          onToggleSelection={onToggleSelection}
          onEnterBatchMode={onEnterBatchMode}
          setActiveSubTask={setActiveSubTask}
          onMoveToGroup={async (sessionId, groupId) => {
            await coworkService.moveSessionToGroup(sessionId, groupId);
            dispatch(moveSessionToGroup({ sessionId, groupId }));
          }}
          collapsedSubagentSessions={collapsedSubagentSessions}
          onToggleSubagentCollapse={handleToggleSubagentCollapse}
        />
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

      <CreateGroupModal
        isOpen={isCreateGroupOpen}
        onClose={() => setIsCreateGroupOpen(false)}
        onCreate={handleCreateGroup}
        existingColors={groups.map(g => g.color)}
      />

      {/* Subtask detail drawer */}
      {activeSubTask && (
        <SubTaskDetailDrawer
          agentId={activeSubTask.agentId}
          displayName={activeSubTask.displayName}
          parentSessionId={activeSubTask.parentSessionId}
          status={activeSubTask.status}
          onClose={() => setActiveSubTask(null)}
        />
      )}
    </DndContext>
  );
};

export default UngroupedSessionList;
