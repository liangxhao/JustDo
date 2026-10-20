import React from 'react';

import CoworkSessionItem from '@/features/cowork/components/sessions/CoworkSessionItem';
import type { CoworkSessionSummary, SessionGroup } from '@/features/cowork/coworkTypes';

import SessionListPageFooter, { type SessionListPageFooterProps } from './SessionListPageFooter';

interface SessionGroupPanelProps extends SessionListPageFooterProps {
  sessions: CoworkSessionSummary[];
  groups: SessionGroup[];
  isExpanded: boolean;
  currentSessionId: string | null;
  unreadSessionIds: string[];
  runtimeRunningSessionIds: Set<string>;
  isBatchMode: boolean;
  selectedIds: Set<string>;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onExportSession: (sessionId: string) => void;
  onCopySession: (sessionId: string) => void;
  onTogglePinned: (sessionId: string, pinned: boolean) => void;
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
  onMoveToGroup?: (sessionId: string, groupId: string | null) => void;
}

const SessionGroupPanel: React.FC<SessionGroupPanelProps> = ({
  sessions,
  groups,
  isExpanded,
  currentSessionId,
  unreadSessionIds,
  runtimeRunningSessionIds,
  isBatchMode,
  selectedIds,
  onSelectSession,
  onDeleteSession,
  onRename,
  onExportSession,
  onCopySession,
  onTogglePinned,
  onToggleSelection,
  onEnterBatchMode,
  onMoveToGroup,
  isLoading,
  loadFailed,
  hasMore,
  onShowMore,
  onRetry,
}) => {
  if (!isExpanded) return null;

  return (
    <div className="session-group-panel">
      {sessions.map(session => (
        <CoworkSessionItem
          key={session.id}
          session={session}
          hasUnread={unreadSessionIds.includes(session.id)}
          isRuntimeRunning={runtimeRunningSessionIds.has(session.id)}
          isActive={currentSessionId === session.id}
          isBatchMode={isBatchMode}
          isSelected={selectedIds.has(session.id)}
          groups={groups}
          onSelect={() => onSelectSession(session.id)}
          onDelete={() => onDeleteSession(session.id)}
          onRename={title => onRename(session.id, title)}
          onExport={() => onExportSession(session.id)}
          onCopy={() => onCopySession(session.id)}
          onTogglePinned={() => onTogglePinned(session.id, !session.pinned)}
          onToggleSelection={() => onToggleSelection(session.id)}
          onEnterBatchMode={() => onEnterBatchMode(session.id)}
          onMoveToGroup={onMoveToGroup ? groupId => onMoveToGroup(session.id, groupId) : undefined}
        />
      ))}
      <SessionListPageFooter
        isLoading={isLoading}
        loadFailed={loadFailed}
        hasMore={hasMore}
        onShowMore={onShowMore}
        onRetry={onRetry}
      />
    </div>
  );
};

export default SessionGroupPanel;
