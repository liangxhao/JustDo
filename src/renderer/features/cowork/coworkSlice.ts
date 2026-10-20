import { createSlice, original, PayloadAction } from '@reduxjs/toolkit';
import type { BrowserAnnotationDraft } from '@shared/browser/browser';
import type { BrowserRecordingDraft } from '@shared/browser/browserRecording';
import { DEFAULT_MAX_RETAINED_DISPLAY_TABS } from '@shared/cowork/displayTabRetention';
import type { SessionDirectoryEntry } from '@shared/cowork/sessionDirectory';
import { DEFAULT_MAX_GOAL_CONTINUATION_TURNS } from '@shared/cowork/sessionGoal';
import type { SessionRuntimeSnapshot, SessionRunTiming } from '@shared/cowork/sessionRun';
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '@shared/security/approvals';

import {
  removeSessionFromState,
  removeSessionsFromState,
} from '@/features/cowork/coworkDeleteState';
import type {
  CoworkConfig,
  CoworkInteractionRequest,
  CoworkSession,
  CoworkSessionStatus,
  CoworkSessionSummary,
  SessionGroup,
} from '@/features/cowork/coworkTypes';
import type { Model } from '@/features/models/modelSlice';

import type { MessageQuote } from './components/composer/draft/messageQuote';
import { MESSAGE_QUOTE_KIND, validCollaborationQuote } from './components/composer/draft/messageQuote';

export interface DraftAttachment {
  path: string;
  name: string;
  isImage?: boolean;
  dataUrl?: string;
}

interface CoworkState {
  sessions: CoworkSessionSummary[];
  /** Complete metadata directory; loaded row summaries are only a subset. */
  sessionDirectory: SessionDirectoryEntry[] | null;
  sessionListStatus: 'loading' | 'ready' | 'error';
  groups: SessionGroup[];
  expandedGroupIds: string[];
  currentSessionId: string | null;
  currentSession: CoworkSession | null;
  draftPrompts: Record<string, string>;
  draftMessageQuotes: Record<string, MessageQuote[]>;
  /** Keyed by draftKey (sessionId or '__home__'), stores pending attachments */
  draftAttachments: Record<string, DraftAttachment[]>;
  /** Browser annotations are generated context and remain scoped to one composer draft. */
  draftBrowserAnnotations: Record<string, BrowserAnnotationDraft[]>;
  draftBrowserRecordings: Record<string, BrowserRecordingDraft>;
  unreadSessionIds: string[];
  isCoworkActive: boolean;
  isStreaming: boolean;
  sessionMainRuntimeActivity: Record<string, boolean>;
  sessionRuntimeActivity: Record<string, boolean>;
  sessionRunTimings: Record<string, SessionRunTiming[]>;
  manualModelSelections: Record<string, Model | null>;
  confirmedModelSelections: Record<string, Model | null>;
  pendingModelSelectionTaskIds: Record<string, number>;
  userConfirmedSessionModelRefs: Record<string, string>;
  remoteManaged: boolean;
  pendingInteractions: CoworkInteractionRequest[];
  planModeBySession: Record<string, boolean>;
  newSessionPlanMode: boolean;
  config: CoworkConfig;
  /** Global toggle for thinking content visibility - true = expanded, false = collapsed */
  thinkingExpanded: boolean;
  /** Global toggle for tool calls visibility - true = expanded (show), false = collapsed (hide) */
  toolExpanded: boolean;
}

