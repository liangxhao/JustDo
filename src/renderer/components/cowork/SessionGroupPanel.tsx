import React from 'react';
import type { SessionGroup, CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem from './CoworkSessionItem';

/** Subtask info shape matching CoworkSessionList */
interface SubTaskInfo {
  agentId: string;
  task: string;
  status: 'running' | 'done';
  sessionKey?: string;
}

interface SessionGroupPanelProps {
  group: SessionGroup;
  sessions: CoworkSessionSummary[];
  groups: SessionGroup[];
  isExpanded: boolean;
  currentSessionId: string | null;
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
    React.SetStateAction<{ agentId: string; displayName?: string; parentSessionId: string; isRunning: boolean } | null>
  >;
}

const SessionGroupPanel: React.FC<SessionGroupPanelProps> = ({
  group: _group,
  sessions,
  groups,
  isExpanded,
  currentSessionId,
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
          />
          <SubAgentList
            sessionId={session.id}
            currentSessionId={currentSessionId}
            enrichedSubTasks={enrichedSubTasks}
            setActiveSubTask={setActiveSubTask}
          />
        </React.Fragment>
      ))}
    </div>
  );
};

/** Inline subagent list — same component as in CoworkSessionList */
interface SubAgentListProps {
  sessionId: string;
  currentSessionId: string | null;
  enrichedSubTasks: SubTaskInfo[];
  setActiveSubTask: React.Dispatch<
    React.SetStateAction<{ agentId: string; displayName?: string; parentSessionId: string; isRunning: boolean } | null>
  >;
}

const SubAgentList: React.FC<SubAgentListProps> = ({
  sessionId,
  currentSessionId,
  enrichedSubTasks,
  setActiveSubTask,
}) => {
  if (sessionId !== currentSessionId || enrichedSubTasks.length === 0) return null;

  return (
    <div className="ml-4 pl-3 border-l-2 border-claude-accent/20 dark:border-claude-accent/15 space-y-0.5">
      {enrichedSubTasks.map(sub => (
        <div
          key={sub.agentId}
          onClick={() => setActiveSubTask({ agentId: sub.agentId, displayName: sub.task, parentSessionId: sessionId, isRunning: sub.status === 'running' })}
          className="flex items-center gap-2 py-1 px-2 rounded-md text-xs transition-colors cursor-pointer hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              sub.status === 'done' ? 'bg-green-500' : 'bg-blue-500 animate-pulse'
            }`}
          />
          <span className="font-medium dark:text-claude-darkText text-claude-text truncate">
            {sub.task}
          </span>
        </div>
      ))}
    </div>
  );
};

export default SessionGroupPanel;
