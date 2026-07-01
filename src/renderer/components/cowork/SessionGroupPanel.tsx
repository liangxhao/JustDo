import React from 'react';

import type { CoworkSessionSummary,SessionGroup } from '../../types/cowork';
import CoworkSessionItem from './CoworkSessionItem';

interface SessionGroupPanelProps {
  group: SessionGroup;
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
  onToggleSelection: (sessionId: string) => void;
  onEnterBatchMode: (sessionId: string) => void;
  onMoveToGroup: (sessionId: string, groupId: string | null) => void;
}

const SessionGroupPanel: React.FC<SessionGroupPanelProps> = ({
  group: _group,
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
  onToggleSelection,
  onEnterBatchMode,
  onMoveToGroup,
}) => {
  if (!isExpanded || sessions.length === 0) return null;

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
            onToggleSelection={() => onToggleSelection(session.id)}
            onEnterBatchMode={() => onEnterBatchMode(session.id)}
            onMoveToGroup={groupId => onMoveToGroup(session.id, groupId)}
          />
      ))}
    </div>
  );
};

export default SessionGroupPanel;
