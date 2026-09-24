import { getTranscriptMedia, isTranscriptImage } from '@/libs/openclaw-chat/attachments';
import {
  CHAT_HISTORY_INITIAL_LIMIT,
  CHAT_HISTORY_MAX_CHARS,
  CHAT_HISTORY_OLDER_PAGE_LIMIT,
  type ChatHistoryPage,
  decodeHistoryOffsetCursor,
  hydrateTruncatedHistoryMessages,
  parseChatHistoryPage,
} from '@/libs/openclaw-chat/gateway/chat-history-protocol';
import {
  confirmRecoveredToolSequence,
  hydrateToolPrecedingSegments,
} from '@/libs/openclaw-chat/model/agent-event-reducer';
import {
  type HistorySource,
  normalizeTranscriptSessionKey,
  type ToolItem,
  type TranscriptReducerDependencies,
} from '@/libs/openclaw-chat/model/chat-transcript-state';
import { ChunkedMessageHistory } from '@/libs/openclaw-chat/model/chunked-message-history';
import { parseEditorDraftPayload } from '@/libs/openclaw-chat/model/editor-draft';
import { reconcileHistory } from '@/libs/openclaw-chat/model/history-reconciler';
import {
  latestHistoryWindow,
  shiftHistoryWindowNewer,
  shiftHistoryWindowOlder,
} from '@/libs/openclaw-chat/model/history-window';
import {
  isLocallyOptimisticHistoryTail,
  retireSettledActiveTurn,
} from '@/libs/openclaw-chat/model/optimistic-history-tail';
import { isPendingUserMessageMatch } from '@/libs/openclaw-chat/model/optimistic-user-message';
import { projectPersistedTimeline } from '@/libs/openclaw-chat/model/project-history-timeline';
import { type RunProgressStage } from '@/libs/openclaw-chat/model/run-activity';
import {
  hasToolResultPayload,
  isSessionsYieldTool,
} from '@/libs/openclaw-chat/model/tool-lifecycle';
import { isEntryAfterLatestPlanImplementationReset } from '@/libs/openclaw-chat/model/transcript-identity';
import {
  hydrateGatewayHistoryForDisplay,
  projectGatewayHistoryForDisplay,
  shouldHideMessage,
} from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import {
  asRecord,
  ChatHistorySnapshot,
  ChatState,
  ChatStreamUpdateKind,
  debugLog,
  getContentImageUrl,
  getImageUrlIdentity,
  InFlightRunSnapshot,
  LocalCompactionStatus,
  mergeRefreshedHistoryWindow,
  normalizeSessionId,
  precedingSegmentsByToolCallId,
  readExplicitMessageRunId,
  readLatestOpenClawMessageSeq,
  RewindEditorDraft,
  sliceActiveSubagentHistoryPrefix,
  summarizeHistoryForDebug,
  toolResultCallIds,
} from './chat-controller-support';
export interface ChatControllerHistoryContext {
  readonly currentMessageHistory: ChunkedMessageHistory;
  readonly state: ChatState;
  readonly cacheSessionMessages: (sessionKey: string, history?: ChunkedMessageHistory) => void;
  readonly transcriptDependencies: TranscriptReducerDependencies;
  readonly updateRunActivity: (
    runId: string,
    stage: RunProgressStage,
    options?: {
      modelActivity?: boolean;
      provider?: string;
      model?: string;
      retryReason?: unknown;
      at?: number;
    },
  ) => void;
  readonly notifyStream: (kind?: ChatStreamUpdateKind) => void;
  readonly notify: () => void;
  readonly historyPaginationBySession: Map<
    string,
    { hasMore: boolean; nextCursor: string | null; advanced: boolean }
  >;
  historyPaginationAdvanced: boolean;
  readonly applyHistoryWindow: (window: { start: number; end: number }) => boolean;
  readonly loadOlderHistory: () => Promise<boolean>;
  newerHistoryNavigationRevision: number;
  readonly chatMessagesBySession: Map<string, ChunkedMessageHistory>;
  readonly historySourceBySession: Map<string, HistorySource>;
  readonly displayedHistoryLeafBySession: Map<string, string | null>;
  historyPagingGeneration: number;
  readonly resetHistoryPagination: (sessionKey: string) => void;
  readonly resetTranscriptForSession: (
    sessionKey: string,
    sessionId: string | null,
    preserveTiming?: boolean,
  ) => void;
  readonly setCurrentSessionMessages: (
    messages: unknown[],
    options?: { resetLoadedHistory?: boolean },
  ) => void;
  readonly loadHistory: (
    queueIfBusy?: boolean,
    options?: {
      preferStartup?: boolean;
      reconcileSuspended?: boolean;
      backfillActiveSessionsYield?: boolean;
    },
  ) => Promise<boolean>;
  readonly scheduleDeferredHistoryReload: (sessionKey: string, reason: string) => void;
  readonly transcriptImageCache: Map<string, Promise<string | null>>;
  transcriptImageReadsActive: number;
  readonly transcriptImageReadWaiters: (() => void)[];
  readonly resolveTranscriptImageUrl: (
    mediaPath: string,
    sessionKey: string,
  ) => Promise<string | null>;
  readonly resolveManagedHistoryImages: (
    messages: unknown[],
    sessionKey: string,
  ) => Promise<unknown[]>;
  readonly enrichCompactionMarkers: (
    messages: unknown[],
    sessionKey?: string,
  ) => Promise<unknown[]>;
  readonly loadOlderHistoryPage: (sessionKey: string, cursor: string) => Promise<ChatHistoryPage>;
  readonly normalizeHistoryPage: (messages: unknown[], sessionKey: string) => Promise<unknown[]>;
  readonly findExpectedInitialHistoryIndex: (messages: readonly unknown[]) => number;
  readonly expectInitialHistory: boolean;
  readonly rememberHistoryPagination: (sessionKey: string) => void;
  readonly ensureTranscriptSessionIdentity: () => void;
  readonly historyLoadsInFlight: Set<string>;
  readonly historyReloadRequested: Set<string>;
  readonly immediateHistoryReloadRequested: Set<string>;
  readonly _snap: () => Record<string, unknown>;
  historyLoadSeq: number;
  readonly applySessionContextUsage: (value: unknown, sessionKey: string) => boolean;
  readonly projectLocalCompactionStatus: (sessionKey: string, messages: unknown[]) => unknown[];
  readonly recordLoadedSessionMessageSeq: (
    sessionKey: string,
    sessionId: string | null,
    loadedSeq: number | null,
    resolvePendingCatchUp: boolean,
  ) => void;
  readonly hydrateActiveToolItemsFromHistory: (
    messages: unknown[],
    options?: { backfillMissingSessionsYield?: boolean; backfillMissingToolsFromAppend?: boolean },
  ) => boolean;
  readonly publishActiveToolHistoryRepair: () => void;
  readonly applyInFlightRunSnapshot: (
    snapshot: InFlightRunSnapshot | undefined,
    sessionKey: string,
    sessionId: string | null,
    requestRunId: string | null,
    sessionInfo: ChatHistorySnapshot['sessionInfo'],
  ) => void;
  readonly rememberRunModel: (message: unknown, runId?: string | null, terminal?: boolean) => void;
  readonly localCompactionStatusBySession: Map<string, LocalCompactionStatus>;
  readonly deferredHistoryReloadAttempts: Map<string, number>;
  readonly hydrateCurrentSessionImages: (messages: unknown[], sessionKey: string) => void;
}

