import React from 'react';
import type { SessionGroup, CoworkSessionSummary } from '../../types/cowork';
import SessionGroupHeader from './SessionGroupHeader';
import SessionGroupPanel from './SessionGroupPanel';
import { SubTaskInfo } from './SubAgentList';

interface GroupListProps {
  group: SessionGroup;
  sessions: CoworkSessionSummary[];
  groups: SessionGroup[];
  isExpanded: boolean;
  currentSessionId: string | null;
  activeSessionId: string | undefined;
  unreadSessionIds: string[];
  isBatchMode: boolean;
  selectedIds: Set<string>;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
  onToggleExpand: () => void;
  onRenameGroup: (name: string) => void;
  onUpdateColor: (color: string) => void;
  onDeleteGroup: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onMoveToGroup: (sessionId: string, groupId: string | null) => void;
  enrichedSubTasks: SubTaskInfo[];
  setActiveSubTask: React.Dispatch<
    React.SetStateAction<{
      agentId: string;
      displayName?: string;
      parentSessionId: string;
      status: 'pending' | 'running' | 'done' | 'failed';
    } | null>
  >;
  collapsedSubagentSessions: Set<string>;
  onToggleSubagentCollapse: (sessionId: string) => void;
  hideFailedSubagents?: boolean;
  onToggleHideFailedSubagents?: () => void;
}

const GroupListItem: React.FC<GroupListProps> = ({
  group,
  sessions,
  groups,
  isExpanded,
  currentSessionId,
  activeSessionId,
  unreadSessionIds,
  isBatchMode,
  selectedIds,
  onSelectSession,
  onDeleteSession,
  onRename,
  onToggleSelection,
  onEnterBatchMode,
  onToggleExpand,
  onRenameGroup,
  onUpdateColor,
  onDeleteGroup,
  onMoveUp,
  onMoveDown,
  onMoveToGroup,
  enrichedSubTasks,
  setActiveSubTask,
  collapsedSubagentSessions,
  onToggleSubagentCollapse,
  hideFailedSubagents = false,
  onToggleHideFailedSubagents,
}) => {
  if (sessions.length === 0) return null;

  return (
    <>
      <SessionGroupHeader
        group={group}
        sessionCount={sessions.length}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        onRename={onRenameGroup}
        onUpdateColor={onUpdateColor}
        onDelete={onDeleteGroup}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
      />
      <SessionGroupPanel
        group={group}
        sessions={sessions}
        groups={groups}
        isExpanded={isExpanded}
        currentSessionId={currentSessionId}
        activeSessionId={activeSessionId}
        unreadSessionIds={unreadSessionIds}
        isBatchMode={isBatchMode}
        selectedIds={selectedIds}
        onSelectSession={onSelectSession}
        onDeleteSession={onDeleteSession}
        onRename={onRename}
        onToggleSelection={onToggleSelection}
        onEnterBatchMode={onEnterBatchMode}
        onMoveToGroup={onMoveToGroup}
        enrichedSubTasks={enrichedSubTasks}
        setActiveSubTask={setActiveSubTask}
        collapsedSubagentSessions={collapsedSubagentSessions}
        onToggleSubagentCollapse={onToggleSubagentCollapse}
        hideFailedSubagents={hideFailedSubagents}
        onToggleHideFailedSubagents={onToggleHideFailedSubagents}
      />
    </>
  );
};

export default GroupListItem;
