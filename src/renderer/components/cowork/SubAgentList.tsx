import React from 'react';

export interface SubTaskInfo {
  agentId: string;
  sessionKey?: string;
  childSessionId?: string;
  task: string;
  status: 'pending' | 'running' | 'done' | 'failed';
}

interface SubAgentListProps {
  sessionId: string | null;
  currentSessionId: string | null;
  enrichedSubTasks: SubTaskInfo[];
  setActiveSubTask: React.Dispatch<
    React.SetStateAction<{
      agentId: string;
      sessionKey?: string;
      childSessionId?: string;
      displayName?: string;
      parentSessionId: string;
      status: 'pending' | 'running' | 'done' | 'failed';
    } | null>
  >;
  isCollapsed?: boolean;
  hideFailedSubagents?: boolean;
}

const statusDotClass: Record<string, string> = {
  done: 'bg-green-500',
  pending: 'bg-orange-500 animate-pulse',
  running: 'bg-blue-500 animate-pulse',
  failed: 'bg-red-500',
};

const SubAgentList: React.FC<SubAgentListProps> = ({
  sessionId,
  currentSessionId,
  enrichedSubTasks,
  setActiveSubTask,
  isCollapsed = false,
  hideFailedSubagents = false,
}) => {
  // Filter out failed subagents if hideFailedSubagents is true
  const visibleSubTasks = hideFailedSubagents
    ? enrichedSubTasks.filter(sub => sub.status !== 'failed')
    : enrichedSubTasks;

  if (sessionId !== currentSessionId || visibleSubTasks.length === 0 || isCollapsed) return null;

  return (
    <div className="ml-4 pl-3 border-l-2 border-claude-accent/20 dark:border-claude-accent/15 space-y-0.5">
      {visibleSubTasks.map(sub => (
        <div
          key={sub.agentId}
          onClick={() => {
            if (!sessionId) return;
            setActiveSubTask({
              agentId: sub.agentId,
              sessionKey: sub.sessionKey,
              childSessionId: sub.childSessionId,
              displayName: sub.task,
              parentSessionId: sessionId,
              status: sub.status,
            });
          }}
          className="flex items-center gap-2 py-1 px-2 rounded-md text-xs transition-colors cursor-pointer hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDotClass[sub.status] || 'bg-blue-500 animate-pulse'}`}
          />
          <span className={`font-medium dark:text-claude-darkText text-claude-text truncate`}>
            {sub.task}
          </span>
        </div>
      ))}
    </div>
  );
};

export default SubAgentList;