export function setCurrentSessionMessages(
  this: ChatControllerHistoryContext,
  messages: unknown[],
  options: { resetLoadedHistory?: boolean } = {},
): void {
  if (options.resetLoadedHistory) {
    this.currentMessageHistory.reset(messages);
    const nextWindow = latestHistoryWindow(messages.length);
    this.state.chatMessages = messages;
    this.state.loadedMessageCount = messages.length;
    this.state.historyWindowStart = nextWindow.start;
    this.state.historyWindowEnd = nextWindow.end;
    this.state.visibleChatMessages = this.currentMessageHistory.slice(
      nextWindow.start,
      nextWindow.end,
    );
    this.state.transcript.persistedMessages = messages;
    retireSettledActiveTurn(this.state.transcript, messages);
    this.cacheSessionMessages(this.state.sessionKey);
    return;
  }
  const previousMessages = this.state.chatMessages;
  if (this.currentMessageHistory.recentMessages !== previousMessages) {
    this.currentMessageHistory.reset(previousMessages);
  }
  const previousTotal = this.currentMessageHistory.length;
  const wasAtLatest = this.state.historyWindowEnd >= previousTotal;
  this.currentMessageHistory.replaceRecent(messages);
  const nextTotal = this.currentMessageHistory.length;
  const nextWindow = wasAtLatest
    ? latestHistoryWindow(nextTotal)
    : {
        start: Math.min(this.state.historyWindowStart, nextTotal),
        end: Math.min(this.state.historyWindowEnd, nextTotal),
      };
  this.state.chatMessages = messages;
  this.state.loadedMessageCount = nextTotal;
  this.state.historyWindowStart = nextWindow.start;
  this.state.historyWindowEnd = nextWindow.end;
  this.state.visibleChatMessages = this.currentMessageHistory.slice(
    nextWindow.start,
    nextWindow.end,
  );
  this.state.transcript.persistedMessages = messages;
  retireSettledActiveTurn(this.state.transcript, messages);
  this.cacheSessionMessages(this.state.sessionKey);
}

export function hydrateActiveToolItemsFromHistory(
  this: ChatControllerHistoryContext,
  messages: unknown[],
  options: {
    backfillMissingSessionsYield?: boolean;
    backfillMissingToolsFromAppend?: boolean;
  } = {},
): boolean {
  const activeTurn = this.state.transcript.activeTurn;
  if (!activeTurn) return false;

  const activeRunMessages = messages.filter(message => {
    const explicitRunId = readExplicitMessageRunId(message);
    return !explicitRunId || explicitRunId === activeTurn.runId;
  });
  const persistedTools = new Map<string, ToolItem>(
    projectPersistedTimeline(activeRunMessages as GatewayMessage[])
      .flatMap(item =>
        item.kind === 'process-summary'
          ? item.items.filter(process => process.type === 'tool')
          : item.kind === 'live-process' && item.item.type === 'tool'
            ? [item.item]
            : item.kind === 'progress-receipt'
              ? [item.item]
              : item.kind === 'plan-presentation'
                ? [item.item]
                : [],
      )
      .map(tool => [tool.toolCallId, tool] as const),
  );
  const authoritativeSegmentsByToolId = precedingSegmentsByToolCallId(activeRunMessages);
  const authoritativeToolResultIds = toolResultCallIds(activeRunMessages);
  let changed = false;
  for (const [toolCallId, persistedTool] of persistedTools) {
    let liveTool = activeTurn.toolById.get(toolCallId);
    if (!liveTool) {
      const timestampMatchesActiveTurn =
        persistedTool.startedAt > 0 && persistedTool.startedAt >= activeTurn.startedAt;
      const canBackfillMissingTool =
        options.backfillMissingToolsFromAppend === true ||
        (options.backfillMissingSessionsYield === true && isSessionsYieldTool(persistedTool.name));
      if (
        !canBackfillMissingTool ||
        activeTurn.status !== 'running' ||
        !this.state.chatSending ||
        !timestampMatchesActiveTurn
      ) {
        continue;
      }
      const now = this.transcriptDependencies.now();
      const startedAt = persistedTool.startedAt > 0 ? persistedTool.startedAt : now;
      liveTool = {
        ...persistedTool,
        id: this.transcriptDependencies.createId('history-tool'),
        runId: activeTurn.runId,
        firstSeq: activeTurn.lastAgentSeq,
        lastSeq: activeTurn.lastAgentSeq,
        startedAt,
        updatedAt: Math.max(startedAt, persistedTool.updatedAt || now),
        agentSequencePending: true,
        agentSequenceUnconfirmed: true,
      };
      // A transcript append can beat the corresponding Thinking and Tool
      // Agent frames across their independent delivery paths. Every restored
      // Tool starts as a live-tail boundary, even when the first observed row
      // is already terminal; terminal evidence below releases it immediately.
      activeTurn.items.push(liveTool);
      activeTurn.toolById.set(toolCallId, liveTool);
      changed = true;
    }
    const authoritativeSegments = authoritativeSegmentsByToolId.get(toolCallId);
    if (authoritativeSegments) {
      changed =
        hydrateToolPrecedingSegments(
          activeTurn,
          liveTool,
          authoritativeSegments,
          activeTurn.lastAgentSeq,
          persistedTool.updatedAt || this.transcriptDependencies.now(),
          this.transcriptDependencies,
        ) || changed;
    }
    if (liveTool.input === undefined && persistedTool.input !== undefined) {
      liveTool.input = persistedTool.input;
      changed = true;
    }
    if (liveTool.output === undefined && persistedTool.output !== undefined) {
      liveTool.output = persistedTool.output;
      changed = true;
    }
    if (liveTool.error === undefined && persistedTool.error !== undefined) {
      liveTool.error = persistedTool.error;
      changed = true;
    }
    const canApplyPersistedTerminalStatus =
      persistedTool.status !== 'running' &&
      (!isSessionsYieldTool(liveTool.name) ||
        hasToolResultPayload(persistedTool) ||
        persistedTool.status !== 'completed');
    if (liveTool.agentSequenceUnconfirmed === true && authoritativeToolResultIds.has(toolCallId)) {
      const completedAt = persistedTool.updatedAt || persistedTool.startedAt;
      if (liveTool.historyCompletedAt !== completedAt) {
        liveTool.historyCompletedAt = completedAt;
        changed = true;
      }
    }
    if (
      liveTool.agentSequencePending === true &&
      (authoritativeToolResultIds.has(toolCallId) || canApplyPersistedTerminalStatus)
    ) {
      changed =
        confirmRecoveredToolSequence(
          activeTurn,
          liveTool,
          activeTurn.lastAgentSeq,
          persistedTool.updatedAt || this.transcriptDependencies.now(),
          'history',
        ) || changed;
    }
    if (liveTool.status === 'running' && canApplyPersistedTerminalStatus) {
      liveTool.status = persistedTool.status;
      changed = true;
    }
  }
  if (changed) this.state.transcript.revision += 1;
  return changed;
}

