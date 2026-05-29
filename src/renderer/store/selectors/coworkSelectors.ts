import { createSelector } from '@reduxjs/toolkit';

import type { CoworkSessionSummary } from '../../types/cowork';
import type { RootState } from '../index';

// --- Primitive (identity) selectors ---
// These return stable references for primitive values or existing object refs,
// so useSelector's default === check is enough to skip re-renders.

export const selectCoworkSessions = (state: RootState) => state.cowork.sessions;
export const selectCurrentSessionId = (state: RootState) => state.cowork.currentSessionId;
export const selectCurrentSession = (state: RootState) => state.cowork.currentSession;
export const selectIsStreaming = (state: RootState) => state.cowork.isStreaming;
export const selectIsCoworkActive = (state: RootState) => state.cowork.isCoworkActive;
export const selectRemoteManaged = (state: RootState) => state.cowork.remoteManaged;
export const selectCoworkConfig = (state: RootState) => state.cowork.config;
export const selectDraftPrompts = (state: RootState) => state.cowork.draftPrompts;
export const selectPendingPermissions = (state: RootState) => state.cowork.pendingPermissions;
export const selectUnreadSessionIds = (state: RootState) => state.cowork.unreadSessionIds;
export const selectThinkingExpanded = (state: RootState) => state.cowork.thinkingExpanded;
export const selectToolExpanded = (state: RootState) => state.cowork.toolExpanded;
export const selectHideFailedSubagents = (state: RootState) => state.cowork.hideFailedSubagents;

// Session Group selectors
export const selectGroups = (state: RootState) => state.cowork.groups;
export const selectExpandedGroupIds = (state: RootState) => state.cowork.expandedGroupIds;

// --- Derived (memoized) selectors ---
// These compute new values from the store and use createSelector to avoid
// returning new object references when the inputs haven't changed.

export const selectAgentEngine = createSelector(selectCoworkConfig, config => config.agentEngine);

export const selectIsOpenClawEngine = createSelector(
  selectAgentEngine,
  engine => engine === 'openclaw',
);

export const selectCurrentMessages = createSelector(
  selectCurrentSession,
  session => session?.messages ?? null,
);

export const selectCurrentMessagesLength = createSelector(
  selectCurrentMessages,
  messages => messages?.length ?? 0,
);

export const selectLastMessageContent = createSelector(selectCurrentMessages, messages => {
  if (!messages || messages.length === 0) return undefined;
  return messages[messages.length - 1]?.content;
});

export const selectFirstPendingPermission = createSelector(
  selectPendingPermissions,
  permissions => permissions[0] ?? null,
);

// Stable empty array reference to avoid unnecessary re-renders
const EMPTY_ATTACHMENTS: unknown[] = [];
const EMPTY_SESSIONS: CoworkSessionSummary[] = [];

export const selectDraftAttachments = (state: RootState, draftKey: string) =>
  state.cowork.draftAttachments[draftKey] ?? EMPTY_ATTACHMENTS;

// Session Group derived selectors
export const selectSessionsByGroup = createSelector(
  [selectCoworkSessions, (_: RootState, groupId: string | null) => groupId],
  (sessions, groupId): CoworkSessionSummary[] =>
    sessions.filter(s => s.groupId === groupId) || EMPTY_SESSIONS,
);

export const selectUnGroupedSessions = createSelector(selectCoworkSessions, sessions =>
  sessions.filter(s => !s.groupId),
);

export const selectGroupById = createSelector(
  [selectGroups, (_: RootState, groupId: string) => groupId],
  (groups, groupId) => groups.find(g => g.id === groupId) ?? null,
);

export const selectIsGroupExpanded = createSelector(
  [selectExpandedGroupIds, (_: RootState, groupId: string) => groupId],
  (expandedIds, groupId) => expandedIds.includes(groupId),
);

export const selectGroupSessionCount = createSelector(
  [selectCoworkSessions, (_: RootState, groupId: string) => groupId],
  (sessions, groupId) => sessions.filter(s => s.groupId === groupId).length,
);
