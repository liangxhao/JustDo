import React from 'react';
import type { SessionGroup, CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem from './CoworkSessionItem';
import SubAgentList, { SubTaskInfo } from './SubAgentList';

interface SessionGroupPanelProps {
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

const SessionGroupPanel: React.FC<SessionGroupPanelProps> = ({
  group: _group,
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
  onMoveToGroup,
  enrichedSubTasks,
  setActiveSubTask,
  collapsedSubagentSessions,
  onToggleSubagentCollapse,
  hideFailedSubagents = false,
  onToggleHideFailedSubagents,
}) => {
  if (!isExpanded || sessions.length === 0) return null;

  return (
    <div className="session-group-panel">
      {sessions.map(session => (
        <React.Fragment key={session.id}>
          <CoworkSessionItem
            session={session}
            hasUnread={unreadSessionIds.includes(session.id)}
            isActive={currentSessionId === session.id}
            isBatchMode={isBatchMode}
            isSelected={selectedIds.has(session.id)}
            groups={groups}
            onSelect={() => onSelectSession(session.id)}
            onDelete={() => onDeleteSession(session.id)}
            onRename={title => onRename(session.id, title)}
            onToggleSelection={() => onToggleSelection(session.id)}
            onEnterBatchMode={() => onEnterBatchMode(session.id)}
            onMoveToGroup={groupId => onMoveToGroup(session.id, groupId)}
            hasSubagents={session.id === activeSessionId && enrichedSubTasks.length > 0}
            subagentsCollapsed={collapsedSubagentSessions.has(session.id)}
            onToggleSubagentCollapse={() => onToggleSubagentCollapse(session.id)}
            hideFailedSubagents={hideFailedSubagents}
            onToggleHideFailedSubagents={onToggleHideFailedSubagents}
          />
          <SubAgentList
            sessionId={session.id}
            currentSessionId={currentSessionId}
            enrichedSubTasks={enrichedSubTasks}
            setActiveSubTask={setActiveSubTask}
            isCollapsed={collapsedSubagentSessions.has(session.id)}
            hideFailedSubagents={hideFailedSubagents}
          />
        </React.Fragment>
      ))}
    </div>
  );
};

export default SessionGroupPanel;