export function publishActiveToolHistoryRepair(this: ChatControllerHistoryContext): void {
  const activeTurn = this.state.transcript.activeTurn;
  if (!activeTurn) return;
  const hasRunningTool = [...activeTurn.toolById.values()].some(tool => tool.status === 'running');
  this.updateRunActivity(activeTurn.runId, hasRunningTool ? 'running-tool' : 'waiting-model');
  // Tool starts and terminal history rows must bypass streaming throttling
  // so the repaired card and its waiting status change appear together.
  this.notifyStream('terminal');
}

export function applyHistoryWindow(
  this: ChatControllerHistoryContext,
  window: { start: number; end: number },
): boolean {
  if (
    window.start === this.state.historyWindowStart &&
    window.end === this.state.historyWindowEnd
  ) {
    return false;
  }
  this.state.historyWindowStart = window.start;
  this.state.historyWindowEnd = window.end;
  this.state.visibleChatMessages = this.currentMessageHistory.slice(window.start, window.end);
  this.state.transcript.revision += 1;
  this.notify();
  return true;
}

export function rememberHistoryPagination(
  this: ChatControllerHistoryContext,
  sessionKey: string,
): void {
  if (!sessionKey) return;
  this.historyPaginationBySession.set(sessionKey, {
    hasMore: this.state.historyHasMore,
    nextCursor: this.state.historyNextCursor,
    advanced: this.historyPaginationAdvanced,
  });
}

export function restoreHistoryPagination(
  this: ChatControllerHistoryContext,
  sessionKey: string,
): void {
  const cached = this.historyPaginationBySession.get(sessionKey);
  this.historyPaginationAdvanced = cached?.advanced ?? false;
  this.state.historyHasMore = cached?.hasMore ?? false;
  this.state.historyNextCursor = cached?.nextCursor ?? null;
}

export function resetHistoryPagination(
  this: ChatControllerHistoryContext,
  sessionKey: string,
): void {
  this.historyPaginationAdvanced = false;
  this.state.historyHasMore = false;
  this.state.historyNextCursor = null;
  if (sessionKey) this.historyPaginationBySession.delete(sessionKey);
}

export async function showOlderHistory(this: ChatControllerHistoryContext): Promise<boolean> {
  const shifted = shiftHistoryWindowOlder(
    {
      start: this.state.historyWindowStart,
      end: this.state.historyWindowEnd,
    },
    this.currentMessageHistory.length,
  );
  if (this.applyHistoryWindow(shifted)) return true;
  return this.loadOlderHistory();
}

export function showNewerHistory(this: ChatControllerHistoryContext): boolean {
  this.newerHistoryNavigationRevision += 1;
  return this.applyHistoryWindow(
    shiftHistoryWindowNewer(
      {
        start: this.state.historyWindowStart,
        end: this.state.historyWindowEnd,
      },
      this.currentMessageHistory.length,
    ),
  );
}

export function showLatestHistory(this: ChatControllerHistoryContext): boolean {
  this.newerHistoryNavigationRevision += 1;
  return this.applyHistoryWindow(latestHistoryWindow(this.currentMessageHistory.length));
}

export function getLoadedMessages(this: ChatControllerHistoryContext): unknown[] {
  return this.currentMessageHistory.toArray();
}

