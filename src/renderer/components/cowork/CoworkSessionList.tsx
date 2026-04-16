import React, { useMemo, useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { selectUnreadSessionIds } from '../../store/selectors/coworkSelectors';
import { RootState } from '../../store';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem from './CoworkSessionItem';
import SubTaskDetailDrawer from './SubTaskDetailDrawer';
import { i18nService } from '../../services/i18n';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';

/** 从 sessions_spawn 工具调用中提取的子任务信息 */
interface SubTaskInfo {
  agentId: string;
  task: string;
  status: 'running' | 'done';
  sessionKey?: string;
}

interface CoworkSessionListProps {
  sessions: CoworkSessionSummary[];
  isLoading?: boolean;
  currentSessionId: string | null;
  isBatchMode: boolean;
  selectedIds: Set<string>;
  showBatchOption?: boolean;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
}

const CoworkSessionList: React.FC<CoworkSessionListProps> = ({
  sessions,
  isLoading = false,
  currentSessionId,
  isBatchMode,
  selectedIds,
  showBatchOption = true,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
  onToggleSelection,
  onEnterBatchMode,
}) => {
  const unreadSessionIds = useSelector(selectUnreadSessionIds);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);

  // 从当前会话消息中提取子任务
  const currentSession = useSelector((state: RootState) => state.cowork.currentSession);
  const subTasks = useMemo<SubTaskInfo[]>(() => {
    if (!currentSession?.messages) return [];
    const tasks = new Map<string, SubTaskInfo>();
    for (let i = 0; i < currentSession.messages.length; i++) {
      const msg = currentSession.messages[i];
      const meta = msg.metadata;
      if (!meta) continue;

      // 调试：打印所有工具调用
      if (msg.type === 'tool_use') {
        console.log(
          '[CoworkSessionList] tool_use message: toolName=' +
            meta.toolName +
            ' toolInput=' +
            JSON.stringify(meta.toolInput || {}).slice(0, 200),
        );
      }

      if (msg.type === 'tool_use' && meta.toolName === 'sessions_spawn') {
        const input = meta.toolInput as Record<string, unknown> | undefined;
        // agentId 或 label 作为子任务标识符（OpenClaw 可能使用 label 代替 agentId）
        const agentId =
          typeof input?.agentId === 'string' && input.agentId
            ? input.agentId
            : typeof input?.label === 'string' && input.label
              ? input.label
              : '';
        const task = typeof input?.task === 'string' ? input.task.slice(0, 60) : '';
        console.log(
          '[CoworkSessionList] sessions_spawn found: agentId=' + agentId + ' task=' + task,
        );
        if (agentId) {
          tasks.set(agentId, { agentId, task, status: 'running' });
        }
      }

      if (
        msg.type === 'tool_use' &&
        (meta.toolName === 'sessions_resume' || meta.toolName === 'sessions_read')
      ) {
        const input = meta.toolInput as Record<string, unknown> | undefined;
        // agentId 或 label 作为子任务标识符
        const agentId =
          typeof input?.agentId === 'string' && input.agentId
            ? input.agentId
            : typeof input?.label === 'string' && input.label
              ? input.label
              : '';
        if (agentId && tasks.has(agentId)) {
          tasks.set(agentId, { ...tasks.get(agentId)!, status: 'done' });
        }
      }
    }

    if (currentSession.status === 'completed') {
      for (const [agentId, task] of tasks) {
        tasks.set(agentId, { ...task, status: 'done' });
      }
    }

    return Array.from(tasks.values());
  }, [currentSession?.messages, currentSession?.status]);

  // 轮询后端获取实时子 Agent 状态
  const [backendStatuses, setBackendStatuses] = useState<Record<string, 'running' | 'done'>>({});
  const isSessionActive = currentSession?.status === 'running';
  const activeSessionId = currentSession?.id;
  const hasRunningRef = React.useRef(false);

  useEffect(() => {
    setBackendStatuses({});
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
        console.log(
          '[CoworkSessionList] getSubTaskStatus result: success=' +
            result.success +
            ' statuses=' +
            JSON.stringify(result.statuses || {}),
        );
        if (result.success && result.statuses) {
          setBackendStatuses(result.statuses);
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

  // 合并消息提取的子任务和后端发现的状态
  const enrichedSubTasks = useMemo(() => {
    const merged = subTasks.map(t => {
      const backendStatus = backendStatuses[t.agentId];
      if (backendStatus === 'done' && t.status === 'running') {
        return { ...t, status: 'done' as const };
      }
      if (backendStatus === 'running') {
        return { ...t, status: 'running' as const };
      }
      return t;
    });

    const knownAgentIds = new Set(subTasks.map(t => t.agentId));
    for (const [agentId, status] of Object.entries(backendStatuses)) {
      if (!knownAgentIds.has(agentId)) {
        merged.push({ agentId, task: '', status });
      }
    }

    // 调试日志
    if (merged.length > 0 || subTasks.length > 0 || Object.keys(backendStatuses).length > 0) {
      console.log(
        '[CoworkSessionList] enrichedSubTasks: ' +
          merged.length +
          ' items' +
          ' (subTasks=' +
          subTasks.length +
          ', backendStatuses=' +
          Object.keys(backendStatuses).length +
          ')',
      );
    }

    return merged;
  }, [subTasks, backendStatuses]);

  // 子任务详情抽屉状态
  const [activeSubTask, setActiveSubTask] = useState<{
    agentId: string;
    parentSessionId: string;
  } | null>(null);

  const sortedSessions = useMemo(() => {
    const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary) => {
      if (b.updatedAt !== a.updatedAt) {
        return b.updatedAt - a.updatedAt;
      }
      return b.createdAt - a.createdAt;
    };

    const pinnedSessions = sessions.filter(session => session.pinned).sort(sortByRecentActivity);
    const unpinnedSessions = sessions.filter(session => !session.pinned).sort(sortByRecentActivity);
    return [...pinnedSessions, ...unpinnedSessions];
  }, [sessions]);

  if (sessions.length === 0) {
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
    <>
      <div className="space-y-px">
        {sortedSessions.map(session => (
          <React.Fragment key={session.id}>
            <CoworkSessionItem
              key={session.id}
              session={session}
              hasUnread={unreadSessionIdSet.has(session.id)}
              isActive={session.id === currentSessionId}
              isBatchMode={isBatchMode}
              isSelected={selectedIds.has(session.id)}
              showBatchOption={showBatchOption}
              onSelect={() => onSelectSession(session.id)}
              onDelete={() => onDeleteSession(session.id)}
              onTogglePin={pinned => onTogglePin(session.id, pinned)}
              onRename={title => onRenameSession(session.id, title)}
              onToggleSelection={() => onToggleSelection(session.id)}
              onEnterBatchMode={() => onEnterBatchMode(session.id)}
            />
            {/* 子任务列表: 当前会话时显示，会话完成后保留已完成的子任务 */}
            {session.id === currentSessionId && enrichedSubTasks.length > 0 && (
              <div className="ml-4 pl-3 border-l-2 border-claude-accent/20 dark:border-claude-accent/15 space-y-0.5">
                  {enrichedSubTasks.map(sub => (
                    <div
                      key={sub.agentId}
                      onClick={() =>
                        setActiveSubTask({ agentId: sub.agentId, parentSessionId: session.id })
                      }
                      className="flex items-center gap-2 py-1 px-2 rounded-md text-xs transition-colors cursor-pointer hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          sub.status === 'done' ? 'bg-green-500' : 'bg-blue-500 animate-pulse'
                        }`}
                      />
                      <span className="font-medium dark:text-claude-darkText text-claude-text truncate">
                        {sub.agentId}
                      </span>
                      {sub.task && (
                        <span
                          className="dark:text-claude-darkTextSecondary text-claude-textSecondary truncate flex-1"
                          title={sub.task}
                        >
                          {sub.task}
                        </span>
                      )}
                      <span
                        className={`text-[10px] flex-shrink-0 ${
                          sub.status === 'done'
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-blue-600 dark:text-blue-400'
                        }`}
                      >
                        {sub.status === 'done'
                          ? i18nService.t('orchLogDone') || 'Completed'
                          : i18nService.t('orchLogSpawning') || 'Running...'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
          </React.Fragment>
        ))}
      </div>

      {/* 子任务详情抽屉 */}
      {activeSubTask && (
        <SubTaskDetailDrawer
          agentId={activeSubTask.agentId}
          parentSessionId={activeSubTask.parentSessionId}
          onClose={() => setActiveSubTask(null)}
        />
      )}
    </>
  );
};

export default CoworkSessionList;
