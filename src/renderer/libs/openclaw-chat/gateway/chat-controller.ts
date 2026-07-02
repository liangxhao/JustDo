/**
 * Chat controller — manages chat state and gateway interaction.
 * Simplified version of OpenClaw's controllers/chat.ts.
 *
 * This directly replicates the webchat's approach:
 * - Connects to gateway via GatewayClient
 * - Loads history via chat.history / chat.startup RPC
 * - Handles streaming events (delta, final, aborted, error)
 * - Sends messages via chat.send RPC
 *
 * No JustDo adapter, no Redux, no IPC — direct gateway connection.
 */

import type { GatewayClient, GatewayEventFrame, GatewayHelloOk } from './client';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatState {
  client: GatewayClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingMessages: unknown[];
  chatToolMessages: unknown[];
  chatStreamSegments: Array<{ text: string; ts: number }>;
  chatSending: boolean;
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatThinkingStream: string | null;
  lastError: string | null;
  hello: GatewayHelloOk | null;
  /** Optimistic user message shown until gateway history loads */
  pendingUserMessage: { role: string; content: string; timestamp: number } | null;
}

export interface ChatEventPayload {
  runId?: string;
  sessionKey: string;
  agentId?: string;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: unknown;
  deltaText?: string;
  replace?: boolean;
  errorMessage?: string;
}

export type ChatStateListener = (state: ChatState) => void;