export async function rewindToUserMessage(
  this: ChatControllerHistoryContext,
  entryId: string,
): Promise<RewindEditorDraft> {
  const normalizedEntryId = entryId.trim();
  const client = this.state.client;
  if (!normalizedEntryId) throw new Error('A persisted user message is required');
  if (!client || !this.state.connected) throw new Error('OpenClaw gateway is not connected');
  if (
    this.state.chatSending ||
    this.state.compactionInFlight ||
    this.state.chatLoading ||
    this.state.historyLoadingOlder ||
    this.state.pendingUserMessage !== null
  ) {
    throw new Error('Wait for the current session activity to finish');
  }

  const persistedMessages = this.currentMessageHistory.toArray() as GatewayMessage[];
  const latestUserEntryId = (() => {
    const messages = persistedMessages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role?.toLowerCase() !== 'user') continue;
      const marker = message.__openclaw;
      if (marker?.kind === 'pending-send') return null;
      const id = typeof marker?.id === 'string' ? marker.id.trim() : '';
      return id || null;
    }
    return null;
  })();
  if (latestUserEntryId !== normalizedEntryId) {
    throw new Error('Only the latest persisted user message can be updated');
  }
  if (!isEntryAfterLatestPlanImplementationReset(persistedMessages, normalizedEntryId)) {
    throw new Error('Planning messages cannot be updated after implementation has started');
  }

  const sessionKey = this.state.sessionKey;
  const described = await client.request<{ session?: { goal?: unknown } | null }>(
    'sessions.describe',
    { key: sessionKey },
  );
  if (described.session?.goal !== undefined && described.session.goal !== null) {
    throw new Error('Messages cannot be updated while the session has a Goal');
  }
  const sessionId = this.state.currentSessionId;
  this.state.chatLoading = true;
  this.notify();
  try {
    const result = await client.request<{
      editorText?: unknown;
      editorAttachments?: Array<{ mimeType?: unknown; data?: unknown }>;
    }>('sessions.rewind', { sessionKey, entryId: normalizedEntryId });
    const draft = parseEditorDraftPayload(result.editorText, result.editorAttachments);
    if (this.state.sessionKey !== sessionKey) {
      this.chatMessagesBySession.delete(sessionKey);
      this.historySourceBySession.delete(sessionKey);
      this.historyPaginationBySession.delete(sessionKey);
      this.displayedHistoryLeafBySession.delete(normalizeTranscriptSessionKey(sessionKey));
      return draft;
    }

    this.historyPagingGeneration += 1;
    this.resetHistoryPagination(sessionKey);
    this.displayedHistoryLeafBySession.delete(normalizeTranscriptSessionKey(sessionKey));
    this.resetTranscriptForSession(sessionKey, this.state.currentSessionId ?? sessionId, false);
    this.setCurrentSessionMessages([], { resetLoadedHistory: true });
    this.state.pendingUserMessage = null;
    this.state.lastError = null;
    this.state.chatLoading = false;
    this.notify();

    try {
      const loaded = await this.loadHistory();
      if (!loaded && this.state.sessionKey === sessionKey) {
        this.scheduleDeferredHistoryReload(sessionKey, 'rewind-reload-failed');
      }
    } catch {
      if (this.state.sessionKey === sessionKey) {
        this.scheduleDeferredHistoryReload(sessionKey, 'rewind-reload-failed');
      }
    }
    return draft;
  } finally {
    if (this.state.sessionKey === sessionKey && this.state.chatLoading) {
      this.state.chatLoading = false;
      this.notify();
    }
  }
}

export async function resolveTranscriptImageUrl(
  this: ChatControllerHistoryContext,
  mediaPath: string,
  sessionKey: string,
): Promise<string | null> {
  const trimmedPath = mediaPath.trim();
  if (/^(?:data|blob|https?):/iu.test(trimmedPath)) return trimmedPath;

  const managedInbound = /^media:\/\/inbound\/[^/?#]+$/iu.test(trimmedPath);
  const cacheKey = managedInbound ? `${sessionKey}\0${trimmedPath}` : trimmedPath;
  const cached = this.transcriptImageCache.get(cacheKey);
  if (cached) return cached;

  const pending = (async () => {
    if (this.transcriptImageReadsActive >= 4) {
      await new Promise<void>(resolve => this.transcriptImageReadWaiters.push(resolve));
    }
    this.transcriptImageReadsActive += 1;
    try {
      if (managedInbound) {
        const result = await window.electron.openclaw.engine.readAssistantMediaDataUrl({
          source: trimmedPath,
          sessionKey,
        });
        return result.success ? result.dataUrl : null;
      }
      const dialog = (
        window as unknown as {
          electron?: {
            dialog?: {
              readFileAsDataUrl?: (path: string) => Promise<{ success: boolean; dataUrl?: string }>;
            };
          };
        }
      ).electron?.dialog;
      const result = await dialog?.readFileAsDataUrl?.(trimmedPath);
      return result?.success && result.dataUrl ? result.dataUrl : null;
    } catch (error) {
      console.warn('[ChatCtrl] Failed to load transcript image', error);
      return null;
    } finally {
      this.transcriptImageReadsActive -= 1;
      this.transcriptImageReadWaiters.shift()?.();
    }
  })();

  this.transcriptImageCache.set(cacheKey, pending);
  void pending.then(value => {
    if (value === null && this.transcriptImageCache.get(cacheKey) === pending) {
      this.transcriptImageCache.delete(cacheKey);
    }
  });
  if (this.transcriptImageCache.size > 64) {
    const oldestPath = this.transcriptImageCache.keys().next().value;
    if (typeof oldestPath === 'string') this.transcriptImageCache.delete(oldestPath);
  }
  return pending;
}

export async function resolveManagedHistoryImages(
  this: ChatControllerHistoryContext,
  messages: unknown[],
  sessionKey: string,
): Promise<unknown[]> {
  return Promise.all(
    messages.map(async message => {
      const record = asRecord(message);
      if (!record) return message;
      const originalContent = Array.isArray(record.content)
        ? record.content
        : typeof record.content === 'string'
          ? [{ type: 'text', text: record.content }]
          : [];
      const content = await Promise.all(
        originalContent.map(async value => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
          const block = value as Record<string, unknown>;
          const source = typeof block.url === 'string' ? block.url : '';
          if (block.type !== 'image' || !source.startsWith('/api/chat/media/outgoing/')) {
            return value;
          }
          try {
            const result = await window.electron.openclaw.engine.readAssistantMediaDataUrl({
              source,
              sessionKey,
            });
            return result.success ? { ...block, url: result.dataUrl } : value;
          } catch (error) {
            console.warn('[ChatCtrl] Failed to load managed outgoing image', error);
            return value;
          }
        }),
      );
      const transcriptImages = await Promise.all(
        getTranscriptMedia(record).map(async media => {
          if (!isTranscriptImage(media)) return null;
          try {
            const imageUrl = await this.resolveTranscriptImageUrl(media.path, sessionKey);
            if (!imageUrl) return null;
            return {
              type: 'image',
              url: imageUrl,
              alt: media.fileName || media.path.split(/[\\/]/).pop() || 'Image',
              ...(media.mimeType ? { mimeType: media.mimeType } : {}),
            };
          } catch (error) {
            console.warn('[ChatCtrl] Failed to load transcript image', error);
            return null;
          }
        }),
      );
      const imageBlocks = transcriptImages.filter(
        (value): value is NonNullable<typeof value> => value !== null,
      );
      const existingImageUrlCounts = new Map<string, number>();
      for (const url of content
        .map(getContentImageUrl)
        .filter((value): value is string => value !== null)) {
        const identity = getImageUrlIdentity(url);
        existingImageUrlCounts.set(identity, (existingImageUrlCounts.get(identity) ?? 0) + 1);
      }
      const uniqueImageBlocks = imageBlocks.filter(block => {
        const identity = getImageUrlIdentity(block.url);
        const existingCount = existingImageUrlCounts.get(identity) ?? 0;
        if (existingCount > 0) {
          existingImageUrlCounts.set(identity, existingCount - 1);
          return false;
        }
        return true;
      });
      if (uniqueImageBlocks.length === 0 && !Array.isArray(record.content)) return message;
      return { ...record, content: [...content, ...uniqueImageBlocks] };
    }),
  );
}