const initialState: CoworkState = {
  sessions: [],
  sessionDirectory: null,
  sessionListStatus: 'loading',
  groups: [],
  expandedGroupIds: [],
  currentSessionId: null,
  currentSession: null,
  draftPrompts: {},
  draftMessageQuotes: {},
  draftAttachments: {},
  draftBrowserAnnotations: {},
  draftBrowserRecordings: {},
  unreadSessionIds: [],
  isCoworkActive: false,
  isStreaming: false,
  sessionMainRuntimeActivity: {},
  sessionRuntimeActivity: {},
  sessionRunTimings: {},
  manualModelSelections: {},
  confirmedModelSelections: {},
  pendingModelSelectionTaskIds: {},
  userConfirmedSessionModelRefs: {},
  remoteManaged: false,
  pendingInteractions: [],
  planModeBySession: {},
  newSessionPlanMode: false,
  config: {
    workingDirectory: '',
    executionMode: 'local',
    agentEngine: 'openclaw',
    permissionMode: DEFAULT_PERMISSION_MODE,
    maxGoalContinuationTurns: DEFAULT_MAX_GOAL_CONTINUATION_TURNS,
    maxRetainedDisplayTabs: DEFAULT_MAX_RETAINED_DISPLAY_TABS,
  },
  thinkingExpanded: false, // Default to collapsed (浅蓝色)
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

const clearSessionModelSelectionState = (state: CoworkState, sessionId: string) => {
  const contextPrefix = `${sessionId}\0`;
  for (const contextKey of Object.keys(state.manualModelSelections)) {
    if (!contextKey.startsWith(contextPrefix)) continue;
    delete state.manualModelSelections[contextKey];
    delete state.confirmedModelSelections[contextKey];
    delete state.pendingModelSelectionTaskIds[contextKey];
  }
  delete state.userConfirmedSessionModelRefs[sessionId];
};

const updateDirectoryEntry = (
  state: CoworkState,
  sessionId: string,
  changes: Partial<SessionDirectoryEntry>,
): void => {
  const entry = state.sessionDirectory?.find(item => item.id === sessionId);
  if (entry) Object.assign(entry, changes);
};

const rememberDirectoryEntry = (state: CoworkState, session: CoworkSessionSummary): void => {
  if (!state.sessionDirectory || session.id.startsWith('temp-')) return;
  const index = state.sessionDirectory.findIndex(item => item.id === session.id);
  const entry: SessionDirectoryEntry = {
    id: session.id,
    status: session.status,
    pinned: session.pinned,
    agentId: session.agentId,
    groupId: session.groupId !== undefined ? session.groupId : state.sessionDirectory[index]?.groupId,
    source: session.source,
    external: session.external,
    nativeSessionKey: session.nativeSessionKey,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  if (index < 0) state.sessionDirectory.push(entry);
  else state.sessionDirectory[index] = entry;
};

const coworkSlice = createSlice({
  name: 'cowork',
  initialState,
  reducers: {
    setSessionDirectory(state, action: PayloadAction<SessionDirectoryEntry[]>) {
      const previous = new Map(
        (state.sessionDirectory ?? state.sessions).map(session => [session.id, session.updatedAt]),
      );
      state.sessionDirectory = action.payload.map(entry => ({
        ...entry,
        updatedAt: Math.max(entry.updatedAt, previous.get(entry.id) ?? 0),
      }));
      const directory = new Map(state.sessionDirectory.map(entry => [entry.id, entry]));
      state.sessions = state.sessions
        .filter(session => directory.has(session.id))
        .map(session => ({ ...session, ...directory.get(session.id)! }));
      const selected = state.currentSession && directory.get(state.currentSession.id);
      if (selected && state.currentSession) {
        state.currentSession.status = selected.status;
        state.currentSession.external = selected.external;
        state.currentSession.source = selected.source;
        state.currentSession.pinned = selected.pinned;
        state.currentSession.groupId = selected.groupId;
        state.currentSession.updatedAt = Math.max(
          state.currentSession.updatedAt, selected.updatedAt,
        );
      }
      state.unreadSessionIds = state.unreadSessionIds.filter(
        id => directory.has(id) && id !== state.currentSessionId,
      );
      state.sessionListStatus = 'ready';
    },

    upsertSessionSummaries(state, action: PayloadAction<CoworkSessionSummary[]>) {
      const directory = state.sessionDirectory
        ? new Map(state.sessionDirectory.map(entry => [entry.id, entry]))
        : null;
      const summaries = new Map(state.sessions.map(session => [session.id, session]));
      for (const summary of action.payload) {
        if (directory && !directory.has(summary.id)) continue;
        const previous = summaries.get(summary.id);
        summaries.set(summary.id, {
          ...previous,
          ...summary,
          ...directory?.get(summary.id),
          updatedAt: Math.max(
            summary.updatedAt,
            previous?.updatedAt ?? 0,
            directory?.get(summary.id)?.updatedAt ?? 0,
          ),
        });
      }
      state.sessions = [...summaries.values()];
    },

    setCoworkActive(state, action: PayloadAction<boolean>) {
      state.isCoworkActive = action.payload;
    },

    setSessionListStatus(state, action: PayloadAction<CoworkState['sessionListStatus']>) {
      state.sessionListStatus = action.payload;
    },

    setSessions(state, action: PayloadAction<CoworkSessionSummary[]>) {
      const activityBySessionId = new Map(
        state.sessions.map(session => [session.id, session.updatedAt]),
      );
      if (state.currentSession) {
        activityBySessionId.set(
          state.currentSession.id,
          Math.max(
            activityBySessionId.get(state.currentSession.id) ?? 0,
            state.currentSession.updatedAt,
          ),
        );
      }
      // A list read started before a live activity event can arrive after it.
      state.sessions = action.payload.map(session => ({
        ...session,
        updatedAt: Math.max(session.updatedAt, activityBySessionId.get(session.id) ?? 0),
      }));
      state.sessionListStatus = 'ready';
      if (state.currentSession) {
        const summary = state.sessions.find(session => session.id === state.currentSession?.id);
        if (summary) {
          state.currentSession.status = summary.status;
          state.currentSession.external = summary.external;
          state.currentSession.source = summary.source;
          state.currentSession.updatedAt = summary.updatedAt;
        }
      }
      const validSessionIds = new Set(action.payload.map(session => session.id));
      state.unreadSessionIds = state.unreadSessionIds.filter(id => {
        return validSessionIds.has(id) && id !== state.currentSessionId;
      });
    },

    setCurrentSessionId(state, action: PayloadAction<string | null>) {
      state.currentSessionId = action.payload;
      markSessionRead(state, action.payload);
    },

    setSessionRuntimeActivity(
      state,
      action: PayloadAction<{ sessionId: string; running: boolean }>,
    ) {
      const { sessionId, running } = action.payload;
      const directoryEntry = state.sessionDirectory?.find(item => item.id === sessionId);
      if (directoryEntry && (running || directoryEntry.status === 'running')) {
        directoryEntry.status = running ? 'running' : 'idle';
      }
      if (running) {
        state.sessionRuntimeActivity[sessionId] = true;
        const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
        if (sessionIndex !== -1) {
          state.sessions[sessionIndex].status = 'running';
        }
        if (state.currentSession?.id === sessionId) {
          state.currentSession.status = 'running';
        }
      } else {
        delete state.sessionRuntimeActivity[sessionId];
        const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
        if (sessionIndex !== -1 && state.sessions[sessionIndex].status === 'running') {
          state.sessions[sessionIndex].status = 'idle';
        }
        if (state.currentSession?.id === sessionId && state.currentSession.status === 'running') {
          state.currentSession.status = 'idle';
        }
      }
    },

    setSessionMainRuntimeActivity(
      state,
      action: PayloadAction<{ sessionId: string; running: boolean }>,
    ) {
      const { sessionId, running } = action.payload;
      if (running) {
        state.sessionMainRuntimeActivity[sessionId] = true;
      } else {
        delete state.sessionMainRuntimeActivity[sessionId];
      }
      if (state.currentSessionId === sessionId) {
        state.isStreaming = running;
      }
    },

    setSessionRuntimeActivities(state, action: PayloadAction<Record<string, boolean>>) {
      state.sessionRuntimeActivity = action.payload;
      if (state.currentSessionId?.startsWith('temp-')) {
        return;
      }
    },

    setCurrentSession(state, action: PayloadAction<CoworkSession | null>) {
      const incomingSession = action.payload;
      const userConfirmedModelRef = incomingSession
        ? state.userConfirmedSessionModelRefs[incomingSession.id]
        : undefined;
      const preservedModelRef =
        incomingSession?.modelRef ??
        userConfirmedModelRef ??
        (incomingSession && state.currentSession?.id === incomingSession.id
          ? state.currentSession.modelRef
          : undefined);
      const nextSession = incomingSession
        ? {
            ...incomingSession,
            ...(preservedModelRef ? { modelRef: preservedModelRef } : {}),
            updatedAt: Math.max(
              incomingSession.updatedAt,
              state.sessionDirectory?.find(session => session.id === incomingSession.id)?.updatedAt ?? 0,
              state.sessions.find(session => session.id === incomingSession.id)?.updatedAt ?? 0,
              state.currentSession?.id === incomingSession.id ? state.currentSession.updatedAt : 0,
            ),
          }
        : null;
      state.currentSession = nextSession;
      if (nextSession) {
        // Fresh selected-model reads supersede completed optimistic selections.
        // In-flight choices stay visible until their ordered mutation completes.
        if (incomingSession?.modelRef) {
          const contextKey = `${nextSession.id}\0${nextSession.agentId || 'main'}`;
          if (state.pendingModelSelectionTaskIds[contextKey] === undefined) {
            delete state.manualModelSelections[contextKey];
            delete state.confirmedModelSelections[contextKey];
            state.userConfirmedSessionModelRefs[nextSession.id] = incomingSession.modelRef;
          }
        }
        state.currentSessionId = nextSession.id;
        if (!nextSession.id.startsWith('temp-')) {
          const { id, title, status, pinned, agentId, external, source, createdAt, updatedAt } =
            nextSession;
          const summary: CoworkSessionSummary = {
            id,
            title,
            status,
            pinned: pinned ?? false,
            agentId,
            groupId: nextSession.groupId,
            nativeSessionKey: nextSession.nativeSessionKey,
            historyBinding: nextSession.historyBinding,
            external,
            source,
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
        rememberDirectoryEntry(state, nextSession);
        markSessionRead(state, nextSession.id);
      }
    },

    addDraftMessageQuote(state, action: PayloadAction<{ draftKey: string; quote: MessageQuote }>) {
      const { draftKey, quote } = action.payload;
      const quotes = state.draftMessageQuotes[draftKey] ?? [];
      if (quotes.length >= 8 || !quote.text.trim()) return;
      if (
        quote.kind === MESSAGE_QUOTE_KIND.EXTENSION &&
        (!/^[a-z][a-z0-9-]{0,95}$/u.test(quote.pluginId) ||
          (quote.labelKey !== undefined &&
            (typeof quote.labelKey !== 'string' || quote.labelKey.length > 128)) ||
          typeof quote.context !== 'string' ||
          quote.context.length > 8192)
      )
        return;
      if (quote.kind === MESSAGE_QUOTE_KIND.DISCUSSION) {
        if (
          !quote.roomId ||
          !quote.discussionId ||
          quotes.some(
            item =>
              item.kind === MESSAGE_QUOTE_KIND.DISCUSSION &&
              item.roomId === quote.roomId &&
              item.discussionId === quote.discussionId,
          )
        )
          return;
      } else if (quote.kind === MESSAGE_QUOTE_KIND.COLLABORATION) {
        if (
          !validCollaborationQuote(quote) ||
          quote.sourceSessionId !== draftKey ||
          quotes.some(
            item =>
              item.kind === MESSAGE_QUOTE_KIND.COLLABORATION &&
              item.roomId === quote.roomId &&
              item.targetSessionKey === quote.targetSessionKey &&
              item.priorRoundId === quote.priorRoundId &&
              item.deliveryId === quote.deliveryId,
          )
        )
          return;
      } else if (quote.kind !== MESSAGE_QUOTE_KIND.EXTENSION && !quote.sessionKey) return;
      state.draftMessageQuotes[draftKey] = [
        ...quotes,
        { ...quote, text: quote.text.slice(0, 12_000) },
      ];
    },
    removeDraftMessageQuotes(state, action: PayloadAction<{ draftKey: string; ids?: string[] }>) {
      const { draftKey, ids } = action.payload;
      if (!ids) {
        delete state.draftMessageQuotes[draftKey];
        return;
      }
      state.draftMessageQuotes[draftKey] = (state.draftMessageQuotes[draftKey] ?? []).filter(
        quote => !ids.includes(quote.id),
      );
    },

    setDraftPrompt(state, action: PayloadAction<{ sessionId: string; draft: string }>) {
      const { sessionId, draft } = action.payload;
      if (draft) {
        state.draftPrompts[sessionId] = draft;
      } else {
        delete state.draftPrompts[sessionId];
      }
    },

    addSession(state, action: PayloadAction<{ session: CoworkSession; select: boolean }>) {
      const { session, select } = action.payload;
      const summary: CoworkSessionSummary = {
        nativeSessionKey: session.nativeSessionKey,
        historyBinding: session.historyBinding,
        id: session.id,
        title: session.title,
        status: session.status,
        pinned: session.pinned ?? false,
        agentId: session.agentId,
        groupId: session.groupId,
        external: session.external,
        source: session.source,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
      // sessions.changed can refresh the authoritative list before the
      // startSession IPC resolves. Treat admission as an upsert so that race
      // cannot insert the same canonical session a second time.
      state.sessions = [summary, ...state.sessions.filter(item => item.id !== session.id)];
      rememberDirectoryEntry(state, summary);
      if (select) {
        state.currentSession = session;
        state.currentSessionId = session.id;
        markSessionRead(state, session.id);
      }
    },

    updateSessionStatus(
      state,
      action: PayloadAction<{ sessionId: string; status: CoworkSessionStatus }>,
    ) {
      const { sessionId, status } = action.payload;
      updateDirectoryEntry(state, sessionId, { status });

      // Update in sessions list
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].status = status;
      }

      // Update current session if applicable
      if (state.currentSession?.id === sessionId) {
        state.currentSession.status = status;
      }
    },

    deleteSession(state, action: PayloadAction<string>) {
      removeSessionFromState(state, action.payload);
      clearSessionModelSelectionState(state, action.payload);
      delete state.planModeBySession[action.payload];
      state.pendingInteractions = state.pendingInteractions.filter(
        interaction => interaction.sessionId !== action.payload,
      );
      delete state.draftMessageQuotes[action.payload];
      delete state.draftBrowserAnnotations[action.payload];
      delete state.draftBrowserRecordings[action.payload];
    },

    deleteSessions(state, action: PayloadAction<string[]>) {
      removeSessionsFromState(state, action.payload);
      for (const sessionId of action.payload) {
        clearSessionModelSelectionState(state, sessionId);
        delete state.planModeBySession[sessionId];
        delete state.draftMessageQuotes[sessionId];
        delete state.draftBrowserAnnotations[sessionId];
        delete state.draftBrowserRecordings[sessionId];
      }
      const deletedSessionIds = new Set(action.payload);
      state.pendingInteractions = state.pendingInteractions.filter(
        interaction => !deletedSessionIds.has(interaction.sessionId),
      );
    },

    touchSessionActivity(state, action: PayloadAction<{ sessionId: string; timestamp: number }>) {
      const { sessionId, timestamp } = action.payload;
      const directoryEntry = state.sessionDirectory?.find(item => item.id === sessionId);
      if (directoryEntry) directoryEntry.updatedAt = Math.max(directoryEntry.updatedAt, timestamp);
      if (state.currentSession?.id === sessionId) {
        state.currentSession.updatedAt = Math.max(state.currentSession.updatedAt, timestamp);
      }
      const session = state.sessions.find(item => item.id === sessionId);
      if (session) session.updatedAt = Math.max(session.updatedAt, timestamp);
      markSessionUnread(state, sessionId);
    },

    setStreaming(state, action: PayloadAction<boolean>) {
      state.isStreaming = action.payload;
    },

    setRemoteManaged(state, action: PayloadAction<boolean>) {
      state.remoteManaged = action.payload;
    },

    updateSessionPinned(state, action: PayloadAction<{ sessionId: string; pinned: boolean }>) {
      const { sessionId, pinned } = action.payload;
      updateDirectoryEntry(state, sessionId, { pinned });
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
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.title = title;
      }
      if (state.currentSession?.forkSource?.sessionId === sessionId) {
        state.currentSession.forkSource.title = title;
      }
    },

    enqueuePendingInteraction(state, action: PayloadAction<CoworkInteractionRequest>) {
      const alreadyQueued = state.pendingInteractions.some(
        interaction => interaction.requestId === action.payload.requestId,
      );
      if (alreadyQueued) return;
      state.pendingInteractions.push(action.payload);
    },

    dequeuePendingInteraction(state, action: PayloadAction<{ requestId?: string } | undefined>) {
      const requestId = action.payload?.requestId;
      if (!requestId) {
        state.pendingInteractions.shift();
        return;
      }
      state.pendingInteractions = state.pendingInteractions.filter(
        interaction => interaction.requestId !== requestId,
      );
    },

    clearPendingInteractions(state) {
      state.pendingInteractions = [];
    },

    setPlanMode(
      state,
      action: PayloadAction<{ enabled: boolean; sessionId?: string; promoteFrom?: string }>,
    ) {
      const { enabled, sessionId, promoteFrom } = action.payload;
      if (promoteFrom) delete state.planModeBySession[promoteFrom];
      if (sessionId) state.planModeBySession[sessionId] = enabled;
      else state.newSessionPlanMode = enabled;
    },

    setConfig(state, action: PayloadAction<CoworkConfig>) {
      state.config = action.payload;
    },

    updateConfig(state, action: PayloadAction<Partial<CoworkConfig>>) {
      state.config = { ...state.config, ...action.payload };
    },

    updateCurrentSessionPermissionMode(
      state,
      action: PayloadAction<{ sessionId: string; permissionMode: PermissionMode }>,
    ) {
      if (state.currentSession?.id === action.payload.sessionId) {
        state.currentSession.permissionMode = action.payload.permissionMode;
      }
    },

    setSessionRuntimeSnapshot(
      state,
      action: PayloadAction<{ sessionId: string; snapshot: SessionRuntimeSnapshot }>,
    ) {
      const { sessionId, snapshot } = action.payload;
      if (snapshot.mainRunning) state.sessionMainRuntimeActivity[sessionId] = true;
      // Unconfirmed admission/Stop cannot retire the last known main activity.
      else if (snapshot.known) delete state.sessionMainRuntimeActivity[sessionId];
      const running =
        snapshot.running ||
        state.sessionMainRuntimeActivity[sessionId] === true ||
        (!snapshot.known && state.sessionRuntimeActivity[sessionId] === true);
      if (running) state.sessionRuntimeActivity[sessionId] = true;
      else delete state.sessionRuntimeActivity[sessionId];
      if (snapshot.timing) {
        const timings = state.sessionRunTimings[sessionId] ?? [];
        const index = timings.findIndex(timing => timing.id === snapshot.timing!.id);
        if (index >= 0) timings[index] = snapshot.timing;
        else timings.push(snapshot.timing);
        state.sessionRunTimings[sessionId] = timings;
      }
      const status = running ? 'running' : snapshot.timing?.state === 'failed' ? 'error' : 'idle';
      updateDirectoryEntry(state, sessionId, { status });
      const sessionIndex = state.sessions.findIndex(session => session.id === sessionId);
      if (sessionIndex >= 0) state.sessions[sessionIndex].status = status;
      if (state.currentSession?.id === sessionId) {
        state.currentSession.status = status;
        state.isStreaming = state.sessionMainRuntimeActivity[sessionId] === true;
      }
    },

    setSessionRunTimings(
      state,
      action: PayloadAction<{ sessionId: string; timings: SessionRunTiming[] }>,
    ) {
      const existing = state.sessionRunTimings[action.payload.sessionId] ?? [];
      const merged = new Map(existing.map(timing => [timing.id, timing]));
      for (const timing of action.payload.timings) merged.set(timing.id, timing);
      state.sessionRunTimings[action.payload.sessionId] = [...merged.values()].sort(
        (left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id),
      );
    },

    upsertSessionRunTiming(
      state,
      action: PayloadAction<{ sessionId: string; timing: SessionRunTiming }>,
    ) {
      const timings = state.sessionRunTimings[action.payload.sessionId] ?? [];
      const index = timings.findIndex(timing => timing.id === action.payload.timing.id);
      if (index >= 0) timings[index] = action.payload.timing;
      else timings.push(action.payload.timing);
      timings.sort(
        (left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id),
      );
      state.sessionRunTimings[action.payload.sessionId] = timings;
    },

    beginManualModelSelection(
      state,
      action: PayloadAction<{
        contextKey: string;
        taskId: number;
        model: Model;
        previousModel: Model | null;
      }>,
    ) {
      const { contextKey, taskId, model, previousModel } = action.payload;
      // A session switch can start saving its default after a newer home
      // selection has already been queued. Keep the latest user's intent.
      if ((state.pendingModelSelectionTaskIds[contextKey] ?? -1) > taskId) return;
      if (!Object.prototype.hasOwnProperty.call(state.confirmedModelSelections, contextKey)) {
        state.confirmedModelSelections[contextKey] = previousModel;
      }
      state.manualModelSelections[contextKey] = model;
      state.pendingModelSelectionTaskIds[contextKey] = taskId;
    },

    confirmManualModelSelection(
      state,
      action: PayloadAction<{ contextKey: string; taskId: number; model: Model }>,
    ) {
      const { contextKey, taskId, model } = action.payload;
      state.confirmedModelSelections[contextKey] = model;
      if (state.pendingModelSelectionTaskIds[contextKey] === taskId) {
        state.manualModelSelections[contextKey] = model;
      }
    },

    confirmDefaultModelSelection(
      state,
      action: PayloadAction<{ contextKey: string; model: Model }>,
    ) {
      const { contextKey, model } = action.payload;
      state.confirmedModelSelections[contextKey] = model;
      if (state.pendingModelSelectionTaskIds[contextKey] === undefined) {
        delete state.manualModelSelections[contextKey];
        delete state.confirmedModelSelections[contextKey];
      }
    },

    completeManualModelSelection(
      state,
      action: PayloadAction<{ contextKey: string; taskId: number }>,
    ) {
      const { contextKey, taskId } = action.payload;
      if (state.pendingModelSelectionTaskIds[contextKey] === taskId) {
        delete state.pendingModelSelectionTaskIds[contextKey];
        delete state.manualModelSelections[contextKey];
        delete state.confirmedModelSelections[contextKey];
      }
    },

    rollbackManualModelSelection(
      state,
      action: PayloadAction<{ contextKey: string; taskId: number }>,
    ) {
      const { contextKey, taskId } = action.payload;
      if (state.pendingModelSelectionTaskIds[contextKey] !== taskId) return;
      // Successful mutations already update the session/default source of truth.
      // A failed choice must not leave a permanent override of that source.
      delete state.manualModelSelections[contextKey];
      delete state.confirmedModelSelections[contextKey];
      delete state.pendingModelSelectionTaskIds[contextKey];
    },

    confirmCurrentSessionModelSelection(
      state,
      action: PayloadAction<{ sessionId: string; modelRef: string }>,
    ) {
      state.userConfirmedSessionModelRefs[action.payload.sessionId] = action.payload.modelRef;
      if (state.currentSession?.id === action.payload.sessionId) {
        state.currentSession.modelRef = action.payload.modelRef;
      }
    },

    receiveSessionModelSelection(
      state,
      action: PayloadAction<{ sessionId: string; agentId: string; modelRef: string }>,
    ) {
      const { sessionId, agentId, modelRef } = action.payload;
      const contextKey = `${sessionId}\0${agentId}`;
      if (state.pendingModelSelectionTaskIds[contextKey] !== undefined) return;
      delete state.manualModelSelections[contextKey];
      delete state.confirmedModelSelections[contextKey];
      state.userConfirmedSessionModelRefs[sessionId] = modelRef;
      if (state.currentSession?.id === sessionId) state.currentSession.modelRef = modelRef;
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

    hydrateDraftImageAttachment(
      state,
      action: PayloadAction<{ draftKey: string; path: string; dataUrl: string }>,
    ) {
      const { draftKey, path, dataUrl } = action.payload;
      const attachment = state.draftAttachments[draftKey]?.find(item => item.path === path);
      if (!attachment) return;
      attachment.isImage = true;
      attachment.dataUrl = dataUrl;
    },

    clearDraftAttachments(state, action: PayloadAction<string>) {
      delete state.draftAttachments[action.payload];
    },

    setDraftBrowserRecording(
      state,
      action: PayloadAction<{ draftKey: string; recording: BrowserRecordingDraft }>,
    ) {
      const { draftKey, recording } = action.payload;
      const existing = state.draftBrowserRecordings[draftKey];
      if (!existing || existing.id === recording.id)
        state.draftBrowserRecordings[draftKey] = recording;
    },
    removeDraftBrowserRecording(
      state,
      action: PayloadAction<{
        draftKey: string;
        id: string;
        expectedRecording?: BrowserRecordingDraft;
      }>,
    ) {
      const { draftKey, id, expectedRecording } = action.payload;
      // Compare against the immutable source, not Immer's proxy. A save while
      // submission is pending creates a new object even when its id is unchanged.
      if (
        expectedRecording &&
        original(state)?.draftBrowserRecordings[draftKey] !== expectedRecording
      )
        return;
      if (state.draftBrowserRecordings[draftKey]?.id === id) {
        delete state.draftBrowserRecordings[draftKey];
      }
    },
    addDraftBrowserAnnotation(
      state,
      action: PayloadAction<{ draftKey: string; annotation: BrowserAnnotationDraft }>,
    ) {
      const { draftKey, annotation } = action.payload;
      const existing = state.draftBrowserAnnotations[draftKey] ?? [];
      if (existing.some(item => item.id === annotation.id)) return;
      state.draftBrowserAnnotations[draftKey] = [...existing, annotation];
    },

    removeDraftBrowserAnnotation(
      state,
      action: PayloadAction<{ draftKey: string; annotationId: string }>,
    ) {
      const { draftKey, annotationId } = action.payload;
      const remaining = (state.draftBrowserAnnotations[draftKey] ?? []).filter(
        item => item.id !== annotationId,
      );
      if (remaining.length) state.draftBrowserAnnotations[draftKey] = remaining;
      else delete state.draftBrowserAnnotations[draftKey];
    },

    clearDraftBrowserAnnotations(
      state,
      action: PayloadAction<{ draftKey: string; annotationIds?: string[] }>,
    ) {
      const { draftKey, annotationIds } = action.payload;
      if (!annotationIds) {
        delete state.draftBrowserAnnotations[draftKey];
        return;
      }
      const submittedIds = new Set(annotationIds);
      const remaining = (state.draftBrowserAnnotations[draftKey] ?? []).filter(
        annotation => !submittedIds.has(annotation.id),
      );
      if (remaining.length) state.draftBrowserAnnotations[draftKey] = remaining;
      else delete state.draftBrowserAnnotations[draftKey];
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
      for (const entry of state.sessionDirectory ?? []) {
        if (entry.groupId === groupId) entry.groupId = null;
      }
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
      updateDirectoryEntry(state, sessionId, { groupId });
      if (state.currentSession?.id === sessionId) state.currentSession.groupId = groupId;
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
  setSessionDirectory,
  upsertSessionSummaries,
  setSessionListStatus,
  setCoworkActive,
  setSessions,
  setCurrentSessionId,
  setCurrentSession,
  setSessionMainRuntimeActivity,
  setSessionRuntimeActivity,
  setSessionRuntimeSnapshot,
  setSessionRunTimings,
  upsertSessionRunTiming,
  setSessionRuntimeActivities,
  setDraftPrompt,
  addDraftMessageQuote,
  removeDraftMessageQuotes,
  setDraftAttachments,
  addDraftAttachment,
  hydrateDraftImageAttachment,
  clearDraftAttachments,
  addDraftBrowserAnnotation,
  setDraftBrowserRecording,
  removeDraftBrowserRecording,
  removeDraftBrowserAnnotation,
  clearDraftBrowserAnnotations,
  addSession,
  updateSessionStatus,
  deleteSession,
  deleteSessions,
  touchSessionActivity,
  setStreaming,
  setRemoteManaged,
  updateSessionPinned,
  updateSessionTitle,
  updateCurrentSessionPermissionMode,
  beginManualModelSelection,
  confirmManualModelSelection,
  confirmDefaultModelSelection,
  completeManualModelSelection,
  rollbackManualModelSelection,
  confirmCurrentSessionModelSelection,
  receiveSessionModelSelection,
  enqueuePendingInteraction,
  dequeuePendingInteraction,
  clearPendingInteractions,
  setPlanMode,
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