type ToolContentBlock = {
  type: 'toolcall' | 'toolresult';
  toolCallId: string;
  name: string;
  arguments?: unknown;
  text?: string;
  isError?: boolean;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const HISTORY_LIMIT = 100;
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const AGENT_RUN_FAILED_BEFORE_REPLY = 'The agent run failed before producing a reply.';
const FAILED_RUN_STORAGE_KEY = 'justdo-openclaw-failed-runs';
const FAILED_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEBUG_CHAT_CONTROLLER =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEBUG_CHAT_CONTROLLER === 'true';

function debugLog(...args: unknown[]): void {
  if (DEBUG_CHAT_CONTROLLER) {
    console.debug(...args);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type FailedRunRecord = {
  sessionKey: string;
  runId: string | null;
  error: string;
  timestamp: number;
};

function readFailedRuns(): FailedRunRecord[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(FAILED_RUN_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    const cutoff = Date.now() - FAILED_RUN_RETENTION_MS;
    return value.filter(
      (item): item is FailedRunRecord =>
        typeof item?.sessionKey === 'string' &&
        (typeof item.runId === 'string' || item.runId === null) &&
        typeof item.error === 'string' &&
        typeof item.timestamp === 'number' &&
        item.timestamp >= cutoff,
    );
  } catch {
    return [];
  }
}

function persistFailedRun(record: FailedRunRecord): void {
  if (typeof localStorage === 'undefined') return;
  const records = readFailedRuns().filter(
    item => !(record.runId && item.sessionKey === record.sessionKey && item.runId === record.runId),
  );
  try {
    localStorage.setItem(FAILED_RUN_STORAGE_KEY, JSON.stringify([...records, record].slice(-100)));
  } catch {
    // A storage failure must not interfere with chat error handling.
  }
}

function findFailedRunError(
  message: Record<string, unknown>,
  sessionKey: string,
): string | null {
  const runId = typeof message.runId === 'string' ? message.runId : null;
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
  const candidates = readFailedRuns().filter(item => item.sessionKey === sessionKey);
  const exact = runId ? candidates.find(item => item.runId === runId) : null;
  if (exact) return exact.error;
  if (timestamp === null) return candidates.at(-1)?.error ?? null;
  return candidates
    .filter(item => Math.abs(item.timestamp - timestamp) < 60_000)
    .sort(
      (left, right) =>
        Math.abs(left.timestamp - timestamp) - Math.abs(right.timestamp - timestamp),
    )[0]?.error ?? null;
}

function normalizeFailedRunMessage(
  message: unknown,
  sessionKey: string,
  errorMessage: string | null,
): unknown {
  const raw = asRecord(message);
  if (
    raw?.role !== 'assistant' ||
    messageText(raw.content).trim() !== AGENT_RUN_FAILED_BEFORE_REPLY
  ) {
    return message;
  }

  return {
    ...raw,
    role: 'system',
    content:
      errorMessage?.trim() ||
      findFailedRunError(raw, sessionKey) ||
      AGENT_RUN_FAILED_BEFORE_REPLY,
    isError: true,
  };
}

function getToolResultId(message: unknown): string | null {
  const raw = asRecord(message);
  if (!raw) return null;
  const id = [raw.toolCallId, raw.tool_call_id, raw.toolUseId, raw.tool_use_id].find(
    value => typeof value === 'string' && value.trim(),
  );
  return typeof id === 'string' ? id : null;
}

function hasMessageToolInput(message: unknown): boolean {
  const raw = asRecord(message);
  if (!raw) return false;
  for (const value of [raw.toolInput, raw.tool_input, raw.arguments, raw.args, raw.input]) {
    if (hasMeaningfulToolInput(value)) return true;
  }
  return false;
}

async function hydrateMissingToolInputsFromLocalState(
  sessionKey: string,
  messages: unknown[],
): Promise<unknown[]> {
  const missingIds = Array.from(
    new Set(
      messages
        .filter(message => {
          const raw = asRecord(message);
          const role = typeof raw?.role === 'string' ? raw.role.toLowerCase() : '';
          return ['toolresult', 'tool_result', 'tool', 'function'].includes(role);
        })
        .filter(message => !hasMessageToolInput(message))
        .map(getToolResultId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (missingIds.length === 0) return messages;

  const electronApi = (globalThis as {
    electron?: {
      openclaw?: {
        history?: {
          getToolInputs?: (params: {
            sessionKey: string;
            toolCallIds: string[];
          }) => Promise<{ success?: boolean; inputs?: Record<string, { name?: string; input?: unknown }> }>;
        };
      };
    };
  }).electron;
  const result = await electronApi?.openclaw?.history?.getToolInputs?.({
    sessionKey,
    toolCallIds: missingIds,
  });
  const inputs = result?.success && result.inputs ? result.inputs : {};
  if (Object.keys(inputs).length === 0) return messages;

  return messages.map(message => {
    const raw = asRecord(message);
    if (!raw || hasMessageToolInput(raw)) return message;
    const id = getToolResultId(raw);
    const hydrated = id ? inputs[id] : undefined;
    if (!hydrated || !hasMeaningfulToolInput(hydrated.input)) return message;
    return {
      ...raw,
      toolName: raw.toolName ?? raw.tool_name ?? hydrated.name,
      toolInput: hydrated.input,
    };
  });
}

function toolInputFromBlock(block: unknown): unknown {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const record = block as Record<string, unknown>;
  return record.arguments ?? record.args ?? record.input;
}

function hasMeaningfulToolInput(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0 && value.trim() !== '{}';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function shouldPreferNextToolCall(existingToolCall: unknown, nextToolCall: unknown): boolean {
  if (!nextToolCall) return false;
  if (!existingToolCall) return true;
  return (
    !hasMeaningfulToolInput(toolInputFromBlock(existingToolCall)) &&
    hasMeaningfulToolInput(toolInputFromBlock(nextToolCall))
  );
}

// ─── ChatController ─────────────────────────────────────────────────────────

export class ChatController {
  readonly state: ChatState;
  private listeners: Set<ChatStateListener> = new Set();
  private streamListeners: Set<() => void> = new Set();
  private lifecycleEndFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private assistantSnapshotRunId: string | null = null;
  private ignoredDeltaAfterAssistantSnapshotCount = 0;

  /** Compact state snapshot for diagnostic logging */
  private _snap(): Record<string, unknown> {
    return {
      chatSending: this.state.chatSending,
      chatRunId: this.state.chatRunId,
      msgCount: this.state.chatMessages.length,
      thinkingMsgCount: this.state.chatThinkingMessages.length,
      toolMsgCount: this.state.chatToolMessages.length,
      segCount: this.state.chatStreamSegments.length,
      hasStream: !!this.state.chatStream,
      streamLen: this.state.chatStream?.length ?? 0,
      hasThinking: !!this.state.chatThinkingStream,
      thinkingLen: this.state.chatThinkingStream?.length ?? 0,
      hasPending: !!this.state.pendingUserMessage,
      pendingReload: this.pendingHistoryReload,
      chatLoading: this.state.chatLoading,
      connected: this.state.connected,
      msgRoles: (this.state.chatMessages as Array<Record<string, unknown>>)
        .slice(-5)
        .map(m => `${m.role ?? '?'}${(m as Record<string, unknown>).__openclawStreamFallback ? '(fallback)' : ''}`),
    };
  }

  constructor() {
    this.state = {
      client: null,
      connected: false,
      sessionKey: '',
      chatLoading: false,
      chatMessages: [],
      chatThinkingMessages: [],
      chatToolMessages: [],
      chatStreamSegments: [],
      chatSending: false,
      chatRunId: null,
      chatStream: null,
      chatStreamStartedAt: null,
      chatThinkingStream: null,
      lastError: null,
      hello: null,
      pendingUserMessage: null,
    };
  }

  /** Set an optimistic user message shown until the next loadHistory.
   *  Also marks chatSending=true so session.message events are deferred. */
  setPendingUserMessage(text: string): void {
    debugLog('[ChatCtrl] setPendingUserMessage:', text.slice(0, 60));
    this.state.pendingUserMessage = { role: 'user', content: text, timestamp: Date.now() };
    this.state.chatSending = true;
    this.state.chatStreamStartedAt ??= Date.now();
    this.notify();
  }

  /** Clear sending state (e.g. when session start fails) */
  clearSending(): void {
    this.state.chatSending = false;
    this.state.chatRunId = null;
    this.state.chatStream = null;
    this.state.chatStreamStartedAt = null;
    this.state.pendingUserMessage = null;
    this.resetAssistantSnapshotSource();
    this.notify();
  }

  /** Subscribe to state changes */
  subscribe(listener: ChatStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to stream updates (for real-time rendering) */
  onStream(listener: () => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  private notify(): void {
    debugLog('[ChatCtrl] ▶ notify', this._snap());
    for (const listener of this.listeners) listener(this.state);
  }

  private notifyStream(): void {
    debugLog('[ChatCtrl] ▶ notifyStream', this._snap());
    for (const listener of this.streamListeners) listener();
  }

  private clearLifecycleEndFallback(): void {
    if (!this.lifecycleEndFallbackTimer) return;
    clearTimeout(this.lifecycleEndFallbackTimer);
    this.lifecycleEndFallbackTimer = null;
  }

  private resetAssistantSnapshotSource(): void {
    this.assistantSnapshotRunId = null;
    this.ignoredDeltaAfterAssistantSnapshotCount = 0;
  }

  private commitActiveStreamSegment(): void {
    if (!this.state.chatStream) return;
    this.state.chatStreamSegments = [
      ...this.state.chatStreamSegments,
      { text: this.state.chatStream, ts: Date.now() },
    ];
    this.state.chatStream = null;
  }

  private commitActiveThinking(reason: string): void {
    const text = this.state.chatThinkingStream?.trim();
    if (!text) {
      this.state.chatThinkingStream = null;
      return;
    }

    const last = this.state.chatThinkingMessages[this.state.chatThinkingMessages.length - 1] as
      | Record<string, unknown>
      | undefined;
    const lastContent = Array.isArray(last?.content) ? last.content : [];
    const lastThinking = lastContent
      .map(item => (item as Record<string, unknown>).thinking)
      .filter((value): value is string => typeof value === 'string')
      .join('\n')
      .trim();

    if (lastThinking !== text) {
      this.state.chatThinkingMessages = [
        ...this.state.chatThinkingMessages,
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: text }],
          timestamp: Date.now(),
          __openclawLiveThinking: true,
          __openclawLiveThinkingReason: reason,
        },
      ];
    }

    this.state.chatThinkingStream = null;
  }

  private upsertToolMessage(toolMessage: Record<string, unknown>): { existingIndex: number; nextCount: number } {
    const toolCallId = this.extractToolCallId(toolMessage);
    const existingIndex = this.state.chatToolMessages.findIndex(
      m => this.extractToolCallId(m as Record<string, unknown>) === toolCallId,
    );

    if (existingIndex >= 0) {
      const updated = [...this.state.chatToolMessages];
      const existing = updated[existingIndex] as Record<string, unknown>;
      updated[existingIndex] = {
        ...existing,
        ...toolMessage,
        timestamp: existing.timestamp ?? toolMessage.timestamp,
        content: this.mergeToolMessageContent(existing.content, toolMessage.content),
      };
      this.state.chatToolMessages = updated;
    } else {
      this.state.chatToolMessages = [...this.state.chatToolMessages, toolMessage];
    }

    return { existingIndex, nextCount: this.state.chatToolMessages.length };
  }

  private extractToolCallId(toolMessage: Record<string, unknown>): string {
    const direct =
      (typeof toolMessage.toolCallId === 'string' && toolMessage.toolCallId) ||
      (typeof toolMessage.tool_call_id === 'string' && toolMessage.tool_call_id) ||
      '';
    if (direct) {
      return direct;
    }
    const content = Array.isArray(toolMessage.content) ? toolMessage.content : [];
    for (const item of content) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const block = item as Record<string, unknown>;
      const id =
        (typeof block.toolCallId === 'string' && block.toolCallId) ||
        (typeof block.tool_call_id === 'string' && block.tool_call_id) ||
        (typeof block.id === 'string' && block.id) ||
        '';
      if (id) {
        return id;
      }
    }
    return '';
  }

  private mergeToolMessageContent(existingContent: unknown, nextContent: unknown): unknown[] {
    const existing = Array.isArray(existingContent) ? existingContent : [];
    const next = Array.isArray(nextContent) ? nextContent : [];
    const existingToolCall = existing.find(
      item => (item as Record<string, unknown> | null)?.type === 'toolcall',
    );
    const nextToolCall = next.find(
      item => (item as Record<string, unknown> | null)?.type === 'toolcall',
    );
    const existingResults = existing.filter(
      item => (item as Record<string, unknown> | null)?.type === 'toolresult',
    );
    const nextResults = next.filter(
      item => (item as Record<string, unknown> | null)?.type === 'toolresult',
    );
    const toolCall = shouldPreferNextToolCall(existingToolCall, nextToolCall)
      ? nextToolCall
      : (existingToolCall ?? nextToolCall);
    return [
      ...(toolCall ? [toolCall] : []),
      ...(nextResults.length > 0 ? nextResults : existingResults),
    ];
  }

  private buildToolMessage(params: {
    toolCallId: string;
    runId: string | null;
    name: string;
    args: unknown;
    output?: string;
    isError?: boolean;
    isActive?: boolean;
  }): Record<string, unknown> {
    const content: ToolContentBlock[] = [
      {
        type: 'toolcall',
        toolCallId: params.toolCallId,
        name: params.name,
        arguments: params.args ?? {},
      },
    ];
    if (params.output !== undefined) {
      content.push({
        type: 'toolresult',
        toolCallId: params.toolCallId,
        name: params.name,
        text: params.output,
        ...(params.isError ? { isError: true } : {}),
      });
    }

    return {
      role: 'assistant',
      toolCallId: params.toolCallId,
      runId: params.runId,
      toolName: params.name,
      content,
      timestamp: Date.now(),
      __justdoToolActive: params.isActive === true,
    };
  }

  // ─── Connection ───────────────────────────────────────────────────────

  /**
   * Connect to the gateway and load chat history for the given session.
   * This replicates the webchat's connectGateway + loadChatHistory flow.
   */
  async connect(url: string, token: string, sessionKey: string): Promise<void> {
    // Stop existing client
    this.state.client?.stop();

    this.state.sessionKey = sessionKey;
    this.state.chatLoading = true;
    this.state.chatMessages = [];
    this.state.chatThinkingMessages = [];
    this.state.chatToolMessages = [];
    this.state.chatStreamSegments = [];
    this.state.chatStream = null;
    this.state.chatThinkingStream = null;
    this.state.chatRunId = null;
    this.state.lastError = null;
    this.resetAssistantSnapshotSource();
    this.notify();

    const { GatewayClient } = await import('./client');
    const client = new GatewayClient({
      url,
      token,
      onHello: (hello) => this.handleHello(hello),
      onEvent: (event) => this.handleEvent(event),
      onClose: () => this.handleClose(),
    });

    this.state.client = client;
    client.start();
  }

  /** Switch to a different session */
  async switchSession(sessionKey: string): Promise<void> {
    const previousSessionKey = this.state.sessionKey;
    const isTempSessionPromotion = isTempJustDoSessionKey(previousSessionKey) && !isTempJustDoSessionKey(sessionKey);
    debugLog('[ChatCtrl] switchSession:', sessionKey, {
      hadPendingUserMsg: !!this.state.pendingUserMessage,
      chatSending: this.state.chatSending,
      msgCount: this.state.chatMessages.length,
      previousSessionKey,
      isTempSessionPromotion,
    });
    this.state.sessionKey = sessionKey;
    // Only preserve the optimistic prompt while replacing the temporary UI
    // session with the persisted JustDo session. For normal user-initiated
    // switches, clear the active run state so the target session can load its
    // own history even while another session is still running.
    if (!isTempSessionPromotion) {
      this.state.chatSending = false;
      this.state.pendingUserMessage = null;
    }
    this.state.chatMessages = [];
    this.state.chatThinkingMessages = [];
    this.state.chatToolMessages = [];
    this.state.chatStreamSegments = [];
    this.state.chatStream = null;
    this.state.chatThinkingStream = null;
    this.state.chatRunId = null;
    this.state.chatLoading = true;
    this.pendingHistoryReload = false;
    this.resetAssistantSnapshotSource();
    this.notify();

    if (this.state.connected) {
      await this.loadHistory();
    }
  }

  /** Disconnect and clean up */
  disconnect(): void {
    this.clearLifecycleEndFallback();
    this.state.client?.stop();
    this.state.client = null;
    this.state.connected = false;
    this.notify();
  }

  // ─── Gateway Callbacks ────────────────────────────────────────────────

  private handleHello(hello: GatewayHelloOk): void {
    debugLog('[ChatCtrl] handleHello — connected, sessionKey:', this.state.sessionKey);
    this.state.connected = true;
    this.state.hello = hello;
    this.state.lastError = null;
    this.notify();

    // Subscribe to session events (matches webchat: subscribeSessions + syncSelectedSessionMessageSubscription)
    this.state.client?.request('sessions.subscribe', {}).catch(() => {});
    if (this.state.sessionKey) {
      this.state.client?.request('sessions.messages.subscribe', { key: this.state.sessionKey }).catch(() => {});
    }

    // Load history after connection
    this.loadHistory();
  }

  private handleClose(): void {
    this.state.connected = false;
    this.state.chatSending = false;
    this.notify();
  }

  private handleEvent(event: GatewayEventFrame): void {
    if (event.event === 'chat') {
      const payload = event.payload as ChatEventPayload | undefined;
      if (payload) this.handleChatEvent(payload);
      return;
    }

    // Agent / session.tool events — handle tool streams AND assistant streaming
    if (event.event === 'agent' || event.event === 'session.tool') {
      this.handleAgentEvent(event.payload as Record<string, unknown> | undefined, event.event);
      return;
    }

    // session.message — trigger history reload (matches webchat: deferred if run active)
    // NOTE: session.message events are broadcast and the payload does NOT contain
    // session routing fields, so we cannot filter by sessionKey here.  Instead we
    // rely on the lifecycle/end event (which IS session-scoped) to flush the
    // pending reload.  During an active run we always defer.
    if (event.event === 'session.message') {
      if (this.state.chatSending || this.pendingHistoryReload) {
        debugLog('[ChatCtrl] session.message DEFERRED:', this.state.sessionKey, {
          chatSending: this.state.chatSending,
          pendingReload: this.pendingHistoryReload,
        });
        this.pendingHistoryReload = true;
      } else {
        debugLog('[ChatCtrl] session.message → loadHistory:', this.state.sessionKey);
        this.loadHistory();
      }
    }
  }

  private pendingHistoryReload = false;

  // ─── History Loading ──────────────────────────────────────────────────

  async loadHistory(): Promise<void> {
    const client = this.state.client;
    if (!client || !this.state.connected) return;

    const sessionKey = this.state.sessionKey;
    debugLog('[ChatCtrl] loadHistory START:', sessionKey, {
      chatSending: this.state.chatSending,
      pendingUserMsg: !!this.state.pendingUserMessage,
      chatRunId: this.state.chatRunId,
    });
    this.state.chatLoading = true;
    this.notify();

    try {
      // Try chat.startup first (includes agent list), fall back to chat.history
      let result: { messages?: unknown[]; sessionId?: string } | undefined;
      try {
        result = await client.request('chat.startup', { sessionKey, limit: HISTORY_LIMIT });
      } catch (err: unknown) {
        if (isUnknownMethodError(err)) {
          result = await client.request('chat.history', { sessionKey, limit: HISTORY_LIMIT });
        } else {
          throw err;
        }
      }

      if (this.state.sessionKey !== sessionKey) return; // Session changed during load

      const rawMessages = result?.messages ?? [];
      debugLog('[ChatCtrl] loadHistory AFTER-AWAIT:', sessionKey, {
        rawMsgCount: rawMessages.length,
        ...this._snap(),
      });
      // Remove stream-fallback messages — the real persisted message from the
      // gateway will replace them, preventing content duplication.
      const projectedMessages = rawMessages
        .filter(m => !shouldHideMessage(m))
        .filter(m => !(m as Record<string, unknown>)?.__openclawStreamFallback);
      const hydratedMessages = await hydrateMissingToolInputsFromLocalState(
        sessionKey,
        projectedMessages,
      );
      const messages = hydratedMessages.map(message =>
        normalizeFailedRunMessage(message, sessionKey, this.state.lastError),
      );

      // Guard: if the gateway returned no messages but we already have
      // materialized content from lifecycle:finishing, don't overwrite it.
      // The persisted message may not be available yet — chat.final will
      // append the real message once the gateway is ready.
      const hasMaterializedContent = this.state.chatMessages.some(
        m => (m as Record<string, unknown>)?.__openclawStreamFallback,
      );
      if (messages.length === 0 && hasMaterializedContent) {
        debugLog('[ChatCtrl] loadHistory: gateway returned empty, preserving materialized content');
        this.state.chatLoading = false;
        this.notify();
        return;
      }

      if (this.state.chatSending) {
        // A new run started while loadHistory was in flight — do NOT touch
        // chatMessages, overlays, or trigger a re-render.  The active run
        // owns all display state; loadHistory data will be fetched again in
        // flushPendingHistoryReload after the run ends.
        debugLog('[ChatCtrl] loadHistory: skipped — new run active, preserving in-flight state');
        this.state.chatLoading = false;
        return;
      }

      // Normal post-run load: replace everything with authoritative history.
      this.state.chatToolMessages = [];
      this.state.chatThinkingMessages = [];
      this.state.chatStreamSegments = [];
      this.state.chatMessages = messages;
      this.state.chatLoading = false;
      this.state.chatStream = null;
      this.state.chatThinkingStream = null;

      // Only clear pendingUserMessage if the user message is actually in the
      // loaded history.  For brand-new sessions the gateway may not have
      // persisted it yet — keep showing the optimistic bubble.
      if (this.state.pendingUserMessage) {
        const p = this.state.pendingUserMessage;
        const found = messages.some((m: unknown) => {
          const r = m as Record<string, unknown>;
          const timestamp = typeof r.timestamp === 'number' ? r.timestamp : null;
          const pendingTimestamp = typeof p.timestamp === 'number' ? p.timestamp : null;
          const timestampClose =
            timestamp == null ||
            pendingTimestamp == null ||
            Math.abs(timestamp - pendingTimestamp) < 60_000;
          return r.role === 'user' && messageText(r.content) === p.content && timestampClose;
        });
        if (found) {
          debugLog('[ChatCtrl] loadHistory OK — pendingUserMessage found in history, clearing');
          this.state.pendingUserMessage = null;
        } else {
          debugLog('[ChatCtrl] loadHistory OK — pendingUserMessage NOT in history, keeping', {
            pendingLen: p.content.length,
            userCandidates: messages
              .filter(m => (m as Record<string, unknown>).role === 'user')
              .slice(-3)
              .map(m => {
                const r = m as Record<string, unknown>;
                return {
                  contentLen: messageText(r.content).length,
                  timestamp: r.timestamp,
                };
              }),
          });
        }
      } else {
        debugLog('[ChatCtrl] loadHistory OK:', messages.length, 'messages');
      }

      this.notify();
    } catch (err) {
      if (this.state.sessionKey !== sessionKey) return;
      this.state.chatLoading = false;
      this.state.lastError = (err as Error).message;
      console.error('[ChatCtrl] loadHistory FAILED:', (err as Error).message);
      this.notify();
    }
  }

  // ─── Chat Event Handling ──────────────────────────────────────────────

  private handleChatEvent(payload: ChatEventPayload): void {
    // Only handle events for our session
    if (payload.sessionKey !== this.state.sessionKey) return;

    switch (payload.state) {
      case 'delta':
        this.handleDelta(payload);
        break;
      case 'final':
        this.handleFinal(payload);
        break;
      case 'aborted':
        this.handleAborted(payload);
        break;
      case 'error':
        this.handleError(payload);
        break;
    }
  }

  private handleDelta(payload: ChatEventPayload): void {
    if (
      this.assistantSnapshotRunId &&
      (!payload.runId || payload.runId === this.assistantSnapshotRunId)
    ) {
      this.ignoredDeltaAfterAssistantSnapshotCount += 1;
      if (this.ignoredDeltaAfterAssistantSnapshotCount === 1) {
        debugLog('[ChatCtrl] ▶ delta ignored after assistant snapshot', {
          runId: payload.runId ?? null,
          assistantSnapshotRunId: this.assistantSnapshotRunId,
        });
      }
      return;
    }

    const previous = this.state.chatStream;
    const deltaText = payload.deltaText;
    const snapshot = extractSnapshotText(payload.message);

    if (typeof deltaText === 'string') {
      if (payload.replace === true) {
        this.state.chatStream = deltaText;
      } else if (previous === null) {
        this.state.chatStream = typeof snapshot === 'string' ? snapshot : deltaText;
      } else if (typeof snapshot === 'string') {
        const prefixLength = snapshot.length - deltaText.length;
        const prefixMatches = prefixLength === previous.length && snapshot.slice(0, prefixLength) === previous;
        this.state.chatStream = prefixMatches ? `${previous}${deltaText}` : snapshot;
        debugLog('[ChatCtrl] ▶ delta merge', {
          previousLen: previous.length,
          deltaLen: deltaText.length,
          snapshotLen: snapshot.length,
          replace: Boolean(payload.replace),
          prefixMatches,
        });
      } else {
        this.state.chatStream = `${previous}${deltaText}`;
      }
    } else {
      this.state.chatStream = typeof snapshot === 'string' ? snapshot : null;
    }

    if (this.state.chatStream !== null) {
      this.state.chatStreamStartedAt ??= Date.now();
    }

    // Filter out NO_REPLY and heartbeat
    if (this.state.chatStream && isHiddenStreamText(this.state.chatStream)) {
      return; // Don't notify for hidden streams
    }

    this.notifyStream();
  }

  private handleFinal(payload: ChatEventPayload): void {
    this.clearLifecycleEndFallback();
    this.commitActiveThinking('final');
    const message = payload.message;
    const willAppend = message && !shouldHideMessage(message);
    const liveThinkingText = collectThinkingText(this.state.chatThinkingMessages);
    debugLog('[ChatCtrl] ▶ chat.final', {
      hasMessage: !!message,
      willAppend,
      msgRole: (message as Record<string, unknown>)?.role,
      finalContentType: Array.isArray((message as Record<string, unknown>)?.content) ? 'array' : typeof (message as Record<string, unknown>)?.content,
      ...this._snap(),
    });
    if (willAppend) {
      const terminalMessage = liveThinkingText
        ? withThinkingContent(message, liveThinkingText)
        : message;
      this.state.chatMessages = appendTerminalMessage(this.state.chatMessages, terminalMessage);
      this.state.chatStreamSegments = [];
    }
    this.state.chatStream = null;
    this.state.chatStreamStartedAt = null;
    this.state.chatThinkingStream = null;
    this.state.chatThinkingMessages = [];
    this.state.chatToolMessages = [];
    this.state.chatStreamSegments = [];
    this.state.chatSending = false;
    this.state.chatRunId = null;
    this.resetAssistantSnapshotSource();
    this.pendingHistoryReload = true;
    this.flushPendingHistoryReload();
    debugLog('[ChatCtrl] ▶ chat.final (done)', this._snap());
    this.notify();
  }

  private handleAborted(payload: ChatEventPayload): void {
    this.clearLifecycleEndFallback();
    const message = payload.message;
    debugLog('[ChatCtrl] ▶ chat.aborted', { hasMessage: !!message, ...this._snap() });
    if (message && !shouldHideMessage(message)) {
      this.state.chatMessages = [...this.state.chatMessages, message];
    }
    this.state.chatStream = null;
    this.state.chatStreamStartedAt = null;
    this.state.chatThinkingStream = null;
    this.state.chatSending = false;
    this.state.chatRunId = null;
    this.resetAssistantSnapshotSource();
    this.state.chatToolMessages = [];
    this.state.chatThinkingMessages = [];
    this.state.chatStreamSegments = [];
    this.flushPendingHistoryReload();
    this.notify();
  }

  private handleError(payload: ChatEventPayload): void {
    this.clearLifecycleEndFallback();
    this.state.lastError = payload.errorMessage ?? 'Unknown error';
    this.state.chatStream = null;
    this.state.chatStreamStartedAt = null;
    this.state.chatThinkingStream = null;
    this.state.chatSending = false;
    this.state.chatRunId = null;
    this.resetAssistantSnapshotSource();
    this.state.chatToolMessages = [];
    this.state.chatThinkingMessages = [];
    this.state.chatStreamSegments = [];
    this.flushPendingHistoryReload();
    this.notify();
  }

  private flushPendingHistoryReload(): void {
    if (this.pendingHistoryReload) {
      debugLog('[ChatCtrl] flushPendingHistoryReload → loadHistory:', this.state.sessionKey);
      this.pendingHistoryReload = false;
      this.loadHistory();
    }
  }

  // ─── Agent Tool Events ─────────────────────────────────────────────────

  /**
   * Handle `agent` / `session.tool` events.
   * Processes assistant streaming (stream=assistant) and tool streams (stream=tool).
   *
   * Gateway event structure (from gateway-bundle.mjs):
   *   payload = { runId, stream, session, agentId, aseq, data: { text, delta, phase, name, ... } }
   * All content fields live inside `payload.data`, not directly on `payload`.
   */
  private handleAgentEvent(payload: Record<string, unknown> | undefined, sourceEvent = 'agent'): void {
    if (!payload) return;

    const stream = typeof payload.stream === 'string' ? payload.stream : '';
    const runId = typeof payload.runId === 'string' ? payload.runId : null;
    const aseq = typeof payload.aseq === 'number' ? payload.aseq : null;

    // All content fields are nested inside payload.data
    const data = (typeof payload.data === 'object' && payload.data !== null ? payload.data : {}) as Record<string, unknown>;

    // Match session: gateway agent events may expose the session on either the
    // top-level payload or data. If it is absent, runId isolation below still
    // prevents title/subtask runs from mutating the active chat surface.
    const eventSession =
      stringField(payload, 'session') ??
      stringField(payload, 'sessionKey') ??
      stringField(payload, 'key') ??
      stringField(data, 'session') ??
      stringField(data, 'sessionKey') ??
      stringField(data, 'key') ??
      '';
    if (eventSession && eventSession !== this.state.sessionKey && !this.state.sessionKey.endsWith(eventSession)) {
      debugLog('[ChatCtrl] ▶ event ignored (session mismatch)', {
        sourceEvent,
        stream,
        runId,
        eventSession,
        sessionKey: this.state.sessionKey,
      });
      return;
    }
    if (runId && this.state.chatRunId && runId !== this.state.chatRunId) {
      debugLog('[ChatCtrl] ▶ event ignored (run mismatch)', {
        sourceEvent,
        stream,
        runId,
        chatRunId: this.state.chatRunId,
        eventSession,
      });
      return;
    }

    // ── Thinking streaming ───────────────────────────────────────────────
    // Agent events with stream=thinking carry the full thinking text snapshot.
    if (stream === 'thinking') {
      const text = typeof data.text === 'string' ? data.text : null;
      if (!text) return;

      const wasSending = this.state.chatSending;
      if (!this.state.chatSending) {
        this.state.chatSending = true;
        this.state.chatRunId = runId;
        this.state.chatStreamStartedAt ??= Date.now();
      }

      if (!this.state.chatThinkingStream && this.state.chatStream) {
        this.commitActiveStreamSegment();
      }

      const previousLen = this.state.chatThinkingStream?.length ?? 0;
      this.state.chatThinkingStream = text;
      debugLog('[ChatCtrl] ▶ thinking', {
        sourceEvent,
        runId,
        aseq,
        textLen: text.length,
        previousLen,
        wasSending,
        textTail: text.slice(-40),
        ...this._snap(),
      });
      this.notifyStream();
      return;
    }

    // ── Assistant streaming ──────────────────────────────────────────────
    // The gateway sends agent events with stream=assistant containing the
    // full accumulated text snapshot. Use this for real-time display.
    if (stream === 'assistant') {
      const text = typeof data.text === 'string' ? data.text : null;
      if (!text) return;

      const wasSending = this.state.chatSending;
      if (!this.state.chatSending) {
        this.state.chatSending = true;
        this.state.chatRunId = runId;
        this.state.chatStreamStartedAt ??= Date.now();
      }

      this.commitActiveThinking('assistant');

      // Gateway sends full text snapshot, not incremental deltas
      this.assistantSnapshotRunId = runId ?? this.state.chatRunId;
      this.state.chatStream = text;

      // Filter out NO_REPLY and heartbeat
      if (this.state.chatStream && isHiddenStreamText(this.state.chatStream)) {
        debugLog('[ChatCtrl] ▶ assistant (hidden)', { textLen: text.length });
        return;
      }

      debugLog('[ChatCtrl] ▶ assistant', { sourceEvent, runId, aseq, wasSending, textLen: text.length, textTail: text.slice(-40), ...this._snap() });
      this.notifyStream();
      return;
    }

    // ── Lifecycle events ─────────────────────────────────────────────────
    if (stream === 'lifecycle') {
      const phase = typeof data.phase === 'string' ? data.phase : '';
      debugLog('[ChatCtrl] lifecycle:', phase, this.state.sessionKey, {
        chatSending: this.state.chatSending,
        hasStream: !!this.state.chatStream,
        pendingReload: this.pendingHistoryReload,
      });
      if (phase === 'start') {
        this.clearLifecycleEndFallback();
        if (!this.state.chatSending) {
          this.state.chatSending = true;
          this.state.chatStreamStartedAt ??= Date.now();
        }
        if (runId && !this.state.chatRunId) {
          this.state.chatRunId = runId;
        }
        this.notifyStream();
      }
      if (phase === 'finishing') {
        // The gateway can emit lifecycle:finishing before the final chat event,
        // and sometimes before the last thinking/assistant deltas. Keep the
        // live overlays intact; chat.final or the fallback below will reconcile.
        if (runId && !this.state.chatRunId) {
          this.state.chatRunId = runId;
        }
        this.notifyStream();
      }
      if (phase === 'end') {
        // Do not clear stream/thinking/tool overlays here. chat.final is the
        // authoritative terminal event; lifecycle:end may arrive while more
        // visible deltas are still in flight. Use a short fallback for older
        // gateways or interrupted streams that never send chat.final.
        if (this.state.chatSending) {
          if (runId && !this.state.chatRunId) {
            this.state.chatRunId = runId;
          }
          const endingRunId = this.state.chatRunId;
          this.clearLifecycleEndFallback();
          this.lifecycleEndFallbackTimer = setTimeout(() => {
            this.lifecycleEndFallbackTimer = null;
            if (!this.state.chatSending || this.state.chatRunId !== endingRunId) return;
            debugLog('[ChatCtrl] ▶ lifecycle:end fallback', this._snap());
            this.state.chatSending = false;
            this.state.chatRunId = null;
            this.flushPendingHistoryReload();
            this.notify();
          }, 1500);
          this.notifyStream();
        }
      }
      if (phase === 'error') {
        const errorMessage =
          typeof data.error === 'string' && data.error.trim()
            ? data.error.trim()
            : 'Unknown error';
        this.clearLifecycleEndFallback();
        this.state.lastError = errorMessage;
        persistFailedRun({
          sessionKey: this.state.sessionKey,
          runId,
          error: errorMessage,
          timestamp: Date.now(),
        });
        this.state.chatStream = null;
        this.state.chatStreamStartedAt = null;
        this.state.chatThinkingStream = null;
        this.state.chatSending = false;
        this.state.chatRunId = null;
        this.resetAssistantSnapshotSource();
        this.state.chatToolMessages = [];
        this.state.chatThinkingMessages = [];
        this.state.chatStreamSegments = [];
        this.pendingHistoryReload = true;
        this.flushPendingHistoryReload();
        this.notify();
      }
      return;
    }

    // ── Tool streams ─────────────────────────────────────────────────────
    if (stream !== 'tool') return;

    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : null;
    const name = typeof data.name === 'string' ? data.name : '';
    const phase = typeof data.phase === 'string' ? data.phase : '';
    const args = data.args;

    if (!toolCallId || !name) {
      debugLog('[ChatCtrl] ▶ tool (ignored, missing toolCallId/name)', { stream, toolCallId, name });
      return;
    }

    debugLog('[ChatCtrl] ▶ tool', {
      sourceEvent,
      runId,
      aseq,
      toolCallId,
      name,
      phase,
      segCount: this.state.chatStreamSegments.length,
      toolMsgCount: this.state.chatToolMessages.length,
      hasStream: !!this.state.chatStream,
    });

    // On tool-start: commit current stream as a segment
    if (phase === 'start' || phase === '') {
      this.commitActiveThinking('tool');
      this.commitActiveStreamSegment();

      const toolMessage = this.buildToolMessage({
        toolCallId,
        runId,
        name,
        args,
        isActive: true,
      });
      const upsert = this.upsertToolMessage(toolMessage);
      debugLog('[ChatCtrl] ▶ tool upsert(start)', { sourceEvent, toolCallId, existingIndex: upsert.existingIndex, nextCount: upsert.nextCount });
      this.notifyStream();
      return;
    }

    // On tool-result/update: update the tool message with the best available
    // output. OpenClaw may send object results or partialResult updates.
    const error = stringifyToolOutput(data.error);
    const hasPartialResult = data.partialResult !== undefined;
    const isNonTerminalToolEvent = isNonTerminalToolPhase(phase);
    const hasTerminalOutput =
      data.result !== undefined ||
      data.output !== undefined ||
      data.content !== undefined ||
      (data.text !== undefined && !isNonTerminalToolEvent) ||
      error !== null;
    const isTerminalToolEvent =
      !isNonTerminalToolEvent && (isTerminalToolPhase(phase) || hasTerminalOutput);
    const output = stringifyToolOutput(
      data.result ?? data.partialResult ?? data.output ?? data.content ?? data.text,
    ) ?? error ?? '';

    const toolMessage = this.buildToolMessage({
      toolCallId,
      runId,
      name,
      args,
      output,
      isError: Boolean(error),
      isActive: isNonTerminalToolEvent || (hasPartialResult && !isTerminalToolEvent),
    });
    const upsert = this.upsertToolMessage(toolMessage);
    debugLog('[ChatCtrl] ▶ tool upsert(result)', {
      sourceEvent,
      toolCallId,
      phase,
      existingIndex: upsert.existingIndex,
      nextCount: upsert.nextCount,
      outputLen: output.length,
      resultType: typeof data.result,
      partialResultType: typeof data.partialResult,
      errorType: typeof data.error,
    });
    this.notifyStream();
  }

  // ─── Send Message ─────────────────────────────────────────────────────

  async sendMessage(message: string): Promise<void> {
    const client = this.state.client;
    if (!client || !this.state.connected) throw new Error('not connected');
    if (this.state.chatSending) return;

    const runId = `justdo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    debugLog('[ChatCtrl] sendMessage:', message.slice(0, 60), { sessionKey: this.state.sessionKey, runId });

    // Optimistic: append user message immediately
    const userMessage = { role: 'user', content: message, timestamp: Date.now() };
    this.state.chatMessages = [...this.state.chatMessages, userMessage];
    this.state.chatThinkingMessages = [];
    this.state.chatToolMessages = [];
    this.state.chatStreamSegments = [];
    this.state.chatSending = true;
    this.state.chatRunId = runId;
    this.resetAssistantSnapshotSource();
    this.state.chatStream = '';
    this.state.chatStreamStartedAt = Date.now();
    this.state.lastError = null;
    this.notify();

    try {
      const ack = await client.request<{ runId?: string; status?: string }>('chat.send', {
        sessionKey: this.state.sessionKey,
        message,
        deliver: false,
        idempotencyKey: runId,
      });

      if (ack?.runId) {
        this.state.chatRunId = ack.runId;
      }

      // If status is "ok", the run already completed
      if (ack?.status === 'ok') {
        this.state.chatSending = false;
        this.state.chatRunId = null;
        this.resetAssistantSnapshotSource();
        this.state.chatStream = null;
        this.notify();
      }
    } catch (err) {
      this.state.chatSending = false;
      this.state.chatRunId = null;
      this.resetAssistantSnapshotSource();
      this.state.chatStream = null;
      this.state.lastError = (err as Error).message;
      // Add error as assistant message
      this.state.chatMessages = [
        ...this.state.chatMessages,
        { role: 'assistant', content: `Error: ${(err as Error).message}`, timestamp: Date.now() },
      ];
      this.notify();
    }
  }

  /** Abort the current run */
  async abort(): Promise<void> {
    const client = this.state.client;
    if (!client || !this.state.connected || !this.state.chatRunId) return;
    try {
      await client.request('chat.abort', {
        sessionKey: this.state.sessionKey,
        runId: this.state.chatRunId,
      });
    } catch {
      // Ignore abort errors
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isTempJustDoSessionKey(sessionKey: string): boolean {
  return /:justdo:temp-[^:]+$/.test(sessionKey);
}

function extractSnapshotText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;
  if (typeof m.text === 'string') return m.text;
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    const texts = m.content
      .filter((b: unknown) => {
        const block = b as Record<string, unknown>;
        return block.type === 'text' && typeof block.text === 'string';
      })
      .map((b: unknown) => (b as Record<string, unknown>).text as string);
    return texts.length > 0 ? texts.join('') : null;
  }
  return null;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(item => {
      if (!item || typeof item !== 'object') return '';
      const text = (item as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

function collectThinkingText(messages: unknown[]): string | null {
  const text = messages
    .map(message => {
      const content = (message as Record<string, unknown> | undefined)?.content;
      if (!Array.isArray(content)) return '';
      return content
        .map(item => (item as Record<string, unknown> | undefined)?.thinking)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

function withThinkingContent(message: unknown, thinkingText: string): unknown {
  if (!message || typeof message !== 'object' || !thinkingText.trim()) return message;
  const record = message as Record<string, unknown>;
  const content = record.content;
  const thinkingBlock = { type: 'thinking', thinking: thinkingText.trim() };

  if (Array.isArray(content)) {
    const alreadyHasThinking = content.some(item => {
      const block = item as Record<string, unknown>;
      return block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim();
    });
    return alreadyHasThinking
      ? message
      : {
          ...record,
          content: [thinkingBlock, ...content],
        };
  }

  if (typeof content === 'string') {
    return {
      ...record,
      content: [thinkingBlock, { type: 'text', text: content }],
    };
  }

  if (typeof record.text === 'string') {
    return {
      ...record,
      content: [thinkingBlock, { type: 'text', text: record.text }],
    };
  }

  return {
    ...record,
    content: [thinkingBlock],
  };
}

function shouldHideMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  const role = typeof m.role === 'string' ? m.role.toLowerCase() : '';

  // Hide NO_REPLY assistant messages
  if (role === 'assistant') {
    const text = extractSnapshotText(message);
    if (text && SILENT_REPLY_PATTERN.test(text.trim())) return true;
  }

  // Hide heartbeat messages
  if (role === 'assistant') {
    const text = extractSnapshotText(message);
    if (text && text.includes('HEARTBEAT_OK')) return true;
  }

  return false;
}

function isHiddenStreamText(text: string): boolean {
  const trimmed = text.trim();
  return SILENT_REPLY_PATTERN.test(trimmed) || trimmed.includes('HEARTBEAT_OK');
}

function appendTerminalMessage(messages: unknown[], terminal: unknown): unknown[] {
  // Find and replace any stream-fallback message that matches
  const terminalText = extractSnapshotText(terminal);
  const result: unknown[] = [];

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    // Skip stream-fallback messages that the terminal replaces
    if ((m as Record<string, unknown>).__openclawStreamFallback) {
      const fallbackText = (m as Record<string, unknown>).replacementText as string | undefined;
      if (terminalText && fallbackText && terminalText.startsWith(fallbackText)) {
        continue; // Replace this fallback
      }
    }
    result.push(msg);
  }

  result.push(terminal);
  return result;
}

function stringifyToolOutput(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isTerminalToolPhase(phase: string): boolean {
  return ['end', 'complete', 'completed', 'finish', 'finished', 'result', 'error'].includes(
    phase.toLowerCase(),
  );
}

function isNonTerminalToolPhase(phase: string): boolean {
  return ['delta', 'partial', 'progress', 'update', 'streaming'].includes(phase.toLowerCase());
}

function isUnknownMethodError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes('unknown method') || (err as { gatewayCode?: string }).gatewayCode === 'METHOD_NOT_FOUND';
  }
  return false;
}