export function hydrateCurrentSessionImages(
  this: ChatControllerHistoryContext,
  messages: unknown[],
  sessionKey: string,
): void {
  void this.resolveManagedHistoryImages(messages, sessionKey).then(resolvedMessages => {
    if (this.state.sessionKey !== sessionKey || this.state.chatMessages !== messages) return;
    this.setCurrentSessionMessages(resolvedMessages);
    this.notify();
  });
}

export async function loadOlderHistoryPage(
  this: ChatControllerHistoryContext,
  sessionKey: string,
  cursor: string,
): Promise<ChatHistoryPage> {
  const client = this.state.client;
  if (!client) throw new Error('OpenClaw Gateway is not connected');
  return parseChatHistoryPage(
    await client.request('chat.history', {
      sessionKey,
      limit: CHAT_HISTORY_OLDER_PAGE_LIMIT,
      maxChars: CHAT_HISTORY_MAX_CHARS,
      offset: decodeHistoryOffsetCursor(cursor),
    }),
  );
}

export async function normalizeHistoryPage(
  this: ChatControllerHistoryContext,
  messages: unknown[],
  sessionKey: string,
): Promise<unknown[]> {
  const projected = projectGatewayHistoryForDisplay(messages);
  const client = this.state.client;
  const hydratedFullMessages = client
    ? await hydrateTruncatedHistoryMessages(client, projected, sessionKey)
    : projected;
  const normalized = await hydrateGatewayHistoryForDisplay(hydratedFullMessages, {
    sessionKey,
    sessionId: this.state.transcript.sessionId,
    lastError: this.state.lastError,
    includeFailedRunOverlays: false,
    includeInterruptedOverlays: false,
    enrichCompactionMarkers: (projectedMessages, key) =>
      this.enrichCompactionMarkers(projectedMessages, key),
  });
  return this.resolveManagedHistoryImages(normalized, sessionKey);
}

