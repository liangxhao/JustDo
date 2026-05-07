import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  CoworkSession,
  CoworkSessionSummary,
  CoworkMessage,
  CoworkConfig,
  CoworkPermissionRequest,
  CoworkSessionStatus,
  SessionGroup,
} from '../../types/cowork';
import { removeSessionFromState, removeSessionsFromState } from './coworkDeleteState';

export interface DraftAttachment {
  path: string;
  name: string;
  isImage?: boolean;
  dataUrl?: string;
}

interface CoworkState {
  sessions: CoworkSessionSummary[];
  groups: SessionGroup[];
  expandedGroupIds: string[];
  currentSessionId: string | null;
  currentSession: CoworkSession | null;
  draftPrompts: Record<string, string>;
  /** Keyed by draftKey (sessionId or '__home__'), stores pending attachments */
  draftAttachments: Record<string, DraftAttachment[]>;
  unreadSessionIds: string[];
  isCoworkActive: boolean;
  isStreaming: boolean;
  remoteManaged: boolean;
  pendingPermissions: CoworkPermissionRequest[];
  config: CoworkConfig;
  /** Global toggle for thinking content visibility - true = expanded, false = collapsed */
  thinkingExpanded: boolean;
  /** Global toggle for tool calls visibility - true = expanded (show), false = collapsed (hide) */
  toolExpanded: boolean;
}

const initialState: CoworkState = {
  sessions: [],
  groups: [],
  expandedGroupIds: [],
  currentSessionId: null,
  currentSession: null,
  draftPrompts: {},
  draftAttachments: {},
  unreadSessionIds: [],
  isCoworkActive: false,
  isStreaming: false,
  remoteManaged: false,
  pendingPermissions: [],
  config: {
    workingDirectory: '',
    executionMode: 'local',
    agentEngine: 'openclaw',
    memoryEnabled: true,
    memoryImplicitUpdateEnabled: true,
    memoryLlmJudgeEnabled: false,
    memoryGuardLevel: 'strict',
    memoryUserMemoriesMaxItems: 12,
  },
  thinkingExpanded: true, // Default to expanded (浅蓝色)
  toolExpanded: true, // Default to expanded (浅蓝色)
};

const markSessionRead = (state: CoworkState, sessionId: string | null) => {
  if (!sessionId) return;
  state.unreadSessionIds = state.unreadSessionIds.filter(id => id !== sessionId);
};

const markSessionUnread = (state: CoworkState, sessionId: string) => {
  if (state.currentSessionId === sessionId) return;
  if (state.unreadSessionIds.includes(sessionId)) return;
  state.unreadSessionIds.push(sessionId);
};