export async function loadOlderHistory(this: ChatControllerHistoryContext): Promise<boolean> {
  const sessionKey = this.state.sessionKey;
  const initialCursor = this.state.historyNextCursor;
  if (!sessionKey || !initialCursor || this.state.historyLoadingOlder) return false;

  const historyGeneration = this.state.transcript.historyGeneration;
  const sessionId = this.state.transcript.sessionId;
  const pagingGeneration = this.historyPagingGeneration;
  const requestedWindow = {
    start: this.state.historyWindowStart,
    end: this.state.historyWindowEnd,
  };
  const requestedNewerNavigationRevision = this.newerHistoryNavigationRevision;
  const seenCursors = new Set<string>();
  let cursor: string | null = initialCursor;
  this.state.historyLoadingOlder = true;
  this.notify();
  try {
    while (cursor && !seenCursors.has(cursor)) {
      seenCursors.add(cursor);
      const page = await this.loadOlderHistoryPage(sessionKey, cursor);
      if (
        !page ||
        this.state.sessionKey !== sessionKey ||
        this.state.transcript.historyGeneration !== historyGeneration ||
        this.state.transcript.sessionId !== sessionId ||
        this.historyPagingGeneration !== pagingGeneration
      ) {
        return false;
      }
      const normalized = await this.normalizeHistoryPage(page.messages, sessionKey);
      if (
        this.state.sessionKey !== sessionKey ||
        this.state.transcript.historyGeneration !== historyGeneration ||
        this.state.transcript.sessionId !== sessionId ||
        this.historyPagingGeneration !== pagingGeneration
      ) {
        return false;
      }
      this.historyPaginationAdvanced = true;
      const subagentTaskPageIndex = this.findExpectedInitialHistoryIndex(normalized);
      if (this.expectInitialHistory && subagentTaskPageIndex >= 0) {
        const taskBoundedPage = normalized.slice(subagentTaskPageIndex);
        const boundedHistory = [...taskBoundedPage, ...this.currentMessageHistory.recentMessages];
        const messages = this.state.chatSending
          ? sliceActiveSubagentHistoryPrefix(boundedHistory)
          : boundedHistory;
        this.state.transcript.historySource = 'gateway';
        this.state.historyHasMore = false;
        this.state.historyNextCursor = null;
        this.rememberHistoryPagination(sessionKey);
        this.setCurrentSessionMessages(messages, { resetLoadedHistory: true });
        this.state.transcript.revision += 1;
        this.notify();
        return true;
      }
      const addedCount = this.currentMessageHistory.prepend(normalized);
      const changed = addedCount > 0;
      const repeatedCursor: boolean =
        page.nextCursor === cursor ||
        (page.nextCursor !== null && seenCursors.has(page.nextCursor));
      this.state.historyHasMore = page.hasMore && !repeatedCursor;
      this.state.historyNextCursor = this.state.historyHasMore ? page.nextCursor : null;
      this.rememberHistoryPagination(sessionKey);
      if (!changed) {
        if (!this.state.historyHasMore || !this.state.historyNextCursor) {
          this.notify();
          return false;
        }
        cursor = this.state.historyNextCursor;
        continue;
      }

      this.state.loadedMessageCount = this.currentMessageHistory.length;
      const shouldShiftRequestedWindowOlder =
        this.state.historyWindowStart === requestedWindow.start &&
        this.state.historyWindowEnd === requestedWindow.end &&
        this.newerHistoryNavigationRevision === requestedNewerNavigationRevision;
      const preservedWindow = {
        start: this.state.historyWindowStart + addedCount,
        end: this.state.historyWindowEnd + addedCount,
      };
      this.state.historyWindowStart = preservedWindow.start;
      this.state.historyWindowEnd = preservedWindow.end;
      this.applyHistoryWindow(
        shouldShiftRequestedWindowOlder
          ? shiftHistoryWindowOlder(preservedWindow, this.currentMessageHistory.length)
          : preservedWindow,
      );
      this.state.transcript.revision += 1;
      this.notify();
      return true;
    }
    this.state.historyHasMore = false;
    this.state.historyNextCursor = null;
    this.rememberHistoryPagination(sessionKey);
    this.notify();
    return false;
  } catch (error) {
    debugLog('[ChatCtrl] older history page unavailable', {
      sessionKey,
      cursor,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    if (this.state.sessionKey === sessionKey) {
      this.state.historyLoadingOlder = false;
      this.notify();
    }
  }
}

export async function loadHistory(
  this: ChatControllerHistoryContext,
  queueIfBusy = false,
  options: {
    preferStartup?: boolean;
    reconcileSuspended?: boolean;
    backfillActiveSessionsYield?: boolean;
  } = {},
): Promise<boolean> {
  const client = this.state.client;
  if (!client || !this.state.connected) return false;

  const sessionKey = this.state.sessionKey;
  this.ensureTranscriptSessionIdentity();
  if (this.historyLoadsInFlight.has(sessionKey)) {
    if (queueIfBusy) {
      this.historyReloadRequested.add(sessionKey);
      this.immediateHistoryReloadRequested.add(sessionKey);
    }
    debugLog('[ChatCtrl] loadHistory SKIP busy', {
      sessionKey,
      queueIfBusy,
      queued: this.historyReloadRequested.has(sessionKey),
      inFlightSessions: [...this.historyLoadsInFlight],
      ...this._snap(),
    });
    return false;
  }
  const pagingGeneration = ++this.historyPagingGeneration;
  const loadSeq = ++this.historyLoadSeq;
  let transcriptHistoryGeneration = this.state.transcript.historyGeneration;
  let requestedSessionId = this.state.transcript.sessionId;
  this.historyLoadsInFlight.add(sessionKey);
  const previousMessages = this.state.chatMessages;
  const requestRunId = this.state.chatRunId;
  debugLog('[ChatCtrl] loadHistory START', {
    seq: loadSeq,
    sessionKey,
    chatSending: this.state.chatSending,
    pendingUserMsg: !!this.state.pendingUserMessage,
    chatRunId: this.state.chatRunId,
    previousSummary: summarizeHistoryForDebug(previousMessages),
    currentSummary: summarizeHistoryForDebug(this.state.chatMessages),
  });
  this.state.chatLoading = true;
  this.notify();

  try {
    // The UI and Gateway ship at the same OpenClaw version. One native RPC
    // owns both the recent page and its offset cursor; no REST/IPC fallback or
    // second independently timed snapshot is needed.
    const method = options.preferStartup ? 'chat.startup' : 'chat.history';
    const result = await client.request<ChatHistorySnapshot>(method, {
      sessionKey,
      limit: CHAT_HISTORY_INITIAL_LIMIT,
      maxChars: CHAT_HISTORY_MAX_CHARS,
    });
    const pagedHistory = parseChatHistoryPage(result);
    debugLog('[ChatCtrl] loadHistory RPC OK', {
      seq: loadSeq,
      method,
      sessionKey,
      rpcCount: pagedHistory.messages.length,
      rpcSessionId: result?.sessionId ?? null,
      rpcSummary: summarizeHistoryForDebug(pagedHistory.messages),
    });

    if (this.state.sessionKey !== sessionKey) {
      debugLog('[ChatCtrl] loadHistory ABORT session changed after RPC', {
        seq: loadSeq,
        requestedSessionKey: sessionKey,
        currentSessionKey: this.state.sessionKey,
      });
      return false;
    }

    const loadedSessionId = normalizeSessionId(result?.sessionInfo?.sessionId ?? result?.sessionId);
    const normalizedSessionKey = normalizeTranscriptSessionKey(sessionKey);
    const responseHasActiveLeaf = Object.prototype.hasOwnProperty.call(
      result?.sessionInfo ?? {},
      'activeLeafEntryId',
    );
    const loadedActiveLeaf = responseHasActiveLeaf
      ? normalizeSessionId(result?.sessionInfo?.activeLeafEntryId)
      : undefined;
    const previousActiveLeafKnown = this.displayedHistoryLeafBySession.has(normalizedSessionKey);
    const previousActiveLeaf = this.displayedHistoryLeafBySession.get(normalizedSessionKey);
    const rotatesSessionIdentity = Boolean(
      loadedSessionId &&
      this.state.transcript.sessionId &&
      loadedSessionId !== this.state.transcript.sessionId,
    );
    const switchesHistoryBranch = Boolean(
      responseHasActiveLeaf && previousActiveLeafKnown && previousActiveLeaf !== loadedActiveLeaf,
    );
    const authoritativeSessionId = loadedSessionId ?? this.state.transcript.sessionId;
    if (!rotatesSessionIdentity) {
      requestedSessionId = authoritativeSessionId;
      this.state.currentSessionId = authoritativeSessionId;
      this.state.transcript.sessionId = authoritativeSessionId;
    }
    const requestStillCurrent = (): boolean =>
      this.state.sessionKey === sessionKey &&
      this.historyPagingGeneration === pagingGeneration &&
      this.state.transcript.historyGeneration === transcriptHistoryGeneration &&
      this.state.transcript.sessionId === requestedSessionId;

    const rawMessages = pagedHistory.messages;
    debugLog('[ChatCtrl] loadHistory AFTER-AWAIT', {
      seq: loadSeq,
      sessionKey,
      source: 'rpc',
      rawMsgCount: rawMessages.length,
      rawSummary: summarizeHistoryForDebug(rawMessages),
      ...this._snap(),
    });
    // Remove stream-fallback messages — the real persisted message from the
    // gateway will replace them, preventing content duplication.
    const projectedMessages = projectGatewayHistoryForDisplay(rawMessages);
    debugLog('[ChatCtrl] loadHistory PROJECTED', {
      seq: loadSeq,
      sessionKey,
      rawCount: rawMessages.length,
      projectedCount: projectedMessages.length,
      hiddenCount: rawMessages.length - projectedMessages.length,
      projectedSummary: summarizeHistoryForDebug(projectedMessages),
    });
    const hydratedFullMessages = await hydrateTruncatedHistoryMessages(
      client,
      projectedMessages,
      sessionKey,
    );
    const hydratedMessages = await hydrateGatewayHistoryForDisplay(hydratedFullMessages, {
      sessionKey,
      sessionId: authoritativeSessionId,
      lastError: this.state.lastError,
      enrichCompactionMarkers: (messages, key) => this.enrichCompactionMarkers(messages, key),
    });
    if (!requestStillCurrent()) {
      debugLog('[ChatCtrl] loadHistory ABORT identity changed during normalization', {
        seq: loadSeq,
        requestedSessionKey: sessionKey,
        currentSessionKey: this.state.sessionKey,
      });
      return false;
    }
    // Commit owns pagination from this point. Any older-page request that
    // started while the tail snapshot was being hydrated must not mutate the
    // new cursor or mix a prior branch into it.
    this.historyPagingGeneration += 1;
    // Hydration awaits can span a run starting or finishing. Decide at commit
    // time, and retain a running turn even during suspended reconciliation:
    // that path still needs it to recover the remote run's lifecycle.
    const deferHistoryBranchReplacement = switchesHistoryBranch && this.state.chatSending;
    const replacesHistoryProjection =
      rotatesSessionIdentity || (switchesHistoryBranch && !deferHistoryBranchReplacement);
    const preserveLoadedPaginationDepth =
      !replacesHistoryProjection && this.historyPaginationAdvanced;
    // Hydrating oversized rows and compaction details can take multiple RPCs.
    // Keep the previous physical session visible until the replacement
    // snapshot is complete, then swap identity and messages in one render.
    // Clearing here used to expose a transient empty transcript whenever a
    // reset/rotation coincided with a large history response.
    if (replacesHistoryProjection) {
      this.resetTranscriptForSession(sessionKey, authoritativeSessionId, false);
      this.resetHistoryPagination(sessionKey);
      this.displayedHistoryLeafBySession.delete(normalizedSessionKey);
      this.currentMessageHistory.reset();
      this.state.chatMessages = [];
      this.state.loadedMessageCount = 0;
      this.state.visibleChatMessages = [];
      this.state.historyWindowStart = 0;
      this.state.historyWindowEnd = 0;
      transcriptHistoryGeneration = this.state.transcript.historyGeneration;
      requestedSessionId = authoritativeSessionId;
    }
    this.state.currentSessionId = authoritativeSessionId;
    this.state.transcript.sessionId = authoritativeSessionId;
    this.applySessionContextUsage(result?.sessionInfo, sessionKey);
    let messages = this.projectLocalCompactionStatus(sessionKey, hydratedMessages);
    messages = mergeRefreshedHistoryWindow(
      replacesHistoryProjection ? [] : previousMessages,
      messages,
    );
    debugLog('[ChatCtrl] loadHistory NORMALIZED', {
      seq: loadSeq,
      sessionKey,
      hydratedCount: hydratedMessages.length,
      normalizedSummary: summarizeHistoryForDebug(messages),
    });
    const loadedMessageSeq = readLatestOpenClawMessageSeq(messages);
    this.recordLoadedSessionMessageSeq(sessionKey, authoritativeSessionId, loadedMessageSeq, false);

    // During a live subagent run, history can already contain assistant/tool
    // artifacts from the same turn by the time its delayed first user turn
    // becomes readable. Only admit the authoritative prefix through that
    // user turn; the active transcript remains the sole owner of live output.
    const subagentTaskHistoryIndex = this.findExpectedInitialHistoryIndex(messages);
    const previousHasSubagentTask = this.findExpectedInitialHistoryIndex(previousMessages) >= 0;
    const currentHasSubagentTask =
      this.findExpectedInitialHistoryIndex(this.state.chatMessages) >= 0;
    if (currentHasSubagentTask && subagentTaskHistoryIndex < 0) {
      debugLog('[ChatCtrl] rejected history snapshot older than live subagent task event', {
        seq: loadSeq,
        sessionKey,
        ...this._snap(),
      });
      this.state.chatLoading = false;
      this.notify();
      return false;
    }
    if (this.expectInitialHistory && subagentTaskHistoryIndex > 0) {
      messages = messages.slice(subagentTaskHistoryIndex);
    }
    const catchesUpMissingInitialHistory =
      this.expectInitialHistory &&
      this.state.chatSending &&
      !previousHasSubagentTask &&
      subagentTaskHistoryIndex >= 0;
    if (catchesUpMissingInitialHistory) {
      messages = sliceActiveSubagentHistoryPrefix(messages);
    }

    if (!replacesHistoryProjection && messages.length === 0 && previousMessages.length > 0) {
      // A tail read can briefly observe the SQLite write/rewrite boundary.
      // An empty response is not proof that a stable displayed projection
      // disappeared; retain it and retry. Explicit reset/session/leaf scope
      // changes take the replacement path above and are still allowed empty.
      this.state.chatLoading = false;
      this.scheduleDeferredHistoryReload(sessionKey, 'empty-history-snapshot');
      this.notify();
      return false;
    }

    // Active-run history is not allowed to replace the live timeline, but it
    // can safely hydrate the same Tool boundary by its stable call ID. This is
    // especially important for long sessions_yield joins whose live result
    // event may contain only a short summary or no renderable output.
    const repairedActiveTail = this.hydrateActiveToolItemsFromHistory(messages, {
      backfillMissingSessionsYield: options.backfillActiveSessionsYield,
    });
    if (repairedActiveTail) this.publishActiveToolHistoryRepair();
    if (options.backfillActiveSessionsYield) {
      // Resolve the transcript-level gap only after the same authoritative
      // snapshot has passed the identity/time-limited Tool hydration step.
      this.recordLoadedSessionMessageSeq(
        sessionKey,
        authoritativeSessionId,
        loadedMessageSeq,
        true,
      );
    }

    // Only clear pendingUserMessage if the user message is actually in the
    // loaded history.  For brand-new sessions the gateway may not have
    // persisted it yet — keep showing the optimistic bubble.
    let pendingUserMessageFoundIndex = -1;
    if (this.state.pendingUserMessage) {
      const p = this.state.pendingUserMessage;
      pendingUserMessageFoundIndex = messages.findIndex((message: unknown) =>
        isPendingUserMessageMatch(message as GatewayMessage, p as unknown as GatewayMessage),
      );
      if (pendingUserMessageFoundIndex >= 0 && Array.isArray(p.content)) {
        messages = messages.map((historyMessage, index) =>
          index === pendingUserMessageFoundIndex
            ? {
                ...(historyMessage as Record<string, unknown>),
                content: p.content,
              }
            : historyMessage,
        );
      }
    }

    const reconciliation = reconcileHistory(this.state.transcript, {
      request: {
        sessionKey,
        sessionId: requestedSessionId,
        historyGeneration: transcriptHistoryGeneration,
      },
      source: 'gateway',
      messages,
      requestStartMessages: previousMessages,
      currentMessages: this.state.chatMessages,
      activeRun:
        this.state.chatSending && !options.reconcileSuspended && !catchesUpMissingInitialHistory,
      isVisibleMessage: message => !shouldHideMessage(message),
    });
    if (!reconciliation.accepted) {
      debugLog('[ChatCtrl] loadHistory rejected by transcript reconciler', {
        seq: loadSeq,
        sessionKey,
        reason: reconciliation.reason,
        catchUp: reconciliation.catchUp,
        loadedSummary: summarizeHistoryForDebug(messages),
        previousSummary: summarizeHistoryForDebug(previousMessages),
        currentSummary: summarizeHistoryForDebug(this.state.chatMessages),
      });
      if (reconciliation.catchUp === 'deferred') {
        this.scheduleDeferredHistoryReload(sessionKey, reconciliation.reason ?? 'history-catch-up');
      }
      if (reconciliation.reason === 'active-run') {
        // Persisted history must not replace a live turn, but the same RPC's
        // in-flight activity snapshot is designed to repair events missed
        // before reconnect. It has independent run/sequence ownership.
        this.applyInFlightRunSnapshot(
          result?.inFlightRun,
          sessionKey,
          authoritativeSessionId,
          requestRunId,
          result?.sessionInfo,
        );
      }
      this.state.chatLoading = false;
      this.notify();
      return false;
    }
    // A history refresh repairs missed native appends, including the actual
    // model after a fallback. Do not let an optimistic final record replace
    // that authoritative identity, or borrow metadata from another run.
    if (!this.state.chatSending) {
      for (const message of messages) {
        if (!isLocallyOptimisticHistoryTail(message)) {
          this.rememberRunModel(message, readExplicitMessageRunId(message));
        }
      }
    }
    messages = reconciliation.messages;
    debugLog('[ChatCtrl] loadHistory APPLY', {
      seq: loadSeq,
      sessionKey,
      beforeSummary: summarizeHistoryForDebug(this.state.chatMessages),
      nextSummary: summarizeHistoryForDebug(messages),
      preservedOptimisticTailCount: reconciliation.preservedOptimisticTailCount,
      activeTurnTakeover: reconciliation.activeTurnTakeover,
    });
    this.state.chatLoading = false;
    if (!preserveLoadedPaginationDepth) {
      this.state.historyHasMore =
        this.expectInitialHistory && subagentTaskHistoryIndex >= 0 ? false : pagedHistory.hasMore;
      this.state.historyNextCursor = this.state.historyHasMore ? pagedHistory.nextCursor : null;
    }
    this.rememberHistoryPagination(sessionKey);
    if (responseHasActiveLeaf && !deferHistoryBranchReplacement) {
      this.displayedHistoryLeafBySession.set(normalizedSessionKey, loadedActiveLeaf ?? null);
    }
    if (this.state.pendingUserMessage && pendingUserMessageFoundIndex >= 0) {
      debugLog('[ChatCtrl] loadHistory OK — pendingUserMessage found in history, clearing', {
        seq: loadSeq,
        sessionKey,
        foundIndex: pendingUserMessageFoundIndex,
      });
      this.state.pendingUserMessage = null;
    }
    this.setCurrentSessionMessages(messages, {
      resetLoadedHistory: this.expectInitialHistory && subagentTaskHistoryIndex >= 0,
    });
    this.applyInFlightRunSnapshot(
      result?.inFlightRun,
      sessionKey,
      authoritativeSessionId,
      requestRunId,
      result?.sessionInfo,
    );
    const pendingCompaction = this.localCompactionStatusBySession.get(sessionKey);
    if (pendingCompaction?.message.__openclaw.phase === 'completed') {
      this.scheduleDeferredHistoryReload(sessionKey, 'compaction-marker-pending');
    } else {
      this.deferredHistoryReloadAttempts.delete(sessionKey);
    }
    this.hydrateCurrentSessionImages(messages, sessionKey);
    this.notify();
    return true;
  } catch (err) {
    if (this.state.sessionKey !== sessionKey) return false;
    this.state.chatLoading = false;
    this.state.lastError = (err as Error).message;
    console.error('[ChatCtrl] loadHistory FAILED:', (err as Error).message);
    debugLog('[ChatCtrl] loadHistory FAILED', {
      seq: loadSeq,
      sessionKey,
      error: err instanceof Error ? err.message : String(err),
      ...this._snap(),
    });
    if (
      this.localCompactionStatusBySession.get(sessionKey)?.message.__openclaw.phase === 'completed'
    ) {
      this.scheduleDeferredHistoryReload(sessionKey, 'compaction-marker-pending');
    }
    this.notify();
    return false;
  } finally {
    this.historyLoadsInFlight.delete(sessionKey);
    const reloadRequested = this.historyReloadRequested.delete(sessionKey);
    const immediateReloadRequested = this.immediateHistoryReloadRequested.delete(sessionKey);
    if (reloadRequested && immediateReloadRequested && this.state.sessionKey === sessionKey) {
      debugLog('[ChatCtrl] loadHistory QUEUED reload starting', {
        seq: loadSeq,
        sessionKey,
        nextSeq: this.historyLoadSeq + 1,
      });
      // A→B→A can leave the original A request in flight while the second A
      // initialization queues behind it. Start its replacement immediately
      // after releasing ownership; a generic debounce would leave the pane
      // visibly empty for another 1.2 seconds.
      void Promise.resolve().then(() => this.loadHistory(true));
    } else {
      debugLog('[ChatCtrl] loadHistory FINISH', {
        seq: loadSeq,
        sessionKey,
        queued: this.historyReloadRequested.has(sessionKey),
        ...this._snap(),
      });
    }
  }
}