const coworkSlice = createSlice({
  name: 'cowork',
  initialState,
  reducers: {
    setCoworkActive(state, action: PayloadAction<boolean>) {
      state.isCoworkActive = action.payload;
    },

    setSessions(state, action: PayloadAction<CoworkSessionSummary[]>) {
      state.sessions = action.payload;
      const validSessionIds = new Set(action.payload.map(session => session.id));
      state.unreadSessionIds = state.unreadSessionIds.filter(id => {
        return validSessionIds.has(id) && id !== state.currentSessionId;
      });
    },

    setCurrentSessionId(state, action: PayloadAction<string | null>) {
      state.currentSessionId = action.payload;
      markSessionRead(state, action.payload);
    },

    setCurrentSession(state, action: PayloadAction<CoworkSession | null>) {
      state.currentSession = action.payload;
      if (action.payload) {
        state.currentSessionId = action.payload.id;
        if (!action.payload.id.startsWith('temp-')) {
          const { id, title, status, pinned, createdAt, updatedAt } = action.payload;
          const summary: CoworkSessionSummary = {
            id,
            title,
            status,
            pinned: pinned ?? false,
            createdAt,
            updatedAt,
          };
          const sessionIndex = state.sessions.findIndex(session => session.id === id);
          if (sessionIndex !== -1) {
            state.sessions[sessionIndex] = {
              ...state.sessions[sessionIndex],
              ...summary,
            };
          } else {
            state.sessions.unshift(summary);
          }
        }
        markSessionRead(state, action.payload.id);
      }
    },

    setDraftPrompt(state, action: PayloadAction<{ sessionId: string; draft: string }>) {
      const { sessionId, draft } = action.payload;
      if (draft) {
        state.draftPrompts[sessionId] = draft;
      } else {
        delete state.draftPrompts[sessionId];
      }
    },

    addSession(state, action: PayloadAction<CoworkSession>) {
      const summary: CoworkSessionSummary = {
        id: action.payload.id,
        title: action.payload.title,
        status: action.payload.status,
        pinned: action.payload.pinned ?? false,
        createdAt: action.payload.createdAt,
        updatedAt: action.payload.updatedAt,
      };
      state.sessions.unshift(summary);
      state.currentSession = action.payload;
      state.currentSessionId = action.payload.id;
      markSessionRead(state, action.payload.id);
    },

    updateSessionStatus(
      state,
      action: PayloadAction<{ sessionId: string; status: CoworkSessionStatus }>,
    ) {
      const { sessionId, status } = action.payload;

      // Update in sessions list
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].status = status;
        state.sessions[sessionIndex].updatedAt = Date.now();
      }

      // Update current session if applicable
      if (state.currentSession?.id === sessionId) {
        state.currentSession.status = status;
        state.currentSession.updatedAt = Date.now();
        // Streaming state is tied to the currently opened session only
        state.isStreaming = status === 'running';
      }
    },

    deleteSession(state, action: PayloadAction<string>) {
      removeSessionFromState(state, action.payload);
    },

    deleteSessions(state, action: PayloadAction<string[]>) {
      removeSessionsFromState(state, action.payload);
    },

    addMessage(state, action: PayloadAction<{ sessionId: string; message: CoworkMessage }>) {
      const { sessionId, message } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const exists = state.currentSession.messages.some(item => item.id === message.id);
        if (!exists) {
          state.currentSession.messages.push(message);
          state.currentSession.updatedAt = message.timestamp;
        }
      }

      // Update session in list
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].updatedAt = message.timestamp;
      }

      markSessionUnread(state, sessionId);
    },

    updateMessageContent(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string; content: string }>,
    ) {
      const { sessionId, messageId, content } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const messageIndex = state.currentSession.messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
          // Create a new messages array reference to trigger useMemo recalculation
          // This is necessary because useMemo depends on the messages array reference
          state.currentSession.messages = state.currentSession.messages.map((msg, idx) =>
            idx === messageIndex ? { ...msg, content } : msg,
          );
        }
      }

      markSessionUnread(state, sessionId);
    },

    updateMessageThinkingContent(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string; thinkingDelta: string }>,
    ) {
      const { sessionId, messageId, thinkingDelta } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const messageIndex = state.currentSession.messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
          const previousThinking =
            state.currentSession.messages[messageIndex].thinkingContent || '';
          const newThinking = previousThinking + thinkingDelta;
          // Create a new messages array reference to trigger useMemo recalculation
          // This is necessary because useMemo depends on the messages array reference
          state.currentSession.messages = state.currentSession.messages.map((msg, idx) =>
            idx === messageIndex ? { ...msg, thinkingContent: newThinking } : msg,
          );
        }
      }
    },

    deleteMessage(state, action: PayloadAction<{ sessionId: string; messageId: string }>) {
      const { sessionId, messageId } = action.payload;

      if (state.currentSession?.id === sessionId) {
        state.currentSession.messages = state.currentSession.messages.filter(
          m => m.id !== messageId,
        );
      }
    },

    updateMessageMetadata(
      state,
      action: PayloadAction<{
        sessionId: string;
        messageId: string;
        metadata: Record<string, unknown>;
      }>,
    ) {
      const { sessionId, messageId, metadata } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const messageIndex = state.currentSession.messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
          // Merge new metadata with existing metadata
          const existingMetadata = state.currentSession.messages[messageIndex].metadata || {};
          // Create a new messages array reference to trigger useMemo recalculation
          state.currentSession.messages = state.currentSession.messages.map((msg, idx) =>
            idx === messageIndex ? { ...msg, metadata: { ...existingMetadata, ...metadata } } : msg,
          );
        }
      }
    },

    setStreaming(state, action: PayloadAction<boolean>) {
      state.isStreaming = action.payload;
    },

    setRemoteManaged(state, action: PayloadAction<boolean>) {
      state.remoteManaged = action.payload;
    },

    updateSessionPinned(state, action: PayloadAction<{ sessionId: string; pinned: boolean }>) {
      const { sessionId, pinned } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].pinned = pinned;
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.pinned = pinned;
      }
    },

    updateSessionTitle(state, action: PayloadAction<{ sessionId: string; title: string }>) {
      const { sessionId, title } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].title = title;
        state.sessions[sessionIndex].updatedAt = Date.now();
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.title = title;
        state.currentSession.updatedAt = Date.now();
      }
    },

    enqueuePendingPermission(state, action: PayloadAction<CoworkPermissionRequest>) {
      const alreadyQueued = state.pendingPermissions.some(
        permission => permission.requestId === action.payload.requestId,
      );
      if (alreadyQueued) return;
      state.pendingPermissions.push(action.payload);
    },

    dequeuePendingPermission(state, action: PayloadAction<{ requestId?: string } | undefined>) {
      const requestId = action.payload?.requestId;
      if (!requestId) {
        state.pendingPermissions.shift();
        return;
      }
      state.pendingPermissions = state.pendingPermissions.filter(
        permission => permission.requestId !== requestId,
      );
    },

    clearPendingPermissions(state) {
      state.pendingPermissions = [];
    },

    setConfig(state, action: PayloadAction<CoworkConfig>) {
      state.config = action.payload;
    },

    updateConfig(state, action: PayloadAction<Partial<CoworkConfig>>) {
      state.config = { ...state.config, ...action.payload };
    },

    clearCurrentSession(state) {
      state.currentSessionId = null;
      state.currentSession = null;
      state.isStreaming = false;
      state.remoteManaged = false;
    },

    setDraftAttachments(
      state,
      action: PayloadAction<{ draftKey: string; attachments: DraftAttachment[] }>,
    ) {
      const { draftKey, attachments } = action.payload;
      if (attachments.length === 0) {
        delete state.draftAttachments[draftKey];
      } else {
        state.draftAttachments[draftKey] = attachments;
      }
    },

    addDraftAttachment(
      state,
      action: PayloadAction<{ draftKey: string; attachment: DraftAttachment }>,
    ) {
      const { draftKey, attachment } = action.payload;
      const existing = state.draftAttachments[draftKey] || [];
      if (existing.some(a => a.path === attachment.path)) return;
      state.draftAttachments[draftKey] = [...existing, attachment];
    },

    clearDraftAttachments(state, action: PayloadAction<string>) {
      delete state.draftAttachments[action.payload];
    },

    toggleThinkingExpanded(state) {
      state.thinkingExpanded = !state.thinkingExpanded;
    },

    toggleToolExpanded(state) {
      state.toolExpanded = !state.toolExpanded;
    },

    // Session Group actions
    setGroups(state, action: PayloadAction<SessionGroup[]>) {
      state.groups = action.payload;
    },

    addGroup(state, action: PayloadAction<SessionGroup>) {
      state.groups.push(action.payload);
    },

    updateGroup(state, action: PayloadAction<{ id: string; updates: Partial<SessionGroup> }>) {
      const { id, updates } = action.payload;
      const index = state.groups.findIndex(g => g.id === id);
      if (index !== -1) {
        state.groups[index] = { ...state.groups[index], ...updates };
      }
    },

    deleteGroup(state, action: PayloadAction<string>) {
      const groupId = action.payload;
      state.groups = state.groups.filter(g => g.id !== groupId);
      state.expandedGroupIds = state.expandedGroupIds.filter(id => id !== groupId);
      // Update sessions to remove groupId reference
      state.sessions = state.sessions.map(session =>
        session.groupId === groupId ? { ...session, groupId: null } : session,
      );
    },

    toggleGroupExpanded(state, action: PayloadAction<string>) {
      const groupId = action.payload;
      if (state.expandedGroupIds.includes(groupId)) {
        state.expandedGroupIds = state.expandedGroupIds.filter(id => id !== groupId);
      } else {
        state.expandedGroupIds.push(groupId);
      }
    },

    moveSessionToGroup(
      state,
      action: PayloadAction<{ sessionId: string; groupId: string | null }>,
    ) {
      const { sessionId, groupId } = action.payload;
      const index = state.sessions.findIndex(s => s.id === sessionId);
      if (index !== -1) {
        state.sessions[index] = { ...state.sessions[index], groupId };
      }
    },

    reorderGroups(state, action: PayloadAction<string[]>) {
      const groupIds = action.payload;
      state.groups = groupIds
        .map(id => state.groups.find(g => g.id === id))
        .filter((g): g is SessionGroup => g !== undefined)
        .map((g, index) => ({ ...g, sortOrder: index }));
    },
  },
});

export const {
  setCoworkActive,
  setSessions,
  setCurrentSessionId,
  setCurrentSession,
  setDraftPrompt,
  setDraftAttachments,
  addDraftAttachment,
  clearDraftAttachments,
  addSession,
  updateSessionStatus,
  deleteSession,
  deleteSessions,
  addMessage,
  updateMessageContent,
  updateMessageThinkingContent,
  updateMessageMetadata,
  deleteMessage,
  setStreaming,
  setRemoteManaged,
  updateSessionPinned,
  updateSessionTitle,
  enqueuePendingPermission,
  dequeuePendingPermission,
  clearPendingPermissions,
  setConfig,
  updateConfig,
  clearCurrentSession,
  toggleThinkingExpanded,
  toggleToolExpanded,
  // Session Group actions
  setGroups,
  addGroup,
  updateGroup,
  deleteGroup,
  toggleGroupExpanded,
  moveSessionToGroup,
  reorderGroups,
} = coworkSlice.actions;

export default coworkSlice.reducer;
