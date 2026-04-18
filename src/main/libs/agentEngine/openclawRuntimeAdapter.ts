import { randomUUID } from 'crypto';
import { app, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { PermissionResult } from './types';
import type {
  CoworkMessage,
  CoworkSession,
  CoworkSessionStatus,
  CoworkExecutionMode,
  CoworkStore,
} from '../../coworkStore';
import {
  OpenClawEngineManager,
  type OpenClawGatewayConnectionInfo,
} from '../openclawEngineManager';
import type {
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
  PermissionRequest,
} from './types';
import {
  buildManagedSessionKey,
  type OpenClawChannelSessionSync,
  isManagedSessionKey,
  parseManagedSessionKey,
  isCronSessionKey,
} from '../openclawChannelSessionSync';
import { extractGatewayHistoryEntries, extractGatewayMessageText } from '../openclawHistory';
import { extractOpenClawAssistantStreamText } from '../openclawAssistantText';
import { buildOpenClawLocalTimeContextPrompt } from '../openclawLocalTimeContextPrompt';
import { isDeleteCommand, getCommandDangerLevel } from '../commandSafety';
import { setCoworkProxySessionId } from '../coworkOpenAICompatProxy';
import { OPENCLAW_AGENT_TIMEOUT_SECONDS } from '../openclawConfigSync';
import { t } from '../../i18n';

const OPENCLAW_GATEWAY_TOOL_EVENTS_CAP = 'tool-events';
const BRIDGE_MAX_MESSAGES = 20;
const BRIDGE_MAX_MESSAGE_CHARS = 1200;
const GATEWAY_READY_TIMEOUT_MS = 15_000;
const FINAL_HISTORY_SYNC_LIMIT = 50;
const CHANNEL_SESSION_DISCOVERY_LIMIT = 200;

type GatewayEventFrame = {
  event: string;
  seq?: number;
  payload?: unknown;
};

type GatewayClientLike = {
  start: () => void;
  stop: () => void;
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

type GatewayClientCtor = new (options: Record<string, unknown>) => GatewayClientLike;

type ChatEventState = 'delta' | 'final' | 'aborted' | 'error';

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: ChatEventState;
  message?: unknown;
  errorMessage?: string;
  stopReason?: string;
};

type AgentEventPayload = {
  seq?: number;
  runId?: string;
  sessionKey?: string;
  /** Alternative field name used by some gateway events (e.g., agent lifecycle events) */
  session?: string;
  stream?: string;
  data?: unknown;
  /** Gateway tool event fields: tool='result:sessions_spawn', call='toolCallId', meta='label xxx' */
  tool?: string;
  call?: string;
  meta?: string;
  err?: boolean;
};

type ExecApprovalRequestedPayload = {
  id?: string;
  request?: {
    command?: string;
    cwd?: string | null;
    host?: string | null;
    security?: string | null;
    ask?: string | null;
    resolvedPath?: string | null;
    sessionKey?: string | null;
    agentId?: string | null;
  };
};

type ExecApprovalResolvedPayload = {
  id?: string;
};

type TextStreamMode = 'unknown' | 'snapshot' | 'delta';

type ActiveTurn = {
  sessionId: string;
  sessionKey: string;
  runId: string;
  turnToken: number;
  knownRunIds: Set<string>;
  assistantMessageId: string | null;
  committedAssistantText: string;
  currentAssistantSegmentText: string;
  currentText: string;
  /** Highest text length from agent assistant events (immune to chat delta noise). */
  agentAssistantTextLength: number;
  currentContentText: string;
  currentContentBlocks: string[];
  sawNonTextContentBlocks: boolean;
  textStreamMode: TextStreamMode;
  toolUseMessageIdByToolCallId: Map<string, string>;
  toolResultMessageIdByToolCallId: Map<string, string>;
  toolResultTextByToolCallId: Map<string, string>;
  stopRequested: boolean;
  /** True while async user message prefetch is in progress for channel sessions. */
  pendingUserSync: boolean;
  /** Chat events buffered while pendingUserSync is true. */
  bufferedChatPayloads: BufferedChatEvent[];
  /** Agent events buffered while pendingUserSync is true. */
  bufferedAgentPayloads: BufferedAgentEvent[];
  /** Client-side timeout watchdog timer (fallback for missing gateway abort events). */
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** Message ID for current thinking stream (created on first thinking event). */
  currentThinkingMessageId: string | null;
  /** Accumulated thinking content for current stream. */
  currentThinkingContent: string;
  /** True when thinking stream has ended (first text or non-thinking event received). */
  thinkingStreamEnded: boolean;
  /** Model name for this turn's assistant messages (captured at turn start). */
  modelName: string;
};

type BufferedChatEvent = {
  payload: unknown;
  seq: number | undefined;
  bufferedAt: number;
};

type BufferedAgentEvent = {
  payload: unknown;
  seq: number | undefined;
  bufferedAt: number;
};

type PendingApprovalEntry = {
  requestId: string;
  sessionId: string;
  /** When true, use 'allow-always' decision so OpenClaw adds the command to its allowlist. */
  allowAlways?: boolean;
};

type ChannelHistorySyncEntry = {
  role: 'user' | 'assistant';
  text: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const isSameChannelHistoryEntry = (
  left: ChannelHistorySyncEntry,
  right: ChannelHistorySyncEntry,
): boolean => {
  return left.role === right.role && left.text === right.text;
};

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
};

/** Strip Discord mention markup: <@userId>, <@!userId>, <#channelId>, <@&roleId> */
const stripDiscordMentions = (text: string): string =>
  text
    .replace(/<@!?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/<@&\d+>/g, '')
    .trim();

const extractMessageText = extractGatewayMessageText;

const summarizeGatewayMessageShape = (message: unknown): string => {
  if (!isRecord(message)) {
    return `non-record:${typeof message}`;
  }

  const role = typeof message.role === 'string' ? message.role : '?';
  const content = message.content;
  if (typeof content === 'string') {
    return `role=${role} content=string(${content.length}) text="${truncate(content, 120)}"`;
  }
  if (Array.isArray(content)) {
    const parts = content.map(item => {
      if (!isRecord(item)) return typeof item;
      const type = typeof item.type === 'string' ? item.type : 'object';
      const text = typeof item.text === 'string' ? `:${truncate(item.text, 60)}` : '';
      return `${type}${text}`;
    });
    return `role=${role} content=[${parts.join(', ')}]`;
  }
  if (isRecord(content)) {
    return `role=${role} contentKeys=${Object.keys(content).join(',')}`;
  }
  if (typeof message.text === 'string') {
    return `role=${role} text=${truncate(message.text, 120)}`;
  }
  return `role=${role} keys=${Object.keys(message).join(',')}`;
};

const extractTextBlocksAndSignals = (
  message: unknown,
): { textBlocks: string[]; sawNonTextContentBlocks: boolean } => {
  if (!isRecord(message)) {
    return {
      textBlocks: [],
      sawNonTextContentBlocks: false,
    };
  }

  const content = message.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return {
      textBlocks: text ? [text] : [],
      sawNonTextContentBlocks: false,
    };
  }
  if (!Array.isArray(content)) {
    return {
      textBlocks: [],
      sawNonTextContentBlocks: false,
    };
  }

  const textBlocks: string[] = [];
  let sawNonTextContentBlocks = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text) {
        textBlocks.push(text);
      }
      continue;
    }
    if (typeof block.type === 'string' && block.type !== 'thinking') {
      sawNonTextContentBlocks = true;
      console.log(
        '[Debug:extractBlocks] non-text block type:',
        block.type,
        'content:',
        JSON.stringify(block).slice(0, 500),
      );
    }
  }

  return {
    textBlocks,
    sawNonTextContentBlocks,
  };
};

/**
 * Extract file paths from assistant "message" tool calls in chat.history.
 * Only scans messages after the last user message (current turn).
 * The model sends files to Telegram using: toolCall { name: "message", arguments: { action: "send", filePath: "..." } }
 */
const extractSentFilePathsFromHistory = (messages: unknown[]): string[] => {
  // Find the last user message index to scope to current turn only
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRecord(msg) && (msg as Record<string, unknown>).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const filePaths: string[] = [];
  const seen = new Set<string>();
  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
    if (role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (!isRecord(block)) continue;
      if (block.type !== 'toolCall' || block.name !== 'message') continue;
      const args = block.arguments;
      if (!isRecord(args)) continue;
      const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        filePaths.push(filePath);
      }
    }
  }
  return filePaths;
};

/**
 * Extract and concatenate all assistant text from the current turn in chat.history.
 * The current turn starts after the last user message.
 */
const extractCurrentTurnAssistantText = (messages: unknown[]): string => {
  // Find the last user message index (turn boundary)
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRecord(msg) && (msg as Record<string, unknown>).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  const textParts: string[] = [];
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
    if (role !== 'assistant') continue;
    const text = extractMessageText(msg).trim();
    if (text) {
      textParts.push(text);
    }
  }
  return textParts.join('\n\n');
};

const isDroppedBoundaryTextBlockSubset = (
  streamedTextBlocks: string[],
  finalTextBlocks: string[],
): boolean => {
  if (finalTextBlocks.length === 0 || finalTextBlocks.length >= streamedTextBlocks.length) {
    return false;
  }
  if (finalTextBlocks.every((block, index) => streamedTextBlocks[index] === block)) {
    return true;
  }
  const suffixStart = streamedTextBlocks.length - finalTextBlocks.length;
  return finalTextBlocks.every((block, index) => streamedTextBlocks[suffixStart + index] === block);
};

const extractToolText = (payload: unknown): string => {
  if (typeof payload === 'string') {
    return payload;
  }

  if (Array.isArray(payload)) {
    const lines = payload.map(item => extractToolText(item).trim()).filter(Boolean);
    if (lines.length > 0) {
      return lines.join('\n');
    }
  }

  if (!isRecord(payload)) {
    if (payload === undefined || payload === null) return '';
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  }

  if (typeof payload.text === 'string' && payload.text.trim()) {
    return payload.text;
  }
  if (typeof payload.output === 'string' && payload.output.trim()) {
    return payload.output;
  }
  if (typeof payload.stdout === 'string' || typeof payload.stderr === 'string') {
    const chunks = [
      typeof payload.stdout === 'string' ? payload.stdout : '',
      typeof payload.stderr === 'string' ? payload.stderr : '',
    ].filter(Boolean);
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }

  const content = payload.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      if (typeof item === 'string' && item.trim()) {
        chunks.push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      if (typeof item.text === 'string' && item.text.trim()) {
        chunks.push(item.text);
        continue;
      }
      if (typeof item.content === 'string' && item.content.trim()) {
        chunks.push(item.content);
      }
    }
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
};

const toToolInputRecord = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return {};
  }
  return { value };
};

const computeSuffixPrefixOverlap = (left: string, right: string): number => {
  const leftProbe = left.slice(-256);
  const rightProbe = right.slice(0, 256);
  const maxOverlap = Math.min(leftProbe.length, rightProbe.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (leftProbe.slice(-size) === rightProbe.slice(0, size)) {
      return size;
    }
  }
  return 0;
};

const mergeStreamingText = (
  previousText: string,
  incomingText: string,
  mode: TextStreamMode,
): { text: string; mode: TextStreamMode } => {
  if (!incomingText) {
    return { text: previousText, mode };
  }
  if (!previousText) {
    return { text: incomingText, mode };
  }
  if (incomingText === previousText) {
    return { text: previousText, mode };
  }

  if (mode === 'snapshot') {
    if (previousText.startsWith(incomingText) && incomingText.length < previousText.length) {
      return { text: previousText, mode };
    }
    return { text: incomingText, mode };
  }

  if (mode === 'delta') {
    if (incomingText.startsWith(previousText)) {
      return { text: incomingText, mode: 'snapshot' };
    }
    const overlap = computeSuffixPrefixOverlap(previousText, incomingText);
    return { text: previousText + incomingText.slice(overlap), mode };
  }

  if (incomingText.startsWith(previousText)) {
    return { text: incomingText, mode: 'snapshot' };
  }
  if (previousText.startsWith(incomingText)) {
    return { text: previousText, mode: 'snapshot' };
  }
  if (incomingText.includes(previousText) && incomingText.length > previousText.length) {
    return { text: incomingText, mode: 'snapshot' };
  }

  const overlap = computeSuffixPrefixOverlap(previousText, incomingText);
  if (overlap > 0) {
    return { text: previousText + incomingText.slice(overlap), mode: 'delta' };
  }

  return { text: previousText + incomingText, mode: 'delta' };
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

const waitWithTimeout = async (promise: Promise<void>, timeoutMs: number): Promise<void> => {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<void>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`OpenClaw gateway client connect timeout after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export class OpenClawRuntimeAdapter extends EventEmitter implements CoworkRuntime {
  private readonly store: CoworkStore;
  private readonly engineManager: OpenClawEngineManager;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly sessionIdBySessionKey = new Map<string, string>();
  private readonly sessionIdByRunId = new Map<string, string>();
  private readonly pendingAgentEventsByRunId = new Map<string, AgentEventPayload[]>();
  private readonly lastChatSeqByRunId = new Map<string, number>();
  private readonly lastAgentSeqByRunId = new Map<string, number>();
  private readonly pendingApprovals = new Map<string, PendingApprovalEntry>();
  private readonly pendingTurns = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly confirmationModeBySession = new Map<string, 'modal' | 'text'>();
  private readonly bridgedSessions = new Set<string>();
  private readonly lastSystemPromptBySession = new Map<string, string>();
  private readonly gatewayHistoryCountBySession = new Map<string, number>();
  private readonly latestTurnTokenBySession = new Map<string, number>();

  /**
   * Sessions that were manually stopped by the user via stopSession().
   * Maps sessionId → timestamp of when stop was requested.
   * Used to suppress automatic ActiveTurn re-creation from late-arriving
   * OpenClaw Gateway events (e.g. POPO/Telegram channel events that arrive
   * after the user clicked Stop).  Entries expire after STOP_COOLDOWN_MS.
   */
  private readonly stoppedSessions = new Map<string, number>();
  private static readonly STOP_COOLDOWN_MS = 10_000; // 10 seconds

  private gatewayClient: GatewayClientLike | null = null;
  private gatewayClientVersion: string | null = null;
  private gatewayClientEntryPath: string | null = null;
  /** Holds the client between start() and onHelloOk so stopGatewayClient can clean it up. */
  private pendingGatewayClient: GatewayClientLike | null = null;
  private gatewayReadyPromise: Promise<void> | null = null;
  /** Serializes concurrent calls to ensureGatewayClientReady to prevent duplicate clients. */
  private gatewayClientInitLock: Promise<void> | null = null;
  private channelSessionSync: OpenClawChannelSessionSync | null = null;
  private readonly knownChannelSessionIds = new Set<string>();
  private readonly fullySyncedSessions = new Set<string>();
  /** Per-session cursor: number of gateway history entries (user+assistant) already synced locally. */
  private readonly channelSyncCursor = new Map<string, number>();
  /** Sessions re-created after user deletion — use latestOnly sync to avoid replaying old history. */
  private readonly reCreatedChannelSessionIds = new Set<string>();
  /** Channel sessionKeys explicitly deleted by the user. Polling will not re-create these. */
  private readonly deletedChannelKeys = new Set<string>();
  /** Sessions that were manually stopped by the user. Used to suppress the timeout hint
   *  when the gateway sends back a late 'aborted' event after stopSession() already cleaned up the turn. */
  private readonly manuallyStoppedSessions = new Set<string>();
  /** Session keys whose origin is "heartbeat" — discovered via polling, used to filter real-time events. */
  private readonly heartbeatSessionKeys = new Set<string>();
  private channelPollingTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly CHANNEL_POLL_INTERVAL_MS = 10_000;
  private static readonly FULL_HISTORY_SYNC_LIMIT = 50;
  private browserPrewarmAttempted = false;

  /** Gateway WS auto-reconnect state */
  private gatewayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private gatewayReconnectAttempt = 0;
  /** Set to true before intentionally stopping the client (e.g. version upgrade) to suppress auto-reconnect. */
  private gatewayStoppingIntentionally = false;
  private static readonly GATEWAY_RECONNECT_MAX_ATTEMPTS = 10;
  private static readonly GATEWAY_RECONNECT_DELAYS = [2_000, 5_000, 10_000, 15_000, 30_000]; // ms

  /** Gateway tick heartbeat watchdog state */
  private lastTickTimestamp = 0;
  private tickWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly TICK_WATCHDOG_INTERVAL_MS = 60_000; // check every 60s
  private static readonly TICK_TIMEOUT_MS = 90_000; // 3 tick cycles (30s each) without response → dead

  /** Throttle state for messageUpdate IPC emissions during streaming */
  private lastMessageUpdateEmitTime: Map<string, number> = new Map();
  private pendingMessageUpdateTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static readonly MESSAGE_UPDATE_THROTTLE_MS = 200;

  /** Throttle state for SQLite store writes during streaming */
  private lastStoreUpdateTime: Map<string, number> = new Map();
  private pendingStoreUpdateTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static readonly STORE_UPDATE_THROTTLE_MS = 250;

  /**
   * Server-side agent timeout in seconds (mirrors agents.defaults.timeoutSeconds in openclaw config).
   * Used to set a client-side fallback timer that fires slightly after the server timeout,
   * so GucciAI can recover even when the gateway fails to deliver the abort event.
   */
  agentTimeoutSeconds = OPENCLAW_AGENT_TIMEOUT_SECONDS;
  private static readonly CLIENT_TIMEOUT_GRACE_MS = 30_000;

  /** 子 Agent 消息历史: agentId/label → 消息数组 */
  private readonly subagentMessages = new Map<string, Array<{ role: string; content: string }>>();
  /** 子 Agent 完成状态: agentId/label → 'running' | 'done' */
  private readonly subagentStatus = new Map<string, 'running' | 'done'>();
  /** 编排父会话 ID，用于隔离会话 */
  private orchestrationParentSessionId: string | null = null;
  /** label → childSessionKey 映射，用于关联子任务和消息 */
  private readonly labelToSessionKey = new Map<string, string>();
  /** childSessionKey → label 反向映射 */
  private readonly sessionKeyToLabel = new Map<string, string>();
  /** toolCallId → args 映射，用于在 result 阶段获取 sessions_spawn 的参数 */
  private readonly toolCallArgs = new Map<string, Record<string, unknown>>();

  constructor(store: CoworkStore, engineManager: OpenClawEngineManager) {
    super();
    this.store = store;
    this.engineManager = engineManager;
  }

  setChannelSessionSync(sync: OpenClawChannelSessionSync): void {
    this.channelSessionSync = sync;
  }

  /**
   * Fetch session history from OpenClaw by sessionKey and return a transient
   * CoworkSession object (not persisted to local database).
   * First checks if a local session already exists via channel sync.
   * Returns a CoworkSession if successful, or null.
   */
  async fetchSessionByKey(sessionKey: string): Promise<CoworkSession | null> {
    const managedSession = parseManagedSessionKey(sessionKey);
    if (managedSession) {
      return this.store.getSession(managedSession.sessionId) ?? null;
    }

    // 1. Try existing local session via channel/main-agent resolution
    if (this.channelSessionSync) {
      const existingId = this.channelSessionSync.resolveSession(sessionKey);
      if (existingId) {
        const session = this.store.getSession(existingId);
        if (session && session.messages.length > 0) {
          return session;
        }
      }
    }

    // 2. Fetch history from OpenClaw server and build a transient session object
    const client = this.gatewayClient;
    if (!client) return null;

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: OpenClawRuntimeAdapter.FULL_HISTORY_SYNC_LIMIT,
      });
      if (!Array.isArray(history?.messages) || history.messages.length === 0) {
        return this.readFromDeletedTranscript(sessionKey);
      }

      const now = Date.now();
      const messages: CoworkMessage[] = [];
      let msgIndex = 0;

      for (const entry of extractGatewayHistoryEntries(history.messages)) {
        messages.push({
          id: `transient-${msgIndex++}`,
          type: entry.role,
          content: entry.text,
          timestamp: now,
          metadata: entry.role === 'assistant' ? { isStreaming: false, isFinal: true } : {},
        });
      }

      if (messages.length === 0) return null;

      // Return a transient session (not saved to database)
      return {
        id: `transient-${sessionKey}`,
        title: sessionKey.split(':').pop() || 'Cron Session',
        claudeSessionId: null,
        status: 'completed' as CoworkSessionStatus,
        pinned: false,
        cwd: '',
        systemPrompt: '',
        executionMode: 'local' as CoworkExecutionMode,
        activeSkillIds: [],
        messages,
        agentId: 'main',
        createdAt: now,
        updatedAt: now,
      };
    } catch (error) {
      console.error('[OpenClawRuntime] fetchSessionByKey: failed to fetch history:', error);
      return null;
    }
  }

  /**
   * Fallback for fetchSessionByKey when chat.history returns no messages.
   *
   * openclaw's maintenance logic may archive a session transcript by renaming
   * `{sessionId}.jsonl` → `{sessionId}.jsonl.deleted.{timestamp}` while the
   * session entry remains in sessions.json. In that case chat.history cannot
   * find the file (it only looks for the plain `.jsonl` path) and returns [].
   * This method reads the archived file directly from disk.
   */
  private async readFromDeletedTranscript(sessionKey: string): Promise<CoworkSession | null> {
    try {
      // Extract agentId from "agent:{agentId}:..." pattern
      const agentMatch = sessionKey.match(/^agent:([^:]+):/);
      const agentId = agentMatch?.[1] ?? 'main';

      // Extract sessionId from "...run:{uuid}" pattern (runId equals sessionId)
      const runMatch = sessionKey.match(/(?:^|:)run:([0-9a-f-]{36})(?:$|:)/i);
      const sessionId = runMatch?.[1];
      if (!sessionId) return null;

      const stateDir = this.engineManager.getStateDir();
      const sessionsDir = path.join(stateDir, 'agents', agentId, 'sessions');

      const files = await fs.promises.readdir(sessionsDir).catch(() => [] as string[]);
      const deletedFile = files.find(f => f.startsWith(`${sessionId}.jsonl.deleted.`));
      if (!deletedFile) {
        console.log(
          '[OpenClawRuntime] readFromDeletedTranscript: no archived transcript found for sessionId:',
          sessionId,
        );
        return null;
      }

      console.log(
        '[OpenClawRuntime] readFromDeletedTranscript: reading archived transcript:',
        deletedFile,
      );
      const filePath = path.join(sessionsDir, deletedFile);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);

      const messages: CoworkMessage[] = [];
      let msgIndex = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed?.type !== 'message' || !parsed.message) continue;
          const msg = parsed.message as { role?: string; content?: unknown; timestamp?: number };
          const role = msg.role;
          if (role !== 'user' && role !== 'assistant') continue;

          const msgContent = msg.content;
          const text = Array.isArray(msgContent)
            ? (msgContent as Array<Record<string, unknown>>)
                .filter(b => b?.type === 'text')
                .map(b => b.text as string)
                .join('\n')
            : typeof msgContent === 'string'
              ? msgContent
              : '';

          if (!text.trim()) continue;

          const timestamp =
            typeof msg.timestamp === 'number'
              ? msg.timestamp
              : typeof parsed.timestamp === 'string'
                ? Date.parse(parsed.timestamp)
                : Date.now();

          messages.push({
            id: `transient-${msgIndex++}`,
            type: role as 'user' | 'assistant',
            content: text,
            timestamp,
            metadata: role === 'assistant' ? { isStreaming: false, isFinal: true } : {},
          });
        } catch {
          // skip malformed lines
        }
      }

      if (messages.length === 0) return null;

      const firstTimestamp = messages[0]?.timestamp ?? Date.now();
      return {
        id: `transient-${sessionKey}`,
        agentId: '',
        title: sessionKey.split(':').pop() || 'Cron Session',
        claudeSessionId: null,
        status: 'completed' as CoworkSessionStatus,
        pinned: false,
        cwd: '',
        systemPrompt: '',
        executionMode: 'local' as CoworkExecutionMode,
        activeSkillIds: [],
        messages,
        createdAt: firstTimestamp,
        updatedAt: firstTimestamp,
      };
    } catch (error) {
      console.warn('[OpenClawRuntime] readFromDeletedTranscript failed:', error);
      return null;
    }
  }

  /**
   * Ensure the gateway WebSocket client is connected.
   * Called when IM channels (e.g. Telegram) are enabled in OpenClaw mode
   * so that channel-originated events can be received without waiting
   * for a GucciAI-initiated session.
   */
  async connectGatewayIfNeeded(): Promise<void> {
    if (this.gatewayClient) {
      console.log('[ChannelSync] connectGatewayIfNeeded: gateway client already exists, skipping');
      return;
    }
    console.log('[ChannelSync] connectGatewayIfNeeded: no gateway client, initializing...');
    try {
      await this.ensureGatewayClientReady();
      console.log(
        '[ChannelSync] connectGatewayIfNeeded: gateway client ready, starting channel polling',
      );
      this.startChannelPolling();
    } catch (error) {
      console.error(
        '[ChannelSync] connectGatewayIfNeeded: failed to initialize gateway client:',
        error,
      );
      throw error;
    }
  }

  /**
   * Force-reconnect the gateway WebSocket client.
   * Used after the OpenClaw gateway process has been restarted (e.g. after config sync).
   * Unlike `connectGatewayIfNeeded`, this always tears down the old client first
   * to avoid a race where the old client's `onClose` fires after a new client is created.
   */
  async reconnectGateway(): Promise<void> {
    console.log('[ChannelSync] reconnectGateway: tearing down old client and reconnecting...');
    this.stopGatewayClient();
    try {
      await this.ensureGatewayClientReady();
      console.log('[ChannelSync] reconnectGateway: gateway client ready, starting channel polling');
      this.startChannelPolling();
    } catch (error) {
      console.error('[ChannelSync] reconnectGateway: failed to initialize gateway client:', error);
      throw error;
    }
  }

  /**
   * Explicitly disconnect the gateway WebSocket client.
   * Called before the OpenClaw gateway process is restarted so that the old
   * client's async `onClose` handler cannot interfere with a subsequently
   * created client.
   */
  disconnectGatewayClient(): void {
    console.log('[ChannelSync] disconnectGatewayClient: explicitly tearing down gateway client');
    this.stopGatewayClient();
  }

  /**
   * Start periodic polling for channel-originated sessions (e.g. Telegram).
   * Uses the gateway `sessions.list` RPC to discover sessions that may not
   * have been delivered via WebSocket events.
   */
  startChannelPolling(): void {
    if (!this.channelSessionSync) {
      console.warn('[ChannelSync] startChannelPolling: no channelSessionSync set, skipping');
      return;
    }
    // Already running
    if (this.channelPollingTimer) {
      console.log('[ChannelSync] startChannelPolling: already running, skipping');
      return;
    }

    console.log('[ChannelSync] startChannelPolling: starting periodic channel session discovery');
    // Run once immediately, then at interval
    void this.pollChannelSessions();
    this.channelPollingTimer = setInterval(() => {
      void this.pollChannelSessions();
    }, OpenClawRuntimeAdapter.CHANNEL_POLL_INTERVAL_MS);
  }

  stopChannelPolling(): void {
    if (this.channelPollingTimer) {
      clearInterval(this.channelPollingTimer);
      this.channelPollingTimer = null;
    }
  }

  private async pollChannelSessions(): Promise<void> {
    if (!this.gatewayClient || !this.channelSessionSync) {
      console.warn(
        '[ChannelSync] pollChannelSessions: skipped — gatewayClient:',
        !!this.gatewayClient,
        'channelSessionSync:',
        !!this.channelSessionSync,
      );
      return;
    }
    try {
      const params = { activeMinutes: 60, limit: CHANNEL_SESSION_DISCOVERY_LIMIT };
      const result = await this.gatewayClient.request('sessions.list', params);
      const sessions = (result as Record<string, unknown>)?.sessions;
      if (!Array.isArray(sessions)) {
        console.warn(
          '[ChannelSync] pollChannelSessions: sessions.list returned non-array sessions:',
          typeof sessions,
          'full result keys:',
          Object.keys(result as Record<string, unknown>),
        );
        return;
      }
      let hasNew = false;
      let channelCount = 0;
      const newSessionsToSync: Array<{ sessionId: string; sessionKey: string }> = [];
      for (const row of sessions) {
        const key = typeof row?.key === 'string' ? row.key : '';
        if (!key) continue;
        // Skip heartbeat-originated sessions (origin.label === 'heartbeat')
        if (isRecord(row)) {
          const rowOrigin = (row as Record<string, unknown>).origin;
          if (isRecord(rowOrigin) && (rowOrigin as Record<string, unknown>).label === 'heartbeat') {
            this.heartbeatSessionKeys.add(key);
            continue;
          }
        }
        const isChannel = this.channelSessionSync.isChannelSessionKey(key);
        if (!isChannel) continue;
        // Skip keys that were explicitly deleted by the user — only real-time events re-create them
        if (this.deletedChannelKeys.has(key)) continue;
        // Skip gateway sessions belonging to a previously-bound agent.
        // After an agent binding change, the gateway retains old sessions under the old agentId.
        // Only process sessions matching the current platformAgentBindings.
        if (!this.channelSessionSync.isCurrentBindingKey(key)) continue;
        channelCount++;
        // Use resolveOrCreateSession so new channel sessions are auto-created
        const sessionId = this.channelSessionSync.resolveOrCreateSession(key);
        if (sessionId && !this.knownChannelSessionIds.has(sessionId)) {
          this.knownChannelSessionIds.add(sessionId);
          this.rememberSessionKey(sessionId, key);
          hasNew = true;
          // Queue full history sync for newly discovered sessions
          if (!this.fullySyncedSessions.has(sessionId)) {
            newSessionsToSync.push({ sessionId, sessionKey: key });
          }
        }
      }
      if (hasNew) {
        let notified = 0;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('cowork:sessions:changed');
            notified++;
          }
        }
        console.log(
          '[ChannelSync] discovered',
          channelCount,
          'channel sessions, notified',
          notified,
          'windows',
        );
      }
      // Sync full history for newly discovered sessions
      for (const { sessionId, sessionKey } of newSessionsToSync) {
        await this.syncFullChannelHistory(sessionId, sessionKey);
      }

      // Incremental sync for already-known sessions: check if the gateway has messages
      // that weren't picked up during initial sync or real-time events.
      if (channelCount > 0) {
        const syncedThisCycle = new Set<string>();
        for (const row of sessions) {
          const key = typeof row?.key === 'string' ? row.key : '';
          if (!key) continue;
          if (!this.channelSessionSync.isChannelSessionKey(key)) continue;
          if (this.deletedChannelKeys.has(key)) continue;
          if (this.heartbeatSessionKeys.has(key)) continue;
          // Skip sessions belonging to a previously-bound agent
          if (!this.channelSessionSync.isCurrentBindingKey(key)) continue;
          const sessionId = this.sessionIdBySessionKey.get(key);
          if (!sessionId || !this.fullySyncedSessions.has(sessionId)) continue;
          // Safety net: only sync each sessionId once per poll cycle
          if (syncedThisCycle.has(sessionId)) continue;
          syncedThisCycle.add(sessionId);
          // Skip sessions with an active turn (they handle their own sync)
          if (this.activeTurns.has(sessionId)) continue;
          try {
            await this.incrementalChannelSync(sessionId, key);
          } catch (err) {
            console.warn('[ChannelSync] incremental sync failed for', key, err);
          }
        }
      }
    } catch (error) {
      console.error('[ChannelSync] pollChannelSessions: error during polling:', error);
    }
  }

  override on<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override off<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.off(event, listener);
  }

  async startSession(
    sessionId: string,
    prompt: string,
    options: CoworkStartOptions = {},
  ): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      skipInitialUserMessage: options.skipInitialUserMessage,
      skillIds: options.skillIds,
      systemPrompt: options.systemPrompt,
      confirmationMode: options.confirmationMode,
      imageAttachments: options.imageAttachments,
      agentId: options.agentId,
    });
  }

  async continueSession(
    sessionId: string,
    prompt: string,
    options: CoworkContinueOptions = {},
  ): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      skipInitialUserMessage: false,
      systemPrompt: options.systemPrompt,
      skillIds: options.skillIds,
      imageAttachments: options.imageAttachments,
    });
  }

  stopSession(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      turn.stopRequested = true;
      this.manuallyStoppedSessions.add(sessionId);
      const client = this.gatewayClient;
      if (client) {
        void client
          .request('chat.abort', {
            sessionKey: turn.sessionKey,
            runId: turn.runId,
          })
          .catch(error => {
            console.warn('[OpenClawRuntime] Failed to abort chat run:', error);
          });
      }
    }

    // Record the stop timestamp so that late-arriving gateway events
    // (e.g. from POPO/Telegram channels) don't re-create the ActiveTurn.
    this.stoppedSessions.set(sessionId, Date.now());

    // 清理编排状态
    if (this.orchestrationParentSessionId === sessionId) {
      this.orchestrationParentSessionId = null;
      // 保留消息和状态一段时间供 UI 查询，延迟清理
      setTimeout(() => {
        this.subagentMessages.clear();
        this.subagentStatus.clear();
        this.labelToSessionKey.clear();
        this.sessionKeyToLabel.clear();
        this.toolCallArgs.clear();
      }, 60000);
    }

    this.cleanupSessionTurn(sessionId);
    this.clearPendingApprovalsBySession(sessionId);
    this.store.updateSession(sessionId, { status: 'idle' });
    this.emit('sessionStopped', sessionId);
    this.resolveTurn(sessionId);
  }

  stopAllSessions(): void {
    const activeSessionIds = Array.from(this.activeTurns.keys());
    activeSessionIds.forEach(sessionId => {
      this.stopSession(sessionId);
    });
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      return;
    }

    const decision =
      result.behavior !== 'allow' ? 'deny' : pending.allowAlways ? 'allow-always' : 'allow-once';
    const client = this.gatewayClient;
    if (!client) {
      this.pendingApprovals.delete(requestId);
      return;
    }

    const sessionId = pending.sessionId;
    // Only schedule continuation for user-initiated approvals (desktop modal),
    // not for auto-approved commands (allowAlways).
    const needsContinuation = !pending.allowAlways;

    void client
      .request('exec.approval.resolve', {
        id: requestId,
        decision,
      })
      .then(() => {
        if (!needsContinuation) return;
        // Continue the session so the model can see the command result.
        const prompt = decision !== 'deny' ? t('execApprovalApproved') : t('execApprovalDenied');
        const tryContinue = (retries: number) => {
          if (!this.store.getSession(sessionId)) return; // session deleted
          if (!this.isSessionActive(sessionId)) {
            void this.continueSession(sessionId, prompt).catch(error => {
              console.warn('[OpenClawRuntime] failed to continue session after approval:', error);
            });
            return;
          }
          // Session still active (user approved before run ended). Retry after delay.
          if (retries > 0) {
            setTimeout(() => tryContinue(retries - 1), 1000);
          }
        };
        tryContinue(10);
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.emit('error', sessionId, `Failed to resolve OpenClaw approval: ${message}`);
      })
      .finally(() => {
        this.pendingApprovals.delete(requestId);
      });
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  hasActiveSessions(): boolean {
    return this.activeTurns.size > 0;
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.confirmationModeBySession.get(sessionId) ?? null;
  }

  private async runTurn(
    sessionId: string,
    prompt: string,
    options: {
      skipInitialUserMessage?: boolean;
      systemPrompt?: string;
      skillIds?: string[];
      confirmationMode?: 'modal' | 'text';
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
      agentId?: string;
    },
  ): Promise<void> {
    if (!prompt.trim() && (!options.imageAttachments || options.imageAttachments.length === 0)) {
      throw new Error('Prompt is required.');
    }
    // Clear stop cooldown when user explicitly starts/continues a session
    this.stoppedSessions.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);

    // 设置编排父会话 ID
    // 注意：不清空之前的子 Agent 数据，因为同一会话可能有多个 turn，
    // 每个 turn 可能启动新的 subagent，之前的 subagent 状态应保留
    const previousOrchestrationSessionId = this.orchestrationParentSessionId;
    this.orchestrationParentSessionId = sessionId;

    // 只有当切换到不同的 session 时才清空状态
    if (previousOrchestrationSessionId && previousOrchestrationSessionId !== sessionId) {
      this.subagentMessages.clear();
      this.subagentStatus.clear();
      this.labelToSessionKey.clear();
      this.sessionKeyToLabel.clear();
      this.toolCallArgs.clear();
    }

    if (this.activeTurns.has(sessionId)) {
      throw new Error(`Session ${sessionId} is still running.`);
    }

    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const confirmationMode =
      options.confirmationMode ?? this.confirmationModeBySession.get(sessionId) ?? 'modal';
    this.confirmationModeBySession.set(sessionId, confirmationMode);

    if (!options.skipInitialUserMessage) {
      const metadata =
        options.skillIds?.length || options.imageAttachments?.length
          ? {
              ...(options.skillIds?.length ? { skillIds: options.skillIds } : {}),
              ...(options.imageAttachments?.length
                ? { imageAttachments: options.imageAttachments }
                : {}),
            }
          : undefined;
      const userMessage = this.store.addMessage(sessionId, {
        type: 'user',
        content: prompt,
        metadata,
      });
      this.emit('message', sessionId, userMessage);
    }

    const agentId = options.agentId || session.agentId || 'main';
    const agent = this.store.getAgent(agentId);
    const rawModel = agent?.model || '';
    const modelName = rawModel.includes('/') ? rawModel.slice(rawModel.indexOf('/') + 1) : rawModel;
    const sessionKey = this.toSessionKey(sessionId, agentId);
    this.rememberSessionKey(sessionId, sessionKey);

    this.store.updateSession(sessionId, { status: 'running' });
    setCoworkProxySessionId(sessionId);
    await this.ensureGatewayClientReady();
    this.startChannelPolling();

    const runId = randomUUID();
    const turnToken = this.nextTurnToken(sessionId);
    const outboundMessage = await this.buildOutboundPrompt(
      sessionId,
      prompt,
      options.systemPrompt ?? session.systemPrompt,
      agentId,
    );
    const completionPromise = new Promise<void>((resolve, reject) => {
      this.pendingTurns.set(sessionId, { resolve, reject });
    });
    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId,
      turnToken,
      knownRunIds: new Set([runId]),
      assistantMessageId: null,
      committedAssistantText: '',
      currentAssistantSegmentText: '',
      currentText: '',
      agentAssistantTextLength: 0,
      currentContentText: '',
      currentContentBlocks: [],
      sawNonTextContentBlocks: false,
      textStreamMode: 'unknown',
      toolUseMessageIdByToolCallId: new Map(),
      toolResultMessageIdByToolCallId: new Map(),
      toolResultTextByToolCallId: new Map(),
      stopRequested: false,
      pendingUserSync: false,
      bufferedChatPayloads: [],
      bufferedAgentPayloads: [],
      currentThinkingMessageId: null,
      currentThinkingContent: '',
      thinkingStreamEnded: false,
      modelName,
    });
    this.sessionIdByRunId.set(runId, sessionId);

    // Start client-side timeout watchdog.
    // OpenClaw gateway has a known issue where embedded run timeouts may not
    // produce a WS abort/final event (the subscription is torn down before the
    // lifecycle event fires). This timer fires slightly after the server-side
    // timeout to recover the UI from a stuck "running" state.
    this.startTurnTimeoutWatchdog(sessionId);

    const client = this.requireGatewayClient();
    try {
      console.log('[OpenClawRuntime] chat.send params:', {
        sessionKey,
        messageLength: outboundMessage.length,
        runId,
      });
      console.log(
        '[OpenClawRuntime] chat.send message content (first 500 chars):',
        outboundMessage.slice(0, 500),
      );
      const attachments = options.imageAttachments?.length
        ? options.imageAttachments.map(img => ({
            type: 'image',
            mimeType: img.mimeType,
            content: img.base64Data,
          }))
        : undefined;
      if (attachments) {
        console.log(
          '[OpenClawRuntime] chat.send with attachments:',
          attachments.length,
          'images,',
          attachments.map(a => ({
            type: a.type,
            mimeType: a.mimeType,
            contentLength: a.content?.length ?? 0,
          })),
        );
      }
      const sendResult = await client.request<Record<string, unknown>>('chat.send', {
        sessionKey,
        message: outboundMessage,
        deliver: false,
        idempotencyKey: runId,
        ...(attachments ? { attachments } : {}),
      });
      const returnedRunId = typeof sendResult?.runId === 'string' ? sendResult.runId.trim() : '';
      if (returnedRunId) {
        this.bindRunIdToTurn(sessionId, returnedRunId);
      }
    } catch (error) {
      this.cleanupSessionTurn(sessionId);
      this.store.updateSession(sessionId, { status: 'error' });
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', sessionId, message);
      this.rejectTurn(sessionId, new Error(message));
      throw error;
    }

    await completionPromise;
  }

  private async buildOutboundPrompt(
    sessionId: string,
    prompt: string,
    systemPrompt?: string,
    agentId?: string,
  ): Promise<string> {
    const normalizedSystemPrompt = (systemPrompt ?? '').trim();
    const previousSystemPrompt = this.lastSystemPromptBySession.get(sessionId) ?? '';
    const shouldInjectSystemPrompt = Boolean(
      normalizedSystemPrompt && normalizedSystemPrompt !== previousSystemPrompt,
    );

    if (normalizedSystemPrompt) {
      this.lastSystemPromptBySession.set(sessionId, normalizedSystemPrompt);
    } else {
      this.lastSystemPromptBySession.delete(sessionId);
    }

    const sections: string[] = [];
    if (shouldInjectSystemPrompt) {
      sections.push(this.buildSystemPromptPrefix(normalizedSystemPrompt));
    }
    sections.push(buildOpenClawLocalTimeContextPrompt());

    if (this.bridgedSessions.has(sessionId)) {
      if (prompt.trim()) {
        sections.push(`[Current user request]\n${prompt}`);
      }
      return sections.join('\n\n');
    }

    const client = this.requireGatewayClient();
    const sessionKey = this.toSessionKey(sessionId, agentId);
    let hasHistory = false;
    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: 1,
      });
      hasHistory = Array.isArray(history?.messages) && history.messages.length > 0;
    } catch (error) {
      console.warn(
        '[OpenClawRuntime] chat.history check failed, continuing without history guard:',
        error,
      );
    }

    this.bridgedSessions.add(sessionId);

    // Enable reasoning stream so thinking events are emitted via WebSocket
    // OpenClaw parses /reasoning directive and sets session.reasoningLevel
    // Must include this for every turn, not just new sessions, to ensure thinking events are sent
    sections.push('/reasoning stream');

    if (!hasHistory) {
      const session = this.store.getSession(sessionId);
      if (session) {
        const bridgePrefix = this.buildBridgePrefix(session.messages, prompt);
        if (bridgePrefix) {
          sections.push(bridgePrefix);
        }
      }
    }

    if (prompt.trim()) {
      sections.push(`[Current user request]\n${prompt}`);
    }
    return sections.join('\n\n');
  }

  private buildSystemPromptPrefix(systemPrompt: string): string {
    return [
      '[GucciAI system instructions]',
      'Apply the instructions below as the highest-priority guidance for this session.',
      'If earlier GucciAI system instructions exist, replace them with this version.',
      systemPrompt,
    ].join('\n');
  }

  private buildBridgePrefix(messages: CoworkMessage[], currentPrompt: string): string {
    const normalizedCurrentPrompt = currentPrompt.trim();
    if (!normalizedCurrentPrompt) return '';

    const source = messages
      .filter(message => {
        if (message.type !== 'user' && message.type !== 'assistant') {
          return false;
        }
        if (!message.content.trim()) {
          return false;
        }
        if (message.metadata?.isThinking) {
          return false;
        }
        return true;
      })
      .map(message => ({
        type: message.type,
        content: message.content.trim(),
      }));

    if (source.length === 0) {
      return '';
    }

    if (
      source[source.length - 1]?.type === 'user' &&
      source[source.length - 1]?.content === normalizedCurrentPrompt
    ) {
      source.pop();
    }

    const recent = source.slice(-BRIDGE_MAX_MESSAGES);
    if (recent.length === 0) {
      return '';
    }

    const lines = recent.map(entry => {
      const role = entry.type === 'user' ? 'User' : 'Assistant';
      return `${role}: ${truncate(entry.content, BRIDGE_MAX_MESSAGE_CHARS)}`;
    });

    return [
      '[Context bridge from previous GucciAI conversation]',
      'Use this prior context for continuity. Focus your final answer on the current request.',
      ...lines,
    ].join('\n');
  }

  private async ensureGatewayClientReady(): Promise<void> {
    // Serialize concurrent calls: if another init is already in progress, wait for it.
    if (this.gatewayClientInitLock) {
      await this.gatewayClientInitLock;
      return;
    }
    this.gatewayClientInitLock = this._ensureGatewayClientReadyImpl();
    try {
      await this.gatewayClientInitLock;
    } finally {
      this.gatewayClientInitLock = null;
    }
  }

  private async _ensureGatewayClientReadyImpl(): Promise<void> {
    console.log('[ChannelSync] ensureGatewayClientReady: starting engine gateway...');
    const engineStatus = await this.engineManager.startGateway();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: engine phase=',
      engineStatus.phase,
      'message=',
      engineStatus.message,
    );
    if (engineStatus.phase !== 'running') {
      const message = engineStatus.message || 'OpenClaw engine is not running.';
      throw new Error(message);
    }

    const connection = this.engineManager.getGatewayConnectionInfo();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: connection info — url=',
      connection.url ? '✓' : '✗',
      'token=',
      connection.token ? '✓' : '✗',
      'version=',
      connection.version,
      'clientEntryPath=',
      connection.clientEntryPath ? '✓' : '✗',
    );
    const missing: string[] = [];
    if (!connection.url) missing.push('url');
    if (!connection.token) missing.push('token');
    if (!connection.version) missing.push('version');
    if (!connection.clientEntryPath) missing.push('clientEntryPath');
    if (missing.length > 0) {
      throw new Error(
        `OpenClaw gateway connection info is incomplete (missing: ${missing.join(', ')})`,
      );
    }

    const needsNewClient =
      !this.gatewayClient ||
      this.gatewayClientVersion !== connection.version ||
      this.gatewayClientEntryPath !== connection.clientEntryPath;
    console.log(
      '[ChannelSync] ensureGatewayClientReady: needsNewClient=',
      needsNewClient,
      'hasExistingClient=',
      !!this.gatewayClient,
    );
    if (!needsNewClient && this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
      return;
    }

    this.stopGatewayClient();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: creating gateway client, url=',
      connection.url,
    );
    await this.createGatewayClient(connection);
    console.log(
      '[ChannelSync] ensureGatewayClientReady: createGatewayClient returned, waiting for handshake...',
    );
    if (this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
    }
    console.log('[ChannelSync] ensureGatewayClientReady: gateway client created and ready');

    // Browser pre-warm disabled: the empty browser window is disruptive.
    // The browser will start on-demand when the AI agent first calls the browser tool.
    // this.prewarmBrowserIfNeeded(connection);
  }

  private async createGatewayClient(connection: OpenClawGatewayConnectionInfo): Promise<void> {
    const clientEntryPath = connection.clientEntryPath;
    if (!clientEntryPath) {
      throw new Error('Gateway client entry path is not available');
    }
    const GatewayClient = await this.loadGatewayClientCtor(clientEntryPath);

    let resolveReady: (() => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    let settled = false;

    this.gatewayReadyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolveReady?.();
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectReady?.(error);
    };

    const client = new GatewayClient({
      url: connection.url,
      token: connection.token,
      clientDisplayName: 'GucciAI',
      clientVersion: app.getVersion(),
      mode: 'backend',
      caps: [OPENCLAW_GATEWAY_TOOL_EVENTS_CAP],
      role: 'operator',
      scopes: ['operator.admin'],
      onHelloOk: () => {
        console.log('[ChannelSync] GatewayClient: onHelloOk — handshake succeeded');
        // Expose the client only after the connect handshake completes.
        // Setting gatewayClient earlier would let concurrent code send
        // request frames before the connect frame, causing 1008 rejection.
        this.gatewayClient = client;
        this.gatewayClientVersion = connection.version;
        this.gatewayClientEntryPath = connection.clientEntryPath;
        settleResolve();
        this.lastTickTimestamp = Date.now();
        this.startTickWatchdog();
      },
      onConnectError: (error: Error) => {
        console.error('[ChannelSync] GatewayClient: onConnectError —', error.message);
        settleReject(error);
      },
      onClose: (_code: number, reason: string) => {
        console.log(
          '[ChannelSync] GatewayClient: onClose — code:',
          _code,
          'reason:',
          reason,
          'settled:',
          settled,
        );
        if (!settled) {
          // Handshake never completed — clean up the pending client so the next
          // ensureGatewayClientReady call creates a fresh one instead of reusing
          // this broken instance forever.
          this.pendingGatewayClient = null;
          settleReject(new Error(reason || 'OpenClaw gateway disconnected before handshake'));
          return;
        }

        // If stopGatewayClient() triggered this onClose, don't do anything —
        // the caller is already handling cleanup and may be creating a new client.
        if (this.gatewayStoppingIntentionally) {
          return;
        }

        console.warn('[OpenClawRuntime] gateway WS disconnected — code:', _code, 'reason:', reason);
        const disconnectedError = new Error(reason || 'OpenClaw gateway client disconnected');
        const activeSessionIds = Array.from(this.activeTurns.keys());
        activeSessionIds.forEach(sessionId => {
          this.store.updateSession(sessionId, { status: 'error' });
          this.emit('error', sessionId, disconnectedError.message);
          this.cleanupSessionTurn(sessionId);
          this.rejectTurn(sessionId, disconnectedError);
        });
        this.stopGatewayClient();
        this.gatewayReadyPromise = Promise.reject(disconnectedError);
        this.gatewayReadyPromise.catch(() => {
          // suppress unhandled rejection noise; auto-reconnect will re-establish
        });

        // Auto-reconnect after unexpected disconnect
        this.scheduleGatewayReconnect();
      },
      onEvent: (event: GatewayEventFrame) => {
        this.handleGatewayEvent(event);
      },
    });

    // gatewayClient/version/entryPath are now set inside onHelloOk,
    // after the connect handshake succeeds. We only keep a local ref
    // for stopGatewayClient() cleanup if start() fails synchronously.
    this.pendingGatewayClient = client;
    client.start();
  }

  private stopGatewayClient(): void {
    this.gatewayStoppingIntentionally = true;
    this.stopChannelPolling();
    this.cancelGatewayReconnect();
    this.stopTickWatchdog();
    // Stop whichever client exists — the promoted one or the pending one.
    const clientToStop = this.gatewayClient ?? this.pendingGatewayClient;
    try {
      clientToStop?.stop();
    } catch (error) {
      console.warn('[OpenClawRuntime] Failed to stop gateway client:', error);
    }
    this.gatewayClient = null;
    this.pendingGatewayClient = null;
    this.gatewayClientVersion = null;
    this.gatewayClientEntryPath = null;
    this.gatewayReadyPromise = null;
    this.channelSessionSync?.clearCache();
    this.knownChannelSessionIds.clear();
    this.heartbeatSessionKeys.clear();
    this.stoppedSessions.clear();
    this.browserPrewarmAttempted = false;
    this.lastTickTimestamp = 0;
    // Clear messageUpdate throttle state
    for (const timer of this.pendingMessageUpdateTimer.values()) {
      clearTimeout(timer);
    }
    this.pendingMessageUpdateTimer.clear();
    this.lastMessageUpdateEmitTime.clear();
    this.gatewayStoppingIntentionally = false;
  }

  private cancelGatewayReconnect(): void {
    if (this.gatewayReconnectTimer) {
      clearTimeout(this.gatewayReconnectTimer);
      this.gatewayReconnectTimer = null;
    }
  }

  /**
   * Throttled emit for messageUpdate during streaming.
   * OpenClaw sends full-replacement deltas, so intermediate updates can be safely skipped.
   * Uses leading + trailing pattern: emit immediately if enough time has passed,
   * otherwise schedule a trailing emit to deliver the latest content.
   */
  private throttledEmitMessageUpdate(sessionId: string, messageId: string, content: string): void {
    const now = Date.now();
    const lastEmit = this.lastMessageUpdateEmitTime.get(messageId) ?? 0;
    const elapsed = now - lastEmit;

    if (elapsed >= OpenClawRuntimeAdapter.MESSAGE_UPDATE_THROTTLE_MS) {
      this.clearPendingMessageUpdate(messageId);
      this.lastMessageUpdateEmitTime.set(messageId, now);
      this.emit('messageUpdate', sessionId, messageId, content);
      return;
    }

    // Schedule a trailing emit to ensure the latest content is delivered
    this.clearPendingMessageUpdate(messageId);
    this.pendingMessageUpdateTimer.set(
      messageId,
      setTimeout(() => {
        this.pendingMessageUpdateTimer.delete(messageId);
        this.lastMessageUpdateEmitTime.set(messageId, Date.now());
        this.emit('messageUpdate', sessionId, messageId, content);
      }, OpenClawRuntimeAdapter.MESSAGE_UPDATE_THROTTLE_MS - elapsed),
    );
  }

  private clearPendingMessageUpdate(messageId: string): void {
    const timer = this.pendingMessageUpdateTimer.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.pendingMessageUpdateTimer.delete(messageId);
    }
  }

  /**
   * Throttled SQLite store write for streaming message updates.
   * Uses leading + trailing pattern identical to throttledEmitMessageUpdate.
   * Final correctness is guaranteed by syncFinalAssistantWithHistory.
   */
  private throttledStoreUpdateMessage(
    sessionId: string,
    messageId: string,
    content: string,
    metadata: { isStreaming: boolean; isFinal: boolean },
  ): void {
    const now = Date.now();
    const lastUpdate = this.lastStoreUpdateTime.get(messageId) ?? 0;
    const elapsed = now - lastUpdate;

    if (elapsed >= OpenClawRuntimeAdapter.STORE_UPDATE_THROTTLE_MS) {
      this.clearPendingStoreUpdate(messageId);
      this.lastStoreUpdateTime.set(messageId, now);
      this.store.updateMessage(sessionId, messageId, { content, metadata });
      return;
    }

    // Schedule a trailing write to ensure the latest content is persisted
    this.clearPendingStoreUpdate(messageId);
    this.pendingStoreUpdateTimer.set(
      messageId,
      setTimeout(() => {
        this.pendingStoreUpdateTimer.delete(messageId);
        this.lastStoreUpdateTime.set(messageId, Date.now());
        // Guard: skip write if the session turn has already been cleaned up
        const activeTurn = this.activeTurns.get(sessionId);
        if (activeTurn?.assistantMessageId === messageId) {
          this.store.updateMessage(sessionId, messageId, { content, metadata });
        }
      }, OpenClawRuntimeAdapter.STORE_UPDATE_THROTTLE_MS - elapsed),
    );
  }

  private clearPendingStoreUpdate(messageId: string): void {
    const timer = this.pendingStoreUpdateTimer.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.pendingStoreUpdateTimer.delete(messageId);
    }
  }

  /** Flush any pending throttled store write immediately (e.g. before segment split or final sync). */
  private flushPendingStoreUpdate(sessionId: string, messageId: string): void {
    const timer = this.pendingStoreUpdateTimer.get(messageId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingStoreUpdateTimer.delete(messageId);
    this.lastStoreUpdateTime.set(messageId, Date.now());
    // Persist the latest in-memory content only; caller is responsible for metadata.
    const turn = this.activeTurns.get(sessionId);
    if (turn?.assistantMessageId === messageId && turn.currentAssistantSegmentText) {
      this.store.updateMessage(sessionId, messageId, {
        content: turn.currentAssistantSegmentText,
      });
    }
  }

  private startTickWatchdog(): void {
    this.stopTickWatchdog();
    console.log('[TickWatchdog] started');
    this.tickWatchdogTimer = setInterval(() => {
      this.checkTickHealth();
    }, OpenClawRuntimeAdapter.TICK_WATCHDOG_INTERVAL_MS);
  }

  private stopTickWatchdog(): void {
    if (this.tickWatchdogTimer) {
      clearInterval(this.tickWatchdogTimer);
      this.tickWatchdogTimer = null;
    }
  }

  private checkTickHealth(): void {
    if (this.lastTickTimestamp <= 0) return;
    const elapsed = Date.now() - this.lastTickTimestamp;
    if (elapsed <= OpenClawRuntimeAdapter.TICK_TIMEOUT_MS) return;

    console.warn(
      `[TickWatchdog] no tick received for ${Math.round(elapsed / 1000)}s (threshold: ${OpenClawRuntimeAdapter.TICK_TIMEOUT_MS / 1000}s) — connection is likely dead, triggering reconnect`,
    );
    this.cancelGatewayReconnect();
    this.stopGatewayClient();
    this.gatewayReconnectAttempt = 0;
    this.scheduleGatewayReconnect();
  }

  /**
   * Called when the system resumes from sleep/suspend.
   * Resets the reconnect counter and triggers an immediate reconnect or health check.
   */
  onSystemResume(): void {
    console.log('[GatewayReconnect] system resumed from sleep');
    this.cancelGatewayReconnect();
    this.gatewayReconnectAttempt = 0;
    if (!this.gatewayClient) {
      void this.attemptGatewayReconnect();
    } else {
      this.checkTickHealth();
    }
  }

  /**
   * Schedule an automatic gateway WS reconnection attempt with exponential backoff.
   * Called from onClose when the connection drops unexpectedly after a successful handshake.
   */
  private scheduleGatewayReconnect(): void {
    if (this.gatewayReconnectAttempt >= OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS) {
      console.error(
        '[GatewayReconnect] max attempts reached (' +
          OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS +
          '), giving up. Restart the app to reconnect.',
      );
      return;
    }

    const delays = OpenClawRuntimeAdapter.GATEWAY_RECONNECT_DELAYS;
    const delay = delays[Math.min(this.gatewayReconnectAttempt, delays.length - 1)];
    this.gatewayReconnectAttempt++;

    console.log(
      `[GatewayReconnect] scheduling reconnect attempt ${this.gatewayReconnectAttempt}/${OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS} in ${delay}ms`,
    );

    this.gatewayReconnectTimer = setTimeout(() => {
      this.gatewayReconnectTimer = null;
      void this.attemptGatewayReconnect();
    }, delay);
  }

  private async attemptGatewayReconnect(): Promise<void> {
    console.log(
      `[GatewayReconnect] attempting reconnect (attempt ${this.gatewayReconnectAttempt})`,
    );
    try {
      // connectGatewayIfNeeded checks if client already exists, so safe to call
      await this.connectGatewayIfNeeded();
      console.log('[GatewayReconnect] reconnected successfully');
      this.gatewayReconnectAttempt = 0; // reset counter on success
    } catch (error) {
      console.warn('[GatewayReconnect] reconnect failed:', error);
      this.scheduleGatewayReconnect(); // retry with next backoff
    }
  }

  private prewarmBrowserIfNeeded(connection: OpenClawGatewayConnectionInfo): void {
    if (this.browserPrewarmAttempted) return;
    if (!connection.port || !connection.token) return;
    this.browserPrewarmAttempted = true;

    const browserControlPort = connection.port + 2;
    const token = connection.token;
    console.log(
      `[OpenClawRuntime] browser pre-warm: gatewayPort=${connection.port}, browserControlPort=${browserControlPort}`,
    );
    void this.prewarmBrowserWithRetry(browserControlPort, token);
  }

  private probeBrowserControlService(toolCallId: string, phase: string): void {
    const connection = this.engineManager.getGatewayConnectionInfo();
    if (!connection.port || !connection.token) {
      console.log(
        `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): no gateway connection info`,
      );
      return;
    }
    const browserControlPort = connection.port + 2;
    const token = connection.token;
    const probeStartTime = Date.now();
    console.log(
      `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): checking port ${browserControlPort} ...`,
    );

    // Probe multiple endpoints to diagnose reachability
    const endpoints = [
      `http://127.0.0.1:${browserControlPort}/status`,
      `http://127.0.0.1:${browserControlPort}/`,
    ];
    for (const probeUrl of endpoints) {
      fetch(probeUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      })
        .then(async response => {
          const body = await response.text().catch(() => '');
          console.log(
            `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): ${probeUrl} → HTTP ${response.status} (${Date.now() - probeStartTime}ms) body=${body.slice(0, 500)}`,
          );
        })
        .catch(err => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): ${probeUrl} → FAILED (${Date.now() - probeStartTime}ms) error=${message}`,
          );
        });
    }
  }

  private async prewarmBrowserWithRetry(
    port: number,
    token: string,
    maxRetries = 5,
  ): Promise<void> {
    const url = `http://127.0.0.1:${port}/start?profile=openclaw`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      console.log(
        `[OpenClawRuntime] browser pre-warm attempt ${attempt}/${maxRetries} → POST http://127.0.0.1:${port}/start?profile=openclaw`,
      );

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(90_000),
        });
        const body = await response.text();
        if (response.ok) {
          console.log(
            `[OpenClawRuntime] browser pre-warm succeeded (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
          );
          return;
        }
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} returned HTTP ${response.status} (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} failed (${Date.now() - startTime}ms): ${message}`,
        );
      }

      if (attempt < maxRetries) {
        const delayMs = Math.min(5000, 2000 * attempt);
        console.log(`[OpenClawRuntime] browser pre-warm retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    console.warn(
      '[OpenClawRuntime] browser pre-warm exhausted all retries (non-fatal, browser will start on first tool use)',
    );
  }

  private async loadGatewayClientCtor(clientEntryPath: string): Promise<GatewayClientCtor> {
    // Use require() with file path directly. TypeScript's CJS output downgrades
    // dynamic import() to require(), which doesn't support file:// URLs.
    const loaded = require(clientEntryPath) as Record<string, unknown>;
    const direct = loaded.GatewayClient;
    if (typeof direct === 'function') {
      return direct as GatewayClientCtor;
    }

    const exportedValues = Object.values(loaded);
    for (const candidate of exportedValues) {
      if (typeof candidate !== 'function') {
        continue;
      }
      const maybeCtor = candidate as {
        name?: string;
        prototype?: {
          start?: unknown;
          stop?: unknown;
          request?: unknown;
        };
      };
      if (maybeCtor.name === 'GatewayClient') {
        return candidate as GatewayClientCtor;
      }
      const proto = maybeCtor.prototype;
      if (
        proto &&
        typeof proto.start === 'function' &&
        typeof proto.stop === 'function' &&
        typeof proto.request === 'function'
      ) {
        return candidate as GatewayClientCtor;
      }
    }

    const exportKeysPreview = Object.keys(loaded).slice(0, 20).join(', ');
    throw new Error(
      `Invalid OpenClaw gateway client module: ${clientEntryPath} (exports: ${exportKeysPreview || 'none'})`,
    );
  }

  private handleGatewayEvent(event: GatewayEventFrame): void {
    if (event.event === 'tick') {
      this.lastTickTimestamp = Date.now();
      return;
    }

    if (event.event === 'chat') {
      this.handleChatEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'agent') {
      // Process thinking events first (before assistant text) to ensure correct display order.
      // Thinking should appear in UI before or alongside the reply text.
      this.processAgentThinkingEvent(event.payload);
      // Process assistant text updates (may be enqueued if session not ready).
      this.processAgentAssistantText(event.payload);
      // Handle other agent events (tool, lifecycle, etc.)
      this.handleAgentEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'exec.approval.requested') {
      this.handleApprovalRequested(event.payload);
      return;
    }

    if (event.event === 'exec.approval.resolved') {
      this.handleApprovalResolved(event.payload);
    }

    if (event.event === 'cron') {
      console.debug('[OpenClawRuntime] received cron event:', JSON.stringify(event));
    }
  }

  private handleAgentEvent(payload: unknown, seq?: number): void {
    if (!isRecord(payload)) return;
    const agentPayload = payload as AgentEventPayload;
    const runId = typeof agentPayload.runId === 'string' ? agentPayload.runId.trim() : '';
    // Support both sessionKey and session fields (gateway uses 'session' for agent events)
    // Also normalize subagent sessionKey format: 'subagent:xxx' → 'agent:main:subagent:xxx'
    let sessionKey =
      typeof agentPayload.sessionKey === 'string'
        ? agentPayload.sessionKey.trim()
        : typeof agentPayload.session === 'string'
          ? agentPayload.session.trim()
          : '';
    // Normalize subagent sessionKey: if it starts with 'subagent:', add 'agent:main:' prefix
    // This is needed because gateway agent events use 'subagent:xxx' format
    // but sessionKeyToLabel mapping stores 'agent:main:subagent:xxx' format
    if (sessionKey && sessionKey.startsWith('subagent:') && !sessionKey.startsWith('agent:')) {
      sessionKey = 'agent:main:' + sessionKey;
    }
    const stream = typeof agentPayload.stream === 'string' ? agentPayload.stream : '';

    // Extract phase from lifecycle events to check for end states
    const data = isRecord(agentPayload.data) ? agentPayload.data : {};
    const phase = typeof data.phase === 'string' ? data.phase.trim() : '';
    const isLifecycleEnd =
      stream === 'lifecycle' &&
      (phase === 'end' || phase === 'fallback' || phase === 'completed' || phase === 'stopped');

    const sessionIdByRunId = runId ? this.sessionIdByRunId.get(runId) : undefined;
    const sessionIdBySessionKey = sessionKey
      ? (this.resolveSessionIdBySessionKey(sessionKey) ?? undefined)
      : undefined;
    let sessionId = sessionIdByRunId ?? sessionIdBySessionKey;

    // Re-create ActiveTurn for channel session follow-up turns.
    // Exclude:
    // - stream=error events (seq gap notifications) — diagnostic alerts, not new runs
    // - lifecycle end events (phase=end/fallback/completed/stopped) — turn already cleaned up
    if (
      sessionId &&
      !this.activeTurns.has(sessionId) &&
      sessionKey &&
      stream !== 'error' &&
      !isLifecycleEnd
    ) {
      console.log(
        '[Debug:handleAgentEvent] re-creating ActiveTurn for follow-up turn, sessionId:',
        sessionId,
      );
      this.ensureActiveTurn(sessionId, sessionKey, runId);
    }

    // Try to resolve channel-originated sessions (e.g. Telegram via OpenClaw)
    if (!sessionId && sessionKey && this.channelSessionSync) {
      const channelSessionId =
        this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
        (!this.heartbeatSessionKeys.has(sessionKey) &&
          this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
        this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
        null;
      console.log('[Debug:handleAgentEvent] channel resolve — channelSessionId:', channelSessionId);
      if (channelSessionId) {
        // If this key was previously deleted, allow re-creation but skip history sync
        if (this.deletedChannelKeys.has(sessionKey)) {
          this.deletedChannelKeys.delete(sessionKey);
          this.fullySyncedSessions.add(channelSessionId);
          this.reCreatedChannelSessionIds.add(channelSessionId);
          console.log(
            '[Debug:handleAgentEvent] re-created after delete, skipping history sync for:',
            sessionKey,
          );
        }
        this.rememberSessionKey(channelSessionId, sessionKey);
        sessionId = channelSessionId;
        this.ensureActiveTurn(channelSessionId, sessionKey, runId);
      }
    }

    if (!sessionId) {
      // 即使没有 sessionId，也处理子 Agent 的生命周期事件
      // 使用 sessionKeyToLabel 映射获取 agentId/label
      if (sessionKey && stream === 'lifecycle') {
        // Try to get agentId from sessionKeyToLabel mapping
        let agentIdOrLabel = this.sessionKeyToLabel.get(sessionKey);
        // Also try with 'subagent:' prefix (gateway might use short format)
        if (!agentIdOrLabel && sessionKey.startsWith('subagent:')) {
          const fullSessionKey = 'agent:main:' + sessionKey;
          agentIdOrLabel = this.sessionKeyToLabel.get(fullSessionKey);
        }
        // Also try reverse lookup: extract UUID from sessionKey and find matching label
        if (!agentIdOrLabel) {
          // sessionKey format: 'agent:main:subagent:UUID' or 'subagent:UUID'
          const uuidMatch = sessionKey.match(/subagent:([a-f0-9-]+)/i);
          if (uuidMatch) {
            // Try to find a label whose childSessionKey contains this UUID
            for (const [label, childKey] of this.labelToSessionKey) {
              if (childKey && childKey.includes(uuidMatch[1])) {
                agentIdOrLabel = label;
                break;
              }
            }
          }
        }
        // phase 在 data 字段中，不是顶层属性
        const data = agentPayload.data;
        const phase = isRecord(data) && typeof data.phase === 'string' ? data.phase.trim() : '';
        if (agentIdOrLabel) {
          console.log(
            '[OpenClawRuntime] subagent lifecycle (no sessionId): agentId=' +
              agentIdOrLabel +
              ' phase=' +
              phase +
              ' sessionKey=' +
              sessionKey,
          );
          if (phase === 'start' || phase === 'running') {
            this.subagentStatus.set(agentIdOrLabel, 'running');
          } else if (
            phase === 'end' ||
            phase === 'completed' ||
            phase === 'stopped' ||
            phase === 'error'
          ) {
            this.subagentStatus.set(agentIdOrLabel, 'done');
          }
        } else {
          console.log(
            '[OpenClawRuntime] subagent lifecycle (no sessionId): NO MAPPING FOUND sessionKey=' +
              sessionKey +
              ' phase=' +
              phase +
              ' labelToSessionKeys=' +
              Array.from(this.labelToSessionKey.entries())
                .map(([k, v]) => `${k}:${v}`)
                .join(','),
          );
        }
      }

      console.log(
        '[Debug:handleAgentEvent] no sessionId, dropping event. runId:',
        runId,
        'sessionKey:',
        sessionKey,
      );
      if (runId) {
        this.enqueuePendingAgentEvent(runId, agentPayload, seq);
      }
      return;
    }
    if (sessionIdByRunId && sessionIdBySessionKey && sessionIdByRunId !== sessionIdBySessionKey) {
      console.log(
        '[Debug:handleAgentEvent] sessionId mismatch, dropping. byRunId:',
        sessionIdByRunId,
        'bySessionKey:',
        sessionIdBySessionKey,
      );
      return;
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      console.log('[Debug:handleAgentEvent] no active turn for sessionId:', sessionId);
      return;
    }

    // Allow subagent events through even if sessionKey doesn't match turn's sessionKey.
    // Subagent sessionKey format: agent:${agentId}:subagent:${uuid}
    const isSubagentEvent = sessionKey?.includes(':subagent:');
    if (sessionKey && !runId && turn.sessionKey !== sessionKey && !isSubagentEvent) {
      console.log(
        '[Debug:handleAgentEvent] sessionKey mismatch, dropping. event:',
        sessionKey,
        'turn:',
        turn.sessionKey,
      );
      return;
    }

    if (runId) {
      const mappedSessionId = this.sessionIdByRunId.get(runId);
      if (mappedSessionId && mappedSessionId !== sessionId) {
        console.log(
          '[Debug:handleAgentEvent] runId mapped to different session, dropping. mapped:',
          mappedSessionId,
          'current:',
          sessionId,
        );
        return;
      }
      this.bindRunIdToTurn(sessionId, runId);
    }

    // Buffer agent events while user messages are being prefetched for channel sessions.
    // Must be checked BEFORE seq dedup so that replayed events are not dropped.
    if (turn.pendingUserSync) {
      console.log(
        '[Debug:handleAgentEvent] buffering agent event (pendingUserSync), sessionId:',
        sessionId,
        'buffered:',
        turn.bufferedAgentPayloads.length + 1,
      );
      turn.bufferedAgentPayloads.push({ payload: agentPayload, seq, bufferedAt: Date.now() });
      return;
    }

    // Sequence-based dedup (placed after buffer check to match handleChatEvent pattern)
    if (typeof seq === 'number' && Number.isFinite(seq) && runId) {
      const lastSeq = this.lastAgentSeqByRunId.get(runId);
      if (lastSeq !== undefined && seq <= lastSeq) {
        return;
      }
      this.lastAgentSeqByRunId.set(runId, seq);
    }

    // 捕获子 Agent 事件 (stream 格式: 'assistant' | 'user' | 'tool' | 'tools')
    // sessionKey 格式: agent:${agentId}:subagent:${uuid} 或 channel:main-agent
    if (stream === 'assistant' || stream === 'user' || stream === 'tool' || stream === 'tools') {
      // 从 sessionKey 中提取 agentId: agent:${agentId}:subagent:${uuid} -> ${agentId}
      const agentIdMatch = sessionKey?.match(/^agent:([^:]+):/);
      const extractedAgentId = agentIdMatch ? agentIdMatch[1] : null;

      // 使用 sessionKey → label 映射找到正确的 label
      const mappedLabel = sessionKey ? this.sessionKeyToLabel.get(sessionKey) : null;
      // 优先使用映射的 label，否则使用提取的 agentId
      const storageKey = mappedLabel || extractedAgentId;

      // 调试日志
      if (sessionKey && sessionKey.includes('subagent')) {
        console.log(
          '[OpenClawRuntime] subagent event: sessionKey=' +
            sessionKey +
            ' extractedAgentId=' +
            extractedAgentId +
            ' mappedLabel=' +
            mappedLabel +
            ' storageKey=' +
            storageKey +
            ' stream=' +
            stream,
        );
      }

      if (storageKey && storageKey !== 'main-agent') {
        if (!this.subagentMessages.has(storageKey)) {
          this.subagentMessages.set(storageKey, []);
        }
        const msgs = this.subagentMessages.get(storageKey)!;
        const subData = isRecord(agentPayload.data)
          ? (agentPayload.data as Record<string, unknown>)
          : null;
        const eventText = typeof subData?.text === 'string' ? subData.text : '';

        if ((stream === 'assistant' || stream === 'user') && eventText.length > 0) {
          const role = stream;
          const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          if (lastMsg && lastMsg.role === role) {
            if (
              eventText.length >= lastMsg.content.length &&
              eventText.startsWith(lastMsg.content)
            ) {
              lastMsg.content = eventText;
            } else if (!lastMsg.content.startsWith(eventText)) {
              msgs.push({ role, content: eventText });
            }
          } else {
            msgs.push({ role, content: eventText });
          }
        } else if (stream === 'tool' || stream === 'tools') {
          if (subData) {
            const toolPhase = typeof subData.phase === 'string' ? subData.phase : '';
            const toolName = typeof subData.name === 'string' ? subData.name : '';
            if (toolPhase === 'start' && toolName) {
              let toolSummary = `🔧 **${toolName}**`;
              if (isRecord(subData.args)) {
                const args = subData.args as Record<string, unknown>;
                const command = typeof args.command === 'string' ? args.command : '';
                const filePath =
                  typeof args.file_path === 'string'
                    ? args.file_path
                    : typeof args.path === 'string'
                      ? args.path
                      : '';
                if (command) toolSummary += `\n\`\`\`\n${command.slice(0, 500)}\n\`\`\``;
                else if (filePath) toolSummary += `: ${filePath}`;
              }
              msgs.push({ role: 'tool', content: toolSummary });
            }
          }
        }
      }
    }

    // Fast-path: skip assistant-stream events — they carry the same text as
    // chat deltas and dispatchAgentEvent() has no handler for stream=assistant.
    if (stream === 'assistant') {
      return;
    }

    this.dispatchAgentEvent(sessionId, turn, {
      ...agentPayload,
      ...(typeof seq === 'number' && Number.isFinite(seq) ? { seq } : {}),
    });
  }

  private dispatchAgentEvent(
    sessionId: string,
    turn: ActiveTurn,
    agentPayload: AgentEventPayload,
  ): void {
    const stream = typeof agentPayload.stream === 'string' ? agentPayload.stream.trim() : '';
    const hasToolShape =
      isRecord(agentPayload.data) && typeof agentPayload.data.toolCallId === 'string';

    // End thinking stream when we receive non-thinking streams (tool/lifecycle)
    if (stream !== 'thinking' && !turn.thinkingStreamEnded && turn.currentThinkingMessageId) {
      turn.thinkingStreamEnded = true;
      // Reset assistantMessageId so response text creates a new message
      // instead of reusing the thinking message. This ensures correct
      // display order: thinking → tools → response.
      turn.assistantMessageId = null;
      // Update thinking message metadata to mark streaming as ended
      // Pass the final accumulated thinking content to save to database
      this.finalizeThinkingMessage(
        sessionId,
        turn.currentThinkingMessageId,
        turn.currentThinkingContent,
      );
    }

    // Skip thinking events - they are processed earlier in processAgentThinkingEvent
    if (stream === 'thinking') {
      return;
    }

    if (stream === 'tool' || stream === 'tools' || (!stream && hasToolShape)) {
      // Gateway format check: tool events may have 'tool', 'call', 'meta' directly in payload
      // (not nested in 'data'). Example: { stream: 'tool', tool: 'result:sessions_spawn', call: 'xxx', meta: 'label xxx' }
      const hasGatewayToolShape =
        typeof (agentPayload as Record<string, unknown>).tool === 'string';

      if (Array.isArray(agentPayload.data)) {
        for (const entry of agentPayload.data) {
          this.handleAgentToolEvent(sessionId, turn, entry);
        }
      } else if (hasGatewayToolShape) {
        // Gateway format: pass entire payload (contains tool, call, meta)
        this.handleAgentToolEvent(sessionId, turn, agentPayload);
      } else {
        this.handleAgentToolEvent(sessionId, turn, agentPayload.data);
      }
      return;
    }
    if (stream === 'lifecycle') {
      this.handleAgentLifecycleEvent(sessionId, agentPayload.data);
    }
  }

  private enqueuePendingAgentEvent(runId: string, payload: AgentEventPayload, seq?: number): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;

    const stream = typeof payload.stream === 'string' ? payload.stream.trim() : '';
    const hasToolShape = isRecord(payload.data) && typeof payload.data.toolCallId === 'string';
    const isSupportedStream =
      stream === 'tool' ||
      stream === 'tools' ||
      stream === 'lifecycle' ||
      stream === 'thinking' ||
      (!stream && hasToolShape);
    if (!isSupportedStream) return;

    const queued = this.pendingAgentEventsByRunId.get(normalizedRunId) ?? [];
    queued.push({
      runId: normalizedRunId,
      sessionKey: payload.sessionKey,
      stream: payload.stream,
      data: payload.data,
      ...(typeof seq === 'number' && Number.isFinite(seq) ? { seq } : {}),
    });
    if (queued.length > 240) {
      queued.shift();
    }
    this.pendingAgentEventsByRunId.set(normalizedRunId, queued);

    if (this.pendingAgentEventsByRunId.size > 400) {
      const oldestRunId = this.pendingAgentEventsByRunId.keys().next().value as string | undefined;
      if (oldestRunId) {
        this.pendingAgentEventsByRunId.delete(oldestRunId);
      }
    }
  }

  private flushPendingAgentEvents(sessionId: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;

    const queued = this.pendingAgentEventsByRunId.get(normalizedRunId);
    if (!queued || queued.length === 0) return;
    this.pendingAgentEventsByRunId.delete(normalizedRunId);

    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    for (const event of queued) {
      this.dispatchAgentEvent(sessionId, turn, event);
    }
  }

  private rememberSessionKey(sessionId: string, sessionKey: string): void {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    this.sessionIdBySessionKey.set(normalizedSessionKey, sessionId);
  }

  private resolveSessionIdBySessionKey(sessionKey: string): string | null {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return null;

    const mappedSessionId = this.sessionIdBySessionKey.get(normalizedSessionKey);
    if (mappedSessionId) {
      return mappedSessionId;
    }

    const parsedManagedSession = parseManagedSessionKey(normalizedSessionKey);
    if (!parsedManagedSession) {
      return null;
    }

    const session = this.store.getSession(parsedManagedSession.sessionId);
    if (!session) {
      return null;
    }

    this.rememberSessionKey(session.id, normalizedSessionKey);
    this.rememberSessionKey(session.id, this.toSessionKey(session.id, session.agentId));
    return session.id;
  }

  private nextTurnToken(sessionId: string): number {
    const nextToken = (this.latestTurnTokenBySession.get(sessionId) ?? 0) + 1;
    this.latestTurnTokenBySession.set(sessionId, nextToken);
    return nextToken;
  }

  private isCurrentTurnToken(sessionId: string, turnToken: number): boolean {
    return (this.latestTurnTokenBySession.get(sessionId) ?? 0) === turnToken;
  }

  private reuseFinalAssistantMessage(sessionId: string, content: string): string | null {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return null;
    }

    const session = this.store.getSession(sessionId);
    const lastMessage = session?.messages[session.messages.length - 1];
    if (!lastMessage || lastMessage.type !== 'assistant') {
      return null;
    }
    if (lastMessage.content.trim() !== normalizedContent) {
      return null;
    }

    this.store.updateMessage(sessionId, lastMessage.id, {
      content,
      metadata: {
        isStreaming: false,
        isFinal: true,
      },
    });
    return lastMessage.id;
  }

  private handleAgentLifecycleEvent(sessionId: string, data: unknown): void {
    if (!isRecord(data)) return;
    const phase = typeof data.phase === 'string' ? data.phase.trim() : '';

    // 调试：打印 lifecycle 事件
    console.log(
      '[OpenClawRuntime] lifecycle event: phase=' +
        phase +
        ' agentId=' +
        (typeof data.agentId === 'string' ? data.agentId : '(none)') +
        ' keys=' +
        Object.keys(data).join(','),
    );

    // 捕获子 Agent 生命周期事件
    const agentId = typeof data.agentId === 'string' ? data.agentId : undefined;
    if (agentId && agentId !== 'main-agent') {
      if (phase === 'start' || phase === 'running') {
        this.subagentStatus.set(agentId, 'running');
      } else if (
        phase === 'end' ||
        phase === 'completed' ||
        phase === 'stopped' ||
        phase === 'error'
      ) {
        this.subagentStatus.set(agentId, 'done');
      }
    }

    if (phase === 'start') {
      this.store.updateSession(sessionId, { status: 'running' });
    }
  }

  /**
   * Finalize a thinking message when the thinking stream ends.
   * Updates metadata to mark streaming as complete while preserving isThinking flag
   * so the message remains visible in the UI.
   * Also saves the final accumulated thinking content to the database.
   */
  private finalizeThinkingMessage(
    sessionId: string,
    messageId: string,
    finalThinkingContent?: string,
  ): void {
    const session = this.store.getSession(sessionId);
    const message = session?.messages.find(m => m.id === messageId);
    if (!message) return;

    // Preserve isThinking but mark streaming as ended
    const isThinking = message.metadata?.isThinking ?? true;
    const newMetadata = { isStreaming: false, isFinal: true, isThinking };

    // Update both metadata and thinkingContent in the database
    // If finalThinkingContent is provided, use it; otherwise keep existing content
    const updates: { metadata: typeof newMetadata; thinkingContent?: string } = {
      metadata: newMetadata,
    };
    if (finalThinkingContent !== undefined) {
      updates.thinkingContent = finalThinkingContent;
    }

    this.store.updateMessage(sessionId, messageId, updates);
    // Emit metadata update so UI reflects the finalized state (isStreaming: false)
    this.emit('messageMetadataUpdate', sessionId, messageId, newMetadata);
  }

  private handleAgentThinkingEvent(sessionId: string, turn: ActiveTurn, data: unknown): void {
    if (!isRecord(data)) return;

    const text = typeof data.text === 'string' ? data.text : '';
    const delta = typeof data.delta === 'string' ? data.delta : '';

    // First thinking event: create the assistant message if not exists
    if (!turn.currentThinkingMessageId) {
      // If we already have an assistantMessageId, reuse it for thinking
      // Otherwise create a new one
      if (turn.assistantMessageId) {
        turn.currentThinkingMessageId = turn.assistantMessageId;
      } else {
        // Use store.addMessage to create message - it generates its own ID
        // Set initial thinkingContent to the actual content from this event
        // OpenClaw's emitReasoningStream only sends events when text.trim() is non-empty,
        // so the first event should always have content
        const initialThinkingContent = text || delta || '';
        const thinkingMessage = this.store.addMessage(sessionId, {
          type: 'assistant',
          content: '',
          metadata: { isStreaming: true, isThinking: true },
          thinkingContent: initialThinkingContent,
          modelName: turn.modelName,
        });
        turn.currentThinkingMessageId = thinkingMessage.id;
        turn.assistantMessageId = thinkingMessage.id;
        // Initialize turn state with the first text/delta content
        turn.currentThinkingContent = initialThinkingContent;
        this.emit('message', sessionId, thinkingMessage);
        // Note: we don't emit thinkingUpdate for the initial content since
        // the message already includes it, and UI will render directly from the message event
        // Return early to skip the update logic below - the initial content is already set
        return;
      }
      // Reusing existing message: set currentThinkingContent to empty so update logic works
      turn.currentThinkingContent = '';
    }

    // Update thinking content - use text as the authoritative full content
    // and calculate the actual delta to emit
    let actualDelta = '';
    if (text) {
      // text is always the full accumulated content
      const previousContent = turn.currentThinkingContent;
      turn.currentThinkingContent = text;

      // Calculate actual delta: what's new in text compared to previous
      if (text.startsWith(previousContent) && text.length > previousContent.length) {
        actualDelta = text.slice(previousContent.length);
      } else if (previousContent === '') {
        // First event - send full text as delta
        actualDelta = text;
      } else {
        // Content reset or changed - send full text
        actualDelta = text;
      }
    } else if (delta) {
      // If only delta provided (no text), append it
      turn.currentThinkingContent += delta;
      actualDelta = delta;
    }

    // Emit thinking update event with the actual delta
    const messageId = turn.currentThinkingMessageId;
    if (messageId && actualDelta) {
      this.emit('thinkingUpdate', sessionId, messageId, actualDelta);
    }
  }

  private handleAgentToolEvent(sessionId: string, turn: ActiveTurn, data: unknown): void {
    if (!isRecord(data)) return;

    // Gateway may return tool events in two formats:
    // 1. Standard format: { phase, name, toolCallId, args, result, ... }
    // 2. Gateway format: { tool: 'result:sessions_spawn', call: 'xxx', meta: 'label xxx', err: false }
    // Parse both formats

    // Try gateway format first: tool='result:sessions_spawn', call='toolCallId', meta='label xxx'
    const toolField = typeof data.tool === 'string' ? data.tool.trim() : '';
    let phase: string;
    let toolName: string;
    let toolCallId: string;

    if (toolField && toolField.includes(':')) {
      // Gateway format: 'result:sessions_spawn' or 'start:sessions_spawn'
      const parts = toolField.split(':');
      phase = parts[0] === 'end' ? 'result' : parts[0];
      toolName = parts.slice(1).join(':') || 'Tool';
      // In gateway format, 'call' is the toolCallId
      toolCallId = typeof data.call === 'string' ? data.call.trim() : '';
    } else {
      // Standard format
      const rawPhase = typeof data.phase === 'string' ? data.phase.trim() : '';
      phase = rawPhase === 'end' ? 'result' : rawPhase;
      toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId.trim() : '';
      const toolNameRaw = typeof data.name === 'string' ? data.name.trim() : '';
      toolName = toolNameRaw || 'Tool';
    }

    if (!toolCallId) return;
    if (phase !== 'start' && phase !== 'update' && phase !== 'result') return;

    // Parse meta field from gateway format: 'label xxx, task yyy'
    // This provides label info when args is empty
    let metaLabel: string | null = null;
    const metaField = typeof data.meta === 'string' ? data.meta.trim() : '';
    if (metaField) {
      // meta format: 'label calc-1-plus-2, task 计算 1+2 的结果...'
      const labelMatch = metaField.match(/label\s+([^,]+)/);
      if (labelMatch && labelMatch[1]) {
        metaLabel = labelMatch[1].trim();
      }
    }

    // 调试：sessions_spawn 工具调用
    if (
      toolName === 'sessions_spawn' ||
      toolName === 'sessions_resume' ||
      toolName === 'sessions_read'
    ) {
      // Log full data structure to diagnose childSessionKey location
      const dataKeys = Object.keys(data);
      const hasResult = isRecord(data.result);
      const resultKeys = hasResult ? Object.keys(data.result as Record<string, unknown>) : [];
      console.log(
        '[OpenClawRuntime] subagent tool call: toolName=' +
          toolName +
          ' phase=' +
          phase +
          ' toolCallId=' +
          toolCallId +
          ' dataKeys=[' +
          dataKeys.join(',') +
          '] resultKeys=[' +
          resultKeys.join(',') +
          '] meta=' +
          (metaField || '(none)'),
      );
      // Log full result object if present
      if (hasResult) {
        try {
          const resultJson = JSON.stringify(data.result).slice(0, 500);
          console.log('[OpenClawRuntime] sessions_spawn result: ' + resultJson);
        } catch {
          console.log('[OpenClawRuntime] sessions_spawn result: (failed to stringify)');
        }
      }
    }

    // 当 sessions_spawn 开始时，使用 label 或 agentId 作为子任务标识符
    if (toolName === 'sessions_spawn' && phase === 'start') {
      const args = isRecord(data.args) ? (data.args as Record<string, unknown>) : {};
      // 保存 args 和 metaLabel 供 result 阶段使用
      const savedInfo = {
        ...args,
        _metaLabel: metaLabel,
      };
      this.toolCallArgs.set(toolCallId, savedInfo);

      const agentId =
        typeof args.agentId === 'string' && args.agentId
          ? args.agentId
          : typeof args.label === 'string' && args.label
            ? args.label
            : metaLabel || '';
      if (agentId) {
        this.subagentStatus.set(agentId, 'running');
      }
    }

    // 当 sessions_spawn 返回结果时，建立 label → childSessionKey 映射
    if (toolName === 'sessions_spawn' && phase === 'result' && !data.isError && !data.err) {
      // Try to get childSessionKey from various sources
      let childSessionKey: string | null = null;

      // 1. From result object
      const result = data.result;
      if (isRecord(result)) {
        childSessionKey =
          typeof result.childSessionKey === 'string' ? result.childSessionKey : null;
      }

      // 2. From data.sessionKey or data.childSessionKey
      if (!childSessionKey) {
        childSessionKey =
          typeof data.sessionKey === 'string'
            ? data.sessionKey
            : typeof data.childSessionKey === 'string'
              ? data.childSessionKey
              : null;
      }

      // Get label from saved args or meta field
      const savedInfo = this.toolCallArgs.get(toolCallId);
      const savedArgs = savedInfo && isRecord(savedInfo) ? savedInfo : {};
      const label =
        typeof savedArgs.label === 'string' && savedArgs.label
          ? savedArgs.label
          : typeof savedArgs._metaLabel === 'string' && savedArgs._metaLabel
            ? savedArgs._metaLabel
            : metaLabel || null;
      const inputAgentId =
        typeof savedArgs.agentId === 'string' && savedArgs.agentId ? savedArgs.agentId : null;

      const mappingKey = label || inputAgentId;
      if (childSessionKey && mappingKey) {
        console.log(
          '[OpenClawRuntime] sessions_spawn mapping: label=' +
            mappingKey +
            ' childSessionKey=' +
            childSessionKey,
        );
        this.labelToSessionKey.set(mappingKey, childSessionKey);
        this.sessionKeyToLabel.set(childSessionKey, mappingKey);
      } else {
        console.log(
          '[OpenClawRuntime] sessions_spawn missing mapping: childSessionKey=' +
            (childSessionKey || '(none)') +
            ' mappingKey=' +
            (mappingKey || '(none)'),
        );
        // When childSessionKey is missing from gateway tool event, query sessions.list
        // to get child session info and establish mapping
        // Get parent sessionKey from the event or store
        const parentSessionKey = turn.sessionKey;
        if (mappingKey && parentSessionKey && this.gatewayClient) {
          // Async query - don't block the event processing
          void this.querySubagentSessionKey(mappingKey, parentSessionKey);
        }
      }
      // 清理保存的 args
      this.toolCallArgs.delete(toolCallId);
    }

    // 当 sessions_resume 或 sessions_read 完成时，标记子任务完成
    if ((toolName === 'sessions_resume' || toolName === 'sessions_read') && phase === 'result') {
      // Get agentId from args or meta field
      const args = isRecord(data.args) ? (data.args as Record<string, unknown>) : {};
      const agentId =
        typeof args.agentId === 'string' && args.agentId
          ? args.agentId
          : typeof args.label === 'string' && args.label
            ? args.label
            : metaLabel || '';
      if (agentId && this.subagentStatus.has(agentId)) {
        this.subagentStatus.set(agentId, 'done');
      }
    }

    if (toolName.toLowerCase() === 'browser') {
      const isError = Boolean(data.isError);
      // Log full data keys and values for diagnosis
      const dataKeys = Object.keys(data);
      const resultType =
        data.result === undefined
          ? 'undefined'
          : data.result === null
            ? 'null'
            : typeof data.result === 'string'
              ? `string(len=${data.result.length})`
              : Array.isArray(data.result)
                ? `array(len=${data.result.length})`
                : `object(keys=${Object.keys(data.result as Record<string, unknown>).join(',')})`;
      console.log(
        `[OpenClawRuntime] browser tool event: phase=${phase} toolCallId=${toolCallId}` +
          ` dataKeys=[${dataKeys.join(',')}] resultType=${resultType}` +
          (phase === 'start' ? ` args=${JSON.stringify(data.args ?? {}).slice(0, 500)}` : '') +
          (phase === 'result' ? ` isError=${isError}` : ''),
      );
      if (phase === 'result') {
        // Log full result for browser events (may contain error details)
        try {
          const fullResult = JSON.stringify(data.result, null, 2);
          console.log(
            `[OpenClawRuntime] browser tool result (${toolCallId}): ${fullResult?.slice(0, 2000) ?? '(null)'}`,
          );
        } catch {
          console.log(
            `[OpenClawRuntime] browser tool result (${toolCallId}): [unstringifiable] ${String(data.result).slice(0, 500)}`,
          );
        }
        if (isError) {
          // Log any additional error-related fields
          const errorFields: Record<string, unknown> = {};
          for (const key of dataKeys) {
            if (/error|reason|message|detail|status/i.test(key)) {
              errorFields[key] = data[key];
            }
          }
          if (Object.keys(errorFields).length > 0) {
            console.log(
              `[OpenClawRuntime] browser tool error fields (${toolCallId}): ${JSON.stringify(errorFields).slice(0, 1000)}`,
            );
          }
        }
      }
      // Probe browser control service reachability from Electron main process
      this.probeBrowserControlService(toolCallId, phase);
    }

    if (!turn.toolUseMessageIdByToolCallId.has(toolCallId)) {
      const toolUseMessage = this.store.addMessage(sessionId, {
        type: 'tool_use',
        content: `Using tool: ${toolName}`,
        metadata: {
          toolName,
          toolInput: toToolInputRecord(data.args),
          toolUseId: toolCallId,
        },
      });
      turn.toolUseMessageIdByToolCallId.set(toolCallId, toolUseMessage.id);
      this.emit('message', sessionId, toolUseMessage);
    }

    if (phase === 'update') {
      const incoming = extractToolText(data.partialResult);
      if (!incoming.trim()) return;

      const previous = turn.toolResultTextByToolCallId.get(toolCallId) ?? '';
      const merged = mergeStreamingText(previous, incoming, 'unknown').text;

      const existingResultMessageId = turn.toolResultMessageIdByToolCallId.get(toolCallId);
      if (!existingResultMessageId) {
        const resultMessage = this.store.addMessage(sessionId, {
          type: 'tool_result',
          content: merged,
          metadata: {
            toolResult: merged,
            toolUseId: toolCallId,
            isError: false,
            isStreaming: true,
            isFinal: false,
          },
        });
        turn.toolResultMessageIdByToolCallId.set(toolCallId, resultMessage.id);
        turn.toolResultTextByToolCallId.set(toolCallId, merged);
        this.emit('message', sessionId, resultMessage);
        return;
      }

      if (merged !== previous) {
        this.store.updateMessage(sessionId, existingResultMessageId, {
          content: merged,
          metadata: {
            toolResult: merged,
            toolUseId: toolCallId,
            isError: false,
            isStreaming: true,
            isFinal: false,
          },
        });
        turn.toolResultTextByToolCallId.set(toolCallId, merged);
        this.emit('messageUpdate', sessionId, existingResultMessageId, merged);
      }
      return;
    }

    if (phase === 'result') {
      const incoming = extractToolText(data.result);
      const previous = turn.toolResultTextByToolCallId.get(toolCallId) ?? '';
      const isError = Boolean(data.isError);
      const finalContent = incoming.trim() ? incoming : previous;
      const finalError = isError ? finalContent || 'Tool execution failed' : undefined;
      const existingResultMessageId = turn.toolResultMessageIdByToolCallId.get(toolCallId);

      if (existingResultMessageId) {
        this.store.updateMessage(sessionId, existingResultMessageId, {
          content: finalContent,
          metadata: {
            toolResult: finalContent,
            toolUseId: toolCallId,
            error: finalError,
            isError,
            isStreaming: false,
            isFinal: true,
          },
        });
        this.emit('messageUpdate', sessionId, existingResultMessageId, finalContent);
      } else {
        const resultMessage = this.store.addMessage(sessionId, {
          type: 'tool_result',
          content: finalContent,
          metadata: {
            toolResult: finalContent,
            toolUseId: toolCallId,
            error: finalError,
            isError,
            isStreaming: false,
            isFinal: true,
          },
        });
        turn.toolResultMessageIdByToolCallId.set(toolCallId, resultMessage.id);
        this.emit('message', sessionId, resultMessage);
      }
      turn.toolResultTextByToolCallId.set(toolCallId, finalContent);
    }
  }

  private handleChatEvent(payload: unknown, seq?: number): void {
    if (!isRecord(payload)) return;
    const chatPayload = payload as ChatEventPayload;
    const state = chatPayload.state;
    if (!state) return;
    console.debug(
      '[OpenClawRuntime] handleChatEvent:',
      `state=${state}`,
      `runId=${typeof chatPayload.runId === 'string' ? chatPayload.runId : ''}`,
      `sessionKey=${typeof chatPayload.sessionKey === 'string' ? chatPayload.sessionKey : ''}`,
      `message=${summarizeGatewayMessageShape(chatPayload.message)}`,
    );

    const chatRunId = typeof chatPayload.runId === 'string' ? chatPayload.runId.trim() : '';
    const chatSessionKey =
      typeof chatPayload.sessionKey === 'string' ? chatPayload.sessionKey.trim() : '';

    const sessionId = this.resolveSessionIdFromChatPayload(chatPayload);
    if (!sessionId) {
      console.log('[Debug:handleChatEvent] no sessionId resolved, dropping event');
      return;
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      console.log('[Debug:handleChatEvent] no active turn for sessionId:', sessionId);
      return;
    }

    // Buffer chat events while user messages are being prefetched for channel sessions
    if (turn.pendingUserSync) {
      console.log(
        '[Debug:handleChatEvent] buffering chat event (pendingUserSync), sessionId:',
        sessionId,
        'buffered:',
        turn.bufferedChatPayloads.length + 1,
      );
      turn.bufferedChatPayloads.push({ payload, seq, bufferedAt: Date.now() });
      return;
    }

    const runId = typeof chatPayload.runId === 'string' ? chatPayload.runId.trim() : '';
    if (typeof seq === 'number' && Number.isFinite(seq) && runId) {
      const lastSeq = this.lastChatSeqByRunId.get(runId);
      if (lastSeq !== undefined && seq <= lastSeq) {
        return;
      }
      this.lastChatSeqByRunId.set(runId, seq);
    }

    if (state === 'delta') {
      this.handleChatDelta(sessionId, turn, chatPayload);
      return;
    }

    if (state === 'final') {
      this.handleChatFinal(sessionId, turn, chatPayload);
      return;
    }

    if (state === 'aborted') {
      this.handleChatAborted(sessionId, turn);
      return;
    }

    if (state === 'error') {
      this.handleChatError(sessionId, turn, chatPayload);
    }
  }

  private updateTurnTextState(
    turn: ActiveTurn,
    message: unknown,
    options: { protectBoundaryDrops?: boolean; forceReplace?: boolean } = {},
  ): void {
    const contentText = extractMessageText(message).trim();
    const { textBlocks, sawNonTextContentBlocks } = extractTextBlocksAndSignals(message);

    if (contentText) {
      const nextContentBlocks = textBlocks.length > 0 ? textBlocks : [contentText];
      const shouldProtectBoundaryDrop = Boolean(
        options.protectBoundaryDrops &&
        (turn.sawNonTextContentBlocks || sawNonTextContentBlocks) &&
        isDroppedBoundaryTextBlockSubset(turn.currentContentBlocks, nextContentBlocks),
      );
      if (!shouldProtectBoundaryDrop) {
        if (options.forceReplace) {
          turn.currentContentText = contentText;
          turn.currentContentBlocks = nextContentBlocks;
          turn.textStreamMode = 'snapshot';
        } else {
          const merged = mergeStreamingText(
            turn.currentContentText,
            contentText,
            turn.textStreamMode,
          );
          turn.currentContentText = merged.text;
          turn.textStreamMode = merged.mode;
          if (merged.mode === 'snapshot') {
            turn.currentContentBlocks = nextContentBlocks;
          } else {
            const mergedText = merged.text.trim();
            if (mergedText) {
              turn.currentContentBlocks = [mergedText];
            }
          }
        }
      }
    }

    if (sawNonTextContentBlocks) {
      turn.sawNonTextContentBlocks = true;
    }
    turn.currentText = turn.currentContentText.trim();
  }

  private resolveFinalTurnText(turn: ActiveTurn, message: unknown): string {
    const streamedText = turn.currentText.trim();
    const streamedTextBlocks = [...turn.currentContentBlocks];
    const streamedSawNonTextContentBlocks = turn.sawNonTextContentBlocks;

    this.updateTurnTextState(turn, message, { forceReplace: true });
    const finalText = turn.currentText.trim();

    if (!finalText) {
      return streamedText;
    }

    const shouldFallbackToStreamedText =
      streamedSawNonTextContentBlocks &&
      isDroppedBoundaryTextBlockSubset(streamedTextBlocks, turn.currentContentBlocks);
    if (shouldFallbackToStreamedText && streamedText) {
      turn.currentContentText = streamedText;
      turn.currentContentBlocks = streamedTextBlocks;
      turn.currentText = streamedText;
      return streamedText;
    }

    return finalText;
  }

  private resolveAssistantSegmentText(turn: ActiveTurn, fullText: string): string {
    const normalizedFullText = fullText.trim();
    const committed = turn.committedAssistantText;
    if (!normalizedFullText) {
      return '';
    }
    if (!committed) {
      return normalizedFullText;
    }
    if (normalizedFullText.startsWith(committed)) {
      return normalizedFullText.slice(committed.length).trimStart();
    }
    return normalizedFullText;
  }

  /**
   * Process agent thinking-stream events directly from handleGatewayEvent.
   * This bypasses handleAgentEvent's session resolution (which may enqueue events),
   * ensuring thinking updates are processed immediately and displayed before assistant text.
   */
  private processAgentThinkingEvent(payload: unknown): void {
    if (!isRecord(payload)) return;
    const p = payload as Record<string, unknown>;
    if (p.stream !== 'thinking') return;

    const dataField = isRecord(p.data) ? (p.data as Record<string, unknown>) : p;
    const text = typeof dataField.text === 'string' ? dataField.text : '';
    const delta = typeof dataField.delta === 'string' ? dataField.delta : '';

    const runId = typeof p.runId === 'string' ? p.runId.trim() : '';
    const sessionKey = typeof p.sessionKey === 'string' ? p.sessionKey.trim() : '';
    let sessionId = runId ? this.sessionIdByRunId.get(runId) : undefined;
    if (!sessionId && sessionKey) {
      sessionId = this.resolveSessionIdBySessionKey(sessionKey) ?? undefined;
      if (!sessionId && this.channelSessionSync) {
        sessionId =
          this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
          (!this.heartbeatSessionKeys.has(sessionKey) &&
            this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
          this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
          undefined;
        if (sessionId) {
          this.rememberSessionKey(sessionId, sessionKey);
        }
      }
      if (sessionId && !this.activeTurns.has(sessionId)) {
        this.ensureActiveTurn(sessionId, sessionKey, runId);
      }
      if (sessionId && runId) {
        this.bindRunIdToTurn(sessionId, runId);
      }
    }
    const turn = sessionId ? this.activeTurns.get(sessionId) : undefined;

    if (!turn || !sessionId) {
      console.debug(
        '[Debug:processThinking] skipped: runId:',
        runId.slice(0, 8),
        'sessionKey:',
        sessionKey,
        'sid:',
        !!sessionId,
        'turn:',
        !!turn,
      );
      return;
    }

    // Call the actual thinking event handler
    this.handleAgentThinkingEvent(sessionId, turn, p.data);
  }

  /**
   * Process agent assistant-stream text directly from handleGatewayEvent.
   * This bypasses handleAgentEvent's session resolution (which may enqueue events),
   * ensuring text updates and reset detection always work.
   */
  private processAgentAssistantText(payload: unknown): void {
    if (!isRecord(payload)) return;
    const p = payload as Record<string, unknown>;
    if (p.stream !== 'assistant') return;

    const dataField = isRecord(p.data) ? (p.data as Record<string, unknown>) : p;
    const text =
      extractOpenClawAssistantStreamText(dataField) || extractOpenClawAssistantStreamText(p);

    const runId = typeof p.runId === 'string' ? p.runId.trim() : '';
    const sessionKey = typeof p.sessionKey === 'string' ? p.sessionKey.trim() : '';
    let sessionId = runId ? this.sessionIdByRunId.get(runId) : undefined;
    if (!sessionId && sessionKey) {
      sessionId = this.resolveSessionIdBySessionKey(sessionKey) ?? undefined;
      if (!sessionId && this.channelSessionSync) {
        sessionId =
          this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
          (!this.heartbeatSessionKeys.has(sessionKey) &&
            this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
          this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
          undefined;
        if (sessionId) {
          this.rememberSessionKey(sessionId, sessionKey);
        }
      }
      if (sessionId && !this.activeTurns.has(sessionId)) {
        this.ensureActiveTurn(sessionId, sessionKey, runId);
      }
      if (sessionId && runId) {
        this.bindRunIdToTurn(sessionId, runId);
      }
    }
    const turn = sessionId ? this.activeTurns.get(sessionId) : undefined;

    if (!text || !turn || !sessionId) {
      if (text) {
        console.debug(
          '[Debug:processAssistant] skipped: text.len:',
          text.length,
          'runId:',
          runId.slice(0, 8),
          'sessionKey:',
          sessionKey,
          'sid:',
          !!sessionId,
          'turn:',
          !!turn,
        );
      }
      return;
    }

    // Detect text reset: new model call starts → text length drops significantly.
    // Only trigger when hwm is meaningful (> 5 chars) to avoid false positives
    // from early chat delta / agent event interleaving.
    if (
      text.length < turn.agentAssistantTextLength &&
      turn.agentAssistantTextLength > 5 &&
      turn.assistantMessageId
    ) {
      console.debug(
        '[Debug:textReset] detected:',
        turn.agentAssistantTextLength,
        '->',
        text.length,
        'splitting. prevText:',
        turn.currentText.slice(0, 80),
      );
      this.splitAssistantSegmentBeforeTool(sessionId, turn);
      turn.agentAssistantTextLength = 0;
    }

    // Track high-water mark.
    turn.agentAssistantTextLength = Math.max(turn.agentAssistantTextLength, text.length);

    // Update turn text state and push to store.
    turn.currentText = text;
    turn.currentAssistantSegmentText = this.resolveAssistantSegmentText(turn, text);

    // Check if current assistantMessageId is a thinking message
    // If so, finalize it and create a new assistant message for text content
    if (turn.assistantMessageId && turn.currentThinkingMessageId === turn.assistantMessageId) {
      const session = this.store.getSession(sessionId);
      const existingMsg = session?.messages.find(m => m.id === turn.assistantMessageId);
      const isThinkingMsg = existingMsg?.metadata?.isThinking === true;

      if (isThinkingMsg) {
        // Finalize thinking message and prepare for text content
        turn.thinkingStreamEnded = true;
        turn.assistantMessageId = null;
        this.finalizeThinkingMessage(
          sessionId,
          turn.currentThinkingMessageId!,
          turn.currentThinkingContent,
        );
      }
    }

    if (!turn.assistantMessageId && turn.currentAssistantSegmentText) {
      // Create a new message for the new text segment (after split or thinking end).
      const assistantMessage = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: turn.currentAssistantSegmentText,
        metadata: { isStreaming: true, isFinal: false },
        modelName: turn.modelName,
      });
      turn.assistantMessageId = assistantMessage.id;
      this.emit('message', sessionId, assistantMessage);
    } else if (turn.assistantMessageId && turn.currentAssistantSegmentText) {
      this.throttledStoreUpdateMessage(
        sessionId,
        turn.assistantMessageId,
        turn.currentAssistantSegmentText,
        { isStreaming: true, isFinal: false },
      );
      this.throttledEmitMessageUpdate(
        sessionId,
        turn.assistantMessageId,
        turn.currentAssistantSegmentText,
      );
    }
  }

  private splitAssistantSegmentBeforeTool(sessionId: string, turn: ActiveTurn): void {
    if (!turn.assistantMessageId) return;
    const messageId = turn.assistantMessageId;

    // Flush pending throttled updates so store content is current before reading.
    this.flushPendingStoreUpdate(sessionId, messageId);
    this.clearPendingMessageUpdate(messageId);

    // Committed text: use agentAssistantTextLength as the reliable segment length,
    // since currentText/currentAssistantSegmentText may be overwritten by chat deltas.
    // Read the actual content from the store (which was updated by processAgentAssistantText).
    const session = this.store.getSession(sessionId);
    const currentMsg = session?.messages.find(m => m.id === messageId);
    const storeContent = currentMsg?.content?.trim() || '';

    if (storeContent) {
      turn.committedAssistantText = `${turn.committedAssistantText}${storeContent}`;
    }

    this.store.updateMessage(sessionId, messageId, {
      metadata: { isStreaming: false, isFinal: true },
    });
    if (storeContent) {
      this.emit('messageUpdate', sessionId, messageId, storeContent);
    }

    turn.assistantMessageId = null;
    turn.currentAssistantSegmentText = '';
  }

  private handleChatDelta(sessionId: string, turn: ActiveTurn, payload: ChatEventPayload): void {
    // End thinking stream when we receive text content
    if (!turn.thinkingStreamEnded && turn.currentThinkingMessageId) {
      turn.thinkingStreamEnded = true;
      // Reset assistantMessageId so response text creates a new message
      // instead of reusing the thinking message.
      turn.assistantMessageId = null;
      // Update thinking message metadata to mark streaming as ended
      // Pass the final accumulated thinking content to save to database
      this.finalizeThinkingMessage(
        sessionId,
        turn.currentThinkingMessageId,
        turn.currentThinkingContent,
      );
    }

    const previousText = turn.currentText;
    const previousContentText = turn.currentContentText;
    const previousContentBlocks = [...turn.currentContentBlocks];
    const previousSawNonTextContentBlocks = turn.sawNonTextContentBlocks;
    const previousTextStreamMode = turn.textStreamMode;
    const previousSegmentText = turn.currentAssistantSegmentText;

    this.updateTurnTextState(turn, payload.message, { protectBoundaryDrops: true });

    // Debug: log when non-text content blocks first appear during streaming
    if (turn.sawNonTextContentBlocks && !previousSawNonTextContentBlocks) {
      console.log(
        '[Debug:handleChatDelta] non-text content blocks detected during streaming, sessionId:',
        sessionId,
      );
      if (
        isRecord(payload.message) &&
        Array.isArray((payload.message as Record<string, unknown>).content)
      ) {
        const content = (payload.message as Record<string, unknown>).content as Array<
          Record<string, unknown>
        >;
        for (const block of content) {
          if (
            isRecord(block) &&
            typeof block.type === 'string' &&
            block.type !== 'text' &&
            block.type !== 'thinking'
          ) {
            console.log(
              '[Debug:handleChatDelta] non-text block:',
              JSON.stringify(block).slice(0, 1000),
            );
          }
        }
      }
    }
    const streamedText = turn.currentText;
    if (previousText && streamedText && streamedText.length < previousText.length) {
      turn.currentText = previousText;
      turn.currentContentText = previousContentText;
      turn.currentContentBlocks = previousContentBlocks;
      turn.sawNonTextContentBlocks = previousSawNonTextContentBlocks;
      turn.textStreamMode = previousTextStreamMode;
      return;
    }

    if (!streamedText) return;
    const segmentText = this.resolveAssistantSegmentText(turn, streamedText);
    if (!segmentText) return;
    if (segmentText === previousSegmentText && streamedText === previousText) return;

    if (!turn.assistantMessageId) {
      const assistantMessage = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: segmentText,
        metadata: {
          isStreaming: true,
          isFinal: false,
        },
        modelName: turn.modelName,
      });
      turn.assistantMessageId = assistantMessage.id;
      turn.currentAssistantSegmentText = segmentText;
      this.emit('message', sessionId, assistantMessage);
      return;
    }

    if (turn.assistantMessageId && segmentText !== previousSegmentText) {
      // Only update in-memory state; SQLite write and IPC emit are handled
      // by processAgentAssistantText on the agent event path.
      turn.currentAssistantSegmentText = segmentText;
    }
  }

  private async handleChatFinal(
    sessionId: string,
    turn: ActiveTurn,
    payload: ChatEventPayload,
  ): Promise<void> {
    const previousText = turn.currentText;
    const previousSegmentText = turn.currentAssistantSegmentText;
    const finalText = this.resolveFinalTurnText(turn, payload.message);
    console.debug(
      '[OpenClawRuntime] handleChatFinal:',
      `sessionId=${sessionId}`,
      `runId=${payload.runId ?? turn.runId}`,
      `message=${summarizeGatewayMessageShape(payload.message)}`,
      `previousTextLen=${previousText.length}`,
      `finalTextLen=${finalText.length}`,
      `finalText="${truncate(finalText, 200)}"`,
    );
    turn.currentText = finalText;
    if (finalText && turn.currentContentBlocks.length === 0) {
      turn.currentContentText = finalText;
      turn.currentContentBlocks = [finalText];
    }
    const finalSegmentText = this.resolveAssistantSegmentText(turn, finalText);
    turn.currentAssistantSegmentText = finalSegmentText;

    if (turn.assistantMessageId) {
      // Flush any pending throttled updates so store content is current.
      this.flushPendingStoreUpdate(sessionId, turn.assistantMessageId);
      this.clearPendingMessageUpdate(turn.assistantMessageId);
      const storeSession = this.store.getSession(sessionId);
      const storeMsg = storeSession?.messages.find(m => m.id === turn.assistantMessageId);
      if (storeMsg?.content) {
        this.emit('messageUpdate', sessionId, turn.assistantMessageId, storeMsg.content);
      }

      const persistedSegmentText = finalSegmentText || previousSegmentText;
      if (persistedSegmentText) {
        this.store.updateMessage(sessionId, turn.assistantMessageId, {
          content: persistedSegmentText,
          metadata: {
            isStreaming: false,
            isFinal: true,
          },
        });
        if (persistedSegmentText !== previousSegmentText) {
          this.emit('messageUpdate', sessionId, turn.assistantMessageId, persistedSegmentText);
        }
      }
    } else if (finalSegmentText) {
      console.log(
        '[Debug:handleChatFinal] no assistantMessageId, creating new message with finalSegmentText',
      );
      const reusedMessageId = this.reuseFinalAssistantMessage(sessionId, finalSegmentText);
      if (reusedMessageId) {
        console.log('[Debug:handleChatFinal] reused message id:', reusedMessageId);
        turn.assistantMessageId = reusedMessageId;
      } else {
        const assistantMessage = this.store.addMessage(sessionId, {
          type: 'assistant',
          content: finalSegmentText,
          metadata: {
            isStreaming: false,
            isFinal: true,
          },
          modelName: turn.modelName,
        });
        turn.assistantMessageId = assistantMessage.id;
        this.emit('message', sessionId, assistantMessage);
      }
    }

    if (!finalText.trim()) {
      console.debug(
        '[OpenClawRuntime] handleChatFinal: final payload had no text, falling back to chat.history sync',
        `sessionId=${sessionId}`,
        `runId=${payload.runId ?? turn.runId}`,
      );
      await this.syncFinalAssistantWithHistory(sessionId, turn);
    }

    const messageRecord = isRecord(payload.message) ? payload.message : null;
    const stopReason =
      payload.stopReason ??
      (messageRecord && typeof messageRecord.stopReason === 'string'
        ? messageRecord.stopReason
        : undefined);
    const errorMessageFromMessage =
      messageRecord && typeof messageRecord.errorMessage === 'string'
        ? messageRecord.errorMessage
        : undefined;
    const stoppedByError = stopReason === 'error';
    if (stoppedByError) {
      const errorMessage =
        payload.errorMessage?.trim() || errorMessageFromMessage?.trim() || 'OpenClaw run failed';
      const erroredSessionKey = turn.sessionKey;
      this.store.updateSession(sessionId, { status: 'error' });
      this.emit('error', sessionId, errorMessage);
      this.cleanupSessionTurn(sessionId);
      this.rejectTurn(sessionId, new Error(errorMessage));
      // Reconcile even on error so the UI shows messages already delivered.
      void this.reconcileWithHistory(sessionId, erroredSessionKey);
      return;
    }

    // Reconcile local messages with authoritative gateway history.
    // This replaces the old syncFinalAssistantWithHistory + syncChannelAfterTurn flow.
    // Awaited so that IM handlers reading from the store see reconciled data.
    await this.reconcileWithHistory(sessionId, turn.sessionKey);

    // Detect thinking-only response: the last API call returned no visible text
    // (only a thinking block), causing the run to complete silently without output.
    // This happens with qwen3.5-plus under very large context (~380K tokens).
    // Signal: turn.currentText is empty AND there was at least one tool call in the run.
    const sessionAfterReconcile = this.store.getSession(sessionId);
    if (sessionAfterReconcile) {
      const msgs = sessionAfterReconcile.messages;
      const hadToolCall = msgs.some(m => m.type === 'tool_result');
      const lastApiResponseHadNoText = !turn.currentText.trim();
      console.debug(
        '[OpenClawRuntime] run end diagnostics, sessionId:',
        sessionId,
        'turn.currentText:',
        JSON.stringify(turn.currentText?.slice(0, 100)),
        'turn.committedAssistantText:',
        JSON.stringify(turn.committedAssistantText?.slice(0, 100)),
        'hadToolCall:',
        hadToolCall,
        'lastApiResponseHadNoText:',
        lastApiResponseHadNoText,
      );
      if (hadToolCall && lastApiResponseHadNoText) {
        const hintMessage = this.store.addMessage(sessionId, {
          type: 'system',
          content: t('taskThinkingOnly'),
        });
        this.emit('message', sessionId, hintMessage);
        console.warn('[OpenClawRuntime] thinking-only response detected, sessionId:', sessionId);
      }
    }

    this.store.updateSession(sessionId, { status: 'completed' });
    this.emit('complete', sessionId, payload.runId ?? turn.runId);
    this.cleanupSessionTurn(sessionId);
    this.resolveTurn(sessionId);
  }

  private handleChatAborted(sessionId: string, turn: ActiveTurn): void {
    this.store.updateSession(sessionId, { status: 'idle' });
    if (!turn.stopRequested && !this.manuallyStoppedSessions.has(sessionId)) {
      // The run was aborted without user request — most likely a timeout.
      // Add a visible hint so the user knows the task was interrupted.
      const hintMessage = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: t('taskTimedOut'),
        metadata: { isTimeout: true },
        modelName: turn.modelName,
      });
      this.emit('message', sessionId, hintMessage);
      this.emit('complete', sessionId, turn.runId);
    }
    const abortedSessionKey = turn.sessionKey;
    this.cleanupSessionTurn(sessionId);
    this.resolveTurn(sessionId);
    void this.reconcileWithHistory(sessionId, abortedSessionKey);
  }

  private handleChatError(sessionId: string, turn: ActiveTurn, payload: ChatEventPayload): void {
    console.log(
      '[OpenClawRuntime] handleChatError payload:',
      JSON.stringify(payload).slice(0, 1000),
    );
    let errorMessage = payload.errorMessage?.trim() || 'OpenClaw run failed';

    // Detect model API errors that are likely caused by unsupported image content
    // in tool results (e.g., Read tool returning image blocks for non-vision models).
    // Only match 400 Bad Request — other 4xx codes (403 forbidden, 429 rate limit, etc.)
    // have unrelated causes and should show their original error message.
    if (/^400\b/.test(errorMessage)) {
      errorMessage +=
        '\n\n[Hint: If the model attempted to read an image file, this may be because the model does not support image input. Consider using a vision-capable model or avoid sending image files.]';
    }

    const erroredSessionKey = turn.sessionKey;
    this.store.updateSession(sessionId, { status: 'error' });
    // Persist error message to SQLite so it survives session switches
    const errorMsg = this.store.addMessage(sessionId, {
      type: 'system',
      content: errorMessage,
      metadata: { error: errorMessage },
    });
    this.emit('message', sessionId, errorMsg);
    this.emit('error', sessionId, errorMessage);
    this.cleanupSessionTurn(sessionId);
    this.rejectTurn(sessionId, new Error(errorMessage));
    void this.reconcileWithHistory(sessionId, erroredSessionKey);
  }

  private handleApprovalRequested(payload: unknown): void {
    if (!isRecord(payload)) return;
    const typedPayload = payload as ExecApprovalRequestedPayload;
    const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
    if (!requestId) return;
    if (!typedPayload.request || !isRecord(typedPayload.request)) return;

    const request = typedPayload.request;
    const sessionKey = typeof request.sessionKey === 'string' ? request.sessionKey.trim() : '';
    let sessionId = sessionKey
      ? (this.resolveSessionIdBySessionKey(sessionKey) ?? undefined)
      : undefined;

    // Try to resolve channel-originated sessions for approval requests
    if (!sessionId && sessionKey && this.channelSessionSync) {
      const channelSessionId =
        this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
        (!this.heartbeatSessionKeys.has(sessionKey) &&
          this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
        this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
        null;
      if (channelSessionId) {
        this.rememberSessionKey(channelSessionId, sessionKey);
        sessionId = channelSessionId;
      }
    }

    if (!sessionId) {
      return;
    }

    const command = typeof request.command === 'string' ? request.command : '';
    const isChannelSession = this.channelSessionSync?.isChannelSessionKey(sessionKey) ?? false;

    // Auto-approve: channel sessions always, local sessions for non-delete commands.
    // Intentionally allows non-delete dangerous commands (git push, kill, chmod) without
    // prompting — this is a deliberate trade-off to avoid the approval-pending timing
    // issue on fresh installs.  Only file-deletion commands warrant a blocking modal.
    // The allow-always decision adds the command to the gateway allowlist so subsequent
    // calls skip the approval flow entirely.
    if (isChannelSession || !isDeleteCommand(command)) {
      this.pendingApprovals.set(requestId, { requestId, sessionId, allowAlways: true });
      this.respondToPermission(requestId, { behavior: 'allow', updatedInput: {} });
    }
    // Suppress approval popups for sessions in stop cooldown — the user
    // already stopped the session, so showing a new permission dialog
    // would be confusing.  The Gateway-side run will time out on its own.
    if (this.isSessionInStopCooldown(sessionId)) {
      return;
    }

    this.pendingApprovals.set(requestId, { requestId, sessionId });

    const { level: dangerLevel, reason: dangerReason } = getCommandDangerLevel(command);

    const permissionRequest: PermissionRequest = {
      requestId,
      toolName: 'Bash',
      toolInput: {
        command,
        dangerLevel,
        dangerReason,
        cwd: request.cwd ?? null,
        host: request.host ?? null,
        security: request.security ?? null,
        ask: request.ask ?? null,
        resolvedPath: request.resolvedPath ?? null,
        sessionKey: request.sessionKey ?? null,
        agentId: request.agentId ?? null,
      },
      toolUseId: requestId,
    };

    this.emit('permissionRequest', sessionId, permissionRequest);
  }

  private handleApprovalResolved(payload: unknown): void {
    if (!isRecord(payload)) return;
    const typedPayload = payload as ExecApprovalResolvedPayload;
    const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
    if (!requestId) return;
    this.pendingApprovals.delete(requestId);
  }

  private resolveSessionIdFromChatPayload(payload: ChatEventPayload): string | null {
    const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
    if (runId && this.sessionIdByRunId.has(runId)) {
      const sid = this.sessionIdByRunId.get(runId) ?? null;
      return sid;
    }

    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
    if (sessionKey) {
      const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
      if (sessionId) {
        // Re-create ActiveTurn for channel session follow-up turns
        this.ensureActiveTurn(sessionId, sessionKey, runId);
        if (runId) {
          this.bindRunIdToTurn(sessionId, runId);
        }
        return sessionId;
      }
    }

    // Try to resolve channel-originated sessions
    if (sessionKey && this.channelSessionSync) {
      const channelSessionId =
        this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
        (!this.heartbeatSessionKeys.has(sessionKey) &&
          this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
        this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
        null;
      if (channelSessionId) {
        // If this key was previously deleted, allow re-creation but skip history sync
        if (this.deletedChannelKeys.has(sessionKey)) {
          this.deletedChannelKeys.delete(sessionKey);
          this.fullySyncedSessions.add(channelSessionId);
          this.reCreatedChannelSessionIds.add(channelSessionId);
          console.debug(
            '[resolveSessionId] re-created after delete, skipping history sync for:',
            sessionKey,
          );
        }
        this.rememberSessionKey(channelSessionId, sessionKey);
        this.ensureActiveTurn(channelSessionId, sessionKey, runId);
        if (runId) {
          this.bindRunIdToTurn(channelSessionId, runId);
        }
        return channelSessionId;
      }
    }

    console.warn('[resolveSessionId] failed — runId:', runId, 'sessionKey:', sessionKey);
    return null;
  }

  private syncSystemMessagesFromHistory(
    sessionId: string,
    historyMessages: unknown[],
    options: { previousCountKnown: boolean; previousCount: number },
  ): void {
    if (historyMessages.length === 0) {
      this.gatewayHistoryCountBySession.set(sessionId, 0);
      return;
    }

    const canUseCursor =
      options.previousCountKnown &&
      options.previousCount >= 0 &&
      options.previousCount <= historyMessages.length;
    const entries = extractGatewayHistoryEntries(
      canUseCursor ? historyMessages.slice(options.previousCount) : historyMessages,
    );
    this.gatewayHistoryCountBySession.set(sessionId, historyMessages.length);

    const systemEntries = entries.filter(entry => entry.role === 'system');
    if (systemEntries.length === 0) {
      return;
    }

    const session = this.store.getSession(sessionId);
    const existingSystemTexts = new Set(
      (session?.messages ?? [])
        .filter(message => message.type === 'system')
        .map(message => message.content.trim())
        .filter(Boolean),
    );

    for (const entry of systemEntries) {
      if (existingSystemTexts.has(entry.text)) {
        continue;
      }

      const systemMessage = this.store.addMessage(sessionId, {
        type: 'system',
        content: entry.text,
        metadata: {},
      });
      existingSystemTexts.add(entry.text);
      this.emit('message', sessionId, systemMessage);
    }
  }

  /**
   * Channel history prefetch/full-sync intentionally skips historical system entries.
   * Seed the raw gateway history cursor so those older reminders are not replayed
   * under the next assistant reply during final-history sync.
   */
  private markGatewayHistoryWindowConsumed(sessionId: string, historyMessages: unknown[]): void {
    if (historyMessages.length === 0) {
      return;
    }
    this.gatewayHistoryCountBySession.set(sessionId, historyMessages.length);
  }

  /**
   * Reconcile local session messages with the authoritative gateway chat.history.
   *
   * This is the single source-of-truth sync method: after a turn completes,
   * it fetches the full conversation from OpenClaw and overwrites local
   * user/assistant messages to match exactly.  Tool messages (tool_use,
   * tool_result, system) are kept as-is because the gateway does not
   * expose them in chat.history.
   *
   * The reconciliation is idempotent — calling it multiple times produces
   * the same result.
   */
  private async reconcileWithHistory(
    sessionId: string,
    sessionKey: string,
    options?: { isFullSync?: boolean },
  ): Promise<void> {
    const client = this.gatewayClient;
    if (!client) {
      console.log('[Reconcile] no gateway client, skipping — sessionId:', sessionId);
      return;
    }

    const isManaged = isManagedSessionKey(sessionKey);
    const limit = options?.isFullSync
      ? OpenClawRuntimeAdapter.FULL_HISTORY_SYNC_LIMIT
      : FINAL_HISTORY_SYNC_LIMIT;

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit,
      });
      if (!Array.isArray(history?.messages) || history.messages.length === 0) {
        if (!isManaged) {
          console.log('[Reconcile] empty history — sessionId:', sessionId);
          this.channelSyncCursor.set(sessionId, 0);
        }
        return;
      }

      // Patch tool_result messages with content from history (gateway tool events
      // don't include the actual output — only the transcript does)
      this.patchToolResultsFromHistory(sessionId, history.messages);

      // For managed sessions, tool result patching is all we need.
      if (isManaged) {
        return;
      }

      // Update gateway history cursor for system message tracking
      this.gatewayHistoryCountBySession.set(sessionId, history.messages.length);

      // Sync system messages (reminders etc.)
      const previousHistoryCountKnown = this.gatewayHistoryCountBySession.has(sessionId);
      const previousHistoryCount = this.gatewayHistoryCountBySession.get(sessionId) ?? 0;
      this.syncSystemMessagesFromHistory(sessionId, history.messages, {
        previousCountKnown: previousHistoryCountKnown,
        previousCount: previousHistoryCount,
      });

      // Determine if this is a channel session (for Discord text normalization)
      const isChannel =
        this.channelSessionSync &&
        !isManagedSessionKey(sessionKey) &&
        this.channelSessionSync.isChannelSessionKey(sessionKey);
      const isDiscord = sessionKey.includes(':discord:');

      // Extract authoritative user/assistant entries from gateway history
      const session = this.store.getSession(sessionId);
      const sessionAgentId = session?.agentId || 'main';
      const sessionAgent = this.store.getAgent(sessionAgentId);
      const sessionRawModel = sessionAgent?.model || '';
      const sessionModelName = sessionRawModel.includes('/')
        ? sessionRawModel.slice(sessionRawModel.indexOf('/') + 1)
        : sessionRawModel;
      const authoritativeEntries: Array<{
        role: 'user' | 'assistant';
        text: string;
        modelName?: string;
      }> = [];
      for (const message of history.messages) {
        if (!isRecord(message)) continue;
        const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
        if (role !== 'user' && role !== 'assistant') continue;
        let text = extractMessageText(message).trim();
        if (!text) continue;
        if (isDiscord) text = stripDiscordMentions(text);
        authoritativeEntries.push({
          role: role as 'user' | 'assistant',
          text,
          ...(role === 'assistant' ? { modelName: sessionModelName } : {}),
        });
      }

      // For channel sessions, append file paths from "message" tool calls
      if (isChannel && authoritativeEntries.length > 0) {
        const sentFilePaths = extractSentFilePathsFromHistory(history.messages);
        if (sentFilePaths.length > 0) {
          const lastAssistantIdx = authoritativeEntries.findLastIndex(e => e.role === 'assistant');
          if (lastAssistantIdx >= 0) {
            const fileLinks = sentFilePaths.map(fp => `[${path.basename(fp)}](${fp})`).join('\n');
            authoritativeEntries[lastAssistantIdx] = {
              ...authoritativeEntries[lastAssistantIdx],
              text: `${authoritativeEntries[lastAssistantIdx].text}\n\n${fileLinks}`,
            };
          }
        }
      }

      if (authoritativeEntries.length === 0) {
        console.log('[Reconcile] no user/assistant entries in history — sessionId:', sessionId);
        this.channelSyncCursor.set(sessionId, 0);
        return;
      }

      // Collect local user/assistant messages for comparison
      const localSession = this.store.getSession(sessionId);
      const localEntries: Array<{ role: 'user' | 'assistant'; text: string }> = [];
      if (localSession) {
        for (const msg of localSession.messages) {
          if (msg.type !== 'user' && msg.type !== 'assistant') continue;
          const text = msg.content.trim();
          if (!text) continue;
          localEntries.push({ role: msg.type, text });
        }
      }

      // Compare: if already in sync, skip the expensive replace
      const isInSync =
        localEntries.length === authoritativeEntries.length &&
        localEntries.every(
          (entry, idx) =>
            entry.role === authoritativeEntries[idx].role &&
            entry.text === authoritativeEntries[idx].text,
        );

      if (isInSync) {
        console.log(
          '[Reconcile] already in sync — sessionId:',
          sessionId,
          'entries:',
          localEntries.length,
        );
        this.channelSyncCursor.set(sessionId, authoritativeEntries.length);
        return;
      }

      // Guard: don't replace if gateway returned fewer entries.
      // This typically means the gateway lost history (e.g., after restart)
      // and replacing would permanently destroy local messages.
      if (authoritativeEntries.length < localEntries.length) {
        console.log(
          '[Reconcile] skipping — gateway has fewer entries than local, preserving local history. sessionId:',
          sessionId,
          'local:',
          localEntries.length,
          'gateway:',
          authoritativeEntries.length,
        );
        this.channelSyncCursor.set(sessionId, localEntries.length);
        return;
      }

      // Replace local messages with authoritative ones
      console.log(
        '[Reconcile] replacing messages — sessionId:',
        sessionId,
        'local:',
        localEntries.length,
        '→ authoritative:',
        authoritativeEntries.length,
      );
      this.store.replaceConversationMessages(sessionId, authoritativeEntries);
      this.channelSyncCursor.set(sessionId, authoritativeEntries.length);

      // Notify renderer to refresh
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('cowork:sessions:changed');
        }
      }
    } catch (error) {
      console.warn('[Reconcile] failed — sessionId:', sessionId, 'error:', error);
    }
  }

  /**
   * Extract tool result content from chat.history messages and patch local
   * tool_result messages that have empty content.
   *
   * The gateway WebSocket `tool result` event does not include the actual tool
   * output — only a short `meta` summary.  The real output lives in the session
   * transcript, which chat.history reads from disk.
   */
  private patchToolResultsFromHistory(sessionId: string, historyMessages: unknown[]): void {
    const toolResultsByCallId = new Map<string, { text: string; isError: boolean }>();

    // Scan history for tool_result content: standalone messages and embedded blocks
    for (const raw of historyMessages) {
      if (!isRecord(raw)) continue;
      const message = raw as Record<string, unknown>;

      // Standalone tool_result message (role-level)
      const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
      if (
        role === 'tool_result' ||
        role === 'toolresult' ||
        role === 'tool' ||
        role === 'function'
      ) {
        const toolCallId =
          typeof message.toolCallId === 'string'
            ? message.toolCallId
            : typeof message.tool_call_id === 'string'
              ? message.tool_call_id
              : '';
        if (toolCallId) {
          const text = extractToolText(message.content) || extractToolText(message);
          if (text) {
            toolResultsByCallId.set(toolCallId, {
              text,
              isError: Boolean(message.isError),
            });
          }
        }
        continue;
      }

      // Content blocks with tool_result type (embedded in assistant messages)
      if (Array.isArray(message.content)) {
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (!isRecord(block)) continue;
          const blockType = typeof block.type === 'string' ? block.type.toLowerCase() : '';
          if (blockType !== 'tool_result' && blockType !== 'toolresult') continue;
          const toolCallId =
            typeof block.toolCallId === 'string'
              ? block.toolCallId
              : typeof block.tool_call_id === 'string'
                ? block.tool_call_id
                : '';
          if (!toolCallId) continue;
          const text = extractToolText(block);
          if (text) {
            toolResultsByCallId.set(toolCallId, {
              text,
              isError: Boolean(block.isError),
            });
          }
        }
      }
    }

    if (toolResultsByCallId.size === 0) return;

    // Patch local tool_result messages that have empty content
    const session = this.store.getSession(sessionId);
    if (!session) return;

    let patchedCount = 0;
    for (const msg of session.messages) {
      if (msg.type !== 'tool_result') continue;
      if (msg.content?.trim()) continue;
      const toolUseId = msg.metadata?.toolUseId as string | undefined;
      if (!toolUseId) continue;
      const result = toolResultsByCallId.get(toolUseId);
      if (!result) continue;

      this.store.updateMessage(sessionId, msg.id, {
        content: result.text,
        metadata: {
          ...msg.metadata,
          toolResult: result.text,
          isError: result.isError,
          error: result.isError ? result.text : undefined,
        },
      });
      this.emit('messageUpdate', sessionId, msg.id, result.text);
      patchedCount++;
    }
    if (patchedCount > 0) {
      console.log('[patchToolResults] patched', patchedCount, 'messages for sessionId:', sessionId);
    }
  }

  private async syncFinalAssistantWithHistory(sessionId: string, turn: ActiveTurn): Promise<void> {
    console.log('[Debug:syncFinal] start — sessionId:', sessionId, 'sessionKey:', turn.sessionKey);
    const client = this.gatewayClient;
    if (!client) {
      console.log('[Debug:syncFinal] no gateway client, skipping');
      return;
    }

    try {
      const retryDelaysMs = [0, 120, 250, 500];
      let historyMessages: unknown[] | null = null;
      let canonicalText = '';
      let isChannel = false;

      for (const delayMs of retryDelaysMs) {
        if (delayMs > 0) {
          await sleep(delayMs);
        }

        const history = await client.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey: turn.sessionKey,
          limit: FINAL_HISTORY_SYNC_LIMIT,
        });
        const msgCount = Array.isArray(history?.messages) ? history.messages.length : 0;
        console.log(
          '[Debug:syncFinal] chat.history returned',
          msgCount,
          'messages',
          `afterDelay=${delayMs}`,
        );
        if (!Array.isArray(history?.messages) || history.messages.length === 0) {
          this.gatewayHistoryCountBySession.set(sessionId, 0);
          continue;
        }

        historyMessages = history.messages;
        const previousHistoryCountKnown = this.gatewayHistoryCountBySession.has(sessionId);
        const previousHistoryCount = this.gatewayHistoryCountBySession.get(sessionId) ?? 0;
        this.syncSystemMessagesFromHistory(sessionId, history.messages, {
          previousCountKnown: previousHistoryCountKnown,
          previousCount: previousHistoryCount,
        });

        // Debug: dump all history message roles and content types
        for (let i = 0; i < history.messages.length; i++) {
          const m = history.messages[i] as Record<string, unknown>;
          if (!isRecord(m)) continue;
          const r = typeof m.role === 'string' ? m.role : '?';
          let contentSummary: string;
          if (Array.isArray(m.content)) {
            const types = (m.content as Array<Record<string, unknown>>)
              .filter(isRecord)
              .map(b => b.type);
            contentSummary = `blocks:[${types.join(',')}]`;
          } else if (typeof m.content === 'string') {
            contentSummary = `text(${(m.content as string).length})`;
          } else {
            contentSummary = String(typeof m.content);
          }
          console.log(`[Debug:syncFinal:history] [${i}] role=${r} content=${contentSummary}`);
          if (r !== 'user' && Array.isArray(m.content)) {
            for (const block of m.content as Array<Record<string, unknown>>) {
              if (
                isRecord(block) &&
                typeof block.type === 'string' &&
                block.type !== 'text' &&
                block.type !== 'thinking'
              ) {
                console.log(
                  `[Debug:syncFinal:history] [${i}] block:`,
                  JSON.stringify(block).slice(0, 800),
                );
              }
            }
          }
        }

        isChannel = Boolean(
          this.channelSessionSync &&
          !isManagedSessionKey(turn.sessionKey) &&
          this.channelSessionSync.isChannelSessionKey(turn.sessionKey),
        );
        if (isChannel) {
          const latestOnly = this.reCreatedChannelSessionIds.has(sessionId);
          this.syncChannelUserMessages(
            sessionId,
            history.messages,
            latestOnly,
            turn.sessionKey.includes(':discord:'),
          );
        }

        if (!this.isCurrentTurnToken(sessionId, turn.turnToken)) {
          console.log(
            '[Debug:syncFinal] stale turn token, skipping assistant text alignment for sessionId:',
            sessionId,
            'turnToken:',
            turn.turnToken,
          );
          return;
        }

        if (isChannel) {
          canonicalText = extractCurrentTurnAssistantText(history.messages);
        } else {
          for (let index = history.messages.length - 1; index >= 0; index -= 1) {
            const message = history.messages[index];
            if (!isRecord(message)) continue;
            const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
            if (role !== 'assistant') continue;
            canonicalText = extractMessageText(message).trim();
            if (canonicalText) {
              break;
            }
          }
        }

        if (canonicalText) {
          break;
        }
      }

      // Patch tool result messages with content from history (gateway tool events
      // do not include the actual output text).
      if (historyMessages) {
        this.patchToolResultsFromHistory(sessionId, historyMessages);
      }

      if (!historyMessages || !canonicalText) {
        console.log('[Debug:syncFinal] no canonical assistant text found in history');
        return;
      }

      // For channel sessions, append file paths from "message" tool calls as clickable links
      if (isChannel) {
        const sentFilePaths = extractSentFilePathsFromHistory(historyMessages);
        if (sentFilePaths.length > 0) {
          console.log('[Debug:syncFinal] found sent file paths:', sentFilePaths);
          const fileLinks = sentFilePaths.map(fp => `[${path.basename(fp)}](${fp})`).join('\n');
          canonicalText = `${canonicalText}\n\n${fileLinks}`;
        }
      }

      console.log(
        '[Debug:syncFinal] canonicalText length:',
        canonicalText.length,
        'assistantMessageId:',
        turn.assistantMessageId,
      );

      const canonicalSegmentText = this.resolveAssistantSegmentText(turn, canonicalText);
      console.debug(
        '[Debug:syncFinal] canonicalSegmentText length:',
        canonicalSegmentText.length,
        'committed.length:',
        turn.committedAssistantText.length,
        'segment:',
        canonicalSegmentText.slice(0, 80),
      );
      turn.currentText = canonicalText;
      turn.currentAssistantSegmentText = canonicalSegmentText;

      if (!canonicalSegmentText) {
        return;
      }

      if (!turn.assistantMessageId) {
        const reusedMessageId = this.reuseFinalAssistantMessage(sessionId, canonicalSegmentText);
        if (reusedMessageId) {
          turn.assistantMessageId = reusedMessageId;
          return;
        }

        const assistantMessage = this.store.addMessage(sessionId, {
          type: 'assistant',
          content: canonicalSegmentText,
          metadata: {
            isStreaming: false,
            isFinal: true,
          },
          modelName: turn.modelName,
        });
        turn.assistantMessageId = assistantMessage.id;
        this.emit('message', sessionId, assistantMessage);
        return;
      }

      const session = this.store.getSession(sessionId);
      const currentMessage = session?.messages.find(
        message => message.id === turn.assistantMessageId,
      );
      const currentText = currentMessage?.content.trim() ?? '';
      if (canonicalSegmentText === currentText) {
        // Content matches but renderer may not have received the last throttled update.
        // Force-emit so the UI shows the final text.
        this.emit('messageUpdate', sessionId, turn.assistantMessageId, canonicalSegmentText);
        return;
      }

      console.debug(
        '[Debug:syncFinal] updating last segment:',
        currentText.length,
        '->',
        canonicalSegmentText.length,
      );
      this.store.updateMessage(sessionId, turn.assistantMessageId, {
        content: canonicalSegmentText,
        metadata: {
          isStreaming: false,
          isFinal: true,
        },
      });
      this.emit('messageUpdate', sessionId, turn.assistantMessageId, canonicalSegmentText);
    } catch (error) {
      console.warn('[OpenClawRuntime] chat.history sync after final failed:', error);
    }
  }

  private collectChannelHistoryEntries(
    historyMessages: unknown[],
    isDiscord: boolean,
  ): ChannelHistorySyncEntry[] {
    const historyEntries: ChannelHistorySyncEntry[] = [];
    for (const message of historyMessages) {
      if (!isRecord(message)) continue;
      const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
      if (role !== 'user' && role !== 'assistant') continue;
      let text = extractMessageText(message).trim();
      if (isDiscord) text = stripDiscordMentions(text);
      if (text) {
        historyEntries.push({ role: role as 'user' | 'assistant', text });
      }
    }
    return historyEntries;
  }

  private collectLocalChannelEntries(sessionId: string): ChannelHistorySyncEntry[] {
    const session = this.store.getSession(sessionId);
    if (!session) return [];

    const localEntries: ChannelHistorySyncEntry[] = [];
    for (const msg of session.messages) {
      if (msg.type !== 'user' && msg.type !== 'assistant') continue;
      const text = msg.content.trim();
      if (!text) continue;
      localEntries.push({ role: msg.type, text });
    }
    return localEntries;
  }

  private computeChannelHistoryFirstNewIndex(
    localEntries: ChannelHistorySyncEntry[],
    historyEntries: ChannelHistorySyncEntry[],
    cursor: number,
  ): { firstNewIdx: number; strategy: string } {
    if (localEntries.length === 0) {
      return { firstNewIdx: 0, strategy: 'empty-local' };
    }

    // `chat.history` is byte-bounded in OpenClaw, so the returned window can slide
    // long before it reaches our requested count. Match the local tail against the
    // current history prefix to find the continuation point without trusting length.
    const maxOverlap = Math.min(localEntries.length, historyEntries.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      let matched = true;
      for (let idx = 0; idx < overlap; idx += 1) {
        const localEntry = localEntries[localEntries.length - overlap + idx];
        const historyEntry = historyEntries[idx];
        if (!isSameChannelHistoryEntry(localEntry, historyEntry)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { firstNewIdx: overlap, strategy: 'tail-overlap' };
      }
    }

    let lastLocalUserIdx = -1;
    for (let idx = localEntries.length - 1; idx >= 0; idx -= 1) {
      if (localEntries[idx].role === 'user') {
        lastLocalUserIdx = idx;
        break;
      }
    }

    if (lastLocalUserIdx >= 0) {
      const lastLocalUser = localEntries[lastLocalUserIdx];
      let prevLocalUserText: string | undefined;
      for (let idx = lastLocalUserIdx - 1; idx >= 0; idx -= 1) {
        if (localEntries[idx].role === 'user') {
          prevLocalUserText = localEntries[idx].text;
          break;
        }
      }

      for (let idx = historyEntries.length - 1; idx >= 0; idx -= 1) {
        if (
          historyEntries[idx].role !== 'user' ||
          historyEntries[idx].text !== lastLocalUser.text
        ) {
          continue;
        }
        if (prevLocalUserText !== undefined && idx > 0) {
          let prevHistUserText: string | undefined;
          for (let histIdx = idx - 1; histIdx >= 0; histIdx -= 1) {
            if (historyEntries[histIdx].role === 'user') {
              prevHistUserText = historyEntries[histIdx].text;
              break;
            }
          }
          if (prevHistUserText !== prevLocalUserText) {
            continue;
          }
        }
        return { firstNewIdx: idx + 1, strategy: 'last-user-anchor' };
      }
    }

    // When cursor > 0, tail-overlap and last-user-anchor (above) are the correct
    // content-based strategies for detecting a sliding history window.  If both
    // failed the mismatch is caused by duplicates in the local store, not by
    // genuinely new gateway messages.  Trust the cursor — it was set to
    // historyEntries.length at the end of the previous sync — instead of falling
    // through to forward-match, which can produce wildly wrong firstNewIdx values
    // when local entries are polluted (causing either an infinite re-sync loop
    // when cursor == historyEntries.length, or a burst of old messages being
    // re-synced when cursor < historyEntries.length).
    //
    // forward-match is still used when cursor == 0 (initial sync / after restart)
    // because there is no cursor history to rely on.
    if (cursor > 0) {
      if (cursor >= historyEntries.length) {
        return { firstNewIdx: historyEntries.length, strategy: 'cursor-stable' };
      }
      return { firstNewIdx: cursor, strategy: 'cursor-fallback' };
    }

    let localIdx = 0;
    let forwardFirstNewIdx = 0;
    for (let idx = 0; idx < historyEntries.length; idx += 1) {
      if (
        localIdx < localEntries.length &&
        isSameChannelHistoryEntry(historyEntries[idx], localEntries[localIdx])
      ) {
        localIdx += 1;
        forwardFirstNewIdx = idx + 1;
      }
    }
    if (forwardFirstNewIdx > 0) {
      return { firstNewIdx: forwardFirstNewIdx, strategy: 'forward-match' };
    }

    if (historyEntries.length < cursor) {
      return { firstNewIdx: 0, strategy: 'history-rewrite' };
    }

    return {
      firstNewIdx: Math.min(cursor, historyEntries.length),
      strategy: 'cursor-fallback',
    };
  }

  /**
   * Sync user messages from gateway chat.history that haven't been added to the local store yet.
   * Used for channel-originated sessions (e.g. Telegram) where user messages arrive via the
   * gateway rather than the GucciAI UI.
   *
   * Called at the start of a new turn (via prefetchChannelUserMessages) so that user messages
   * appear before the assistant's streaming response. Both chat and agent events are buffered
   * during prefetch, so the replay order matches direct cowork sessions.
   *
   * Reconciles against the local tail instead of trusting history length/cursor alone,
   * because OpenClaw's `chat.history` window can slide due to byte limits well before
   * the requested message count is reached.
   */
  private syncChannelUserMessages(
    sessionId: string,
    historyMessages: unknown[],
    latestOnly = false,
    isDiscord = false,
  ): void {
    const historyEntries = this.collectChannelHistoryEntries(historyMessages, isDiscord);

    const cursor = this.channelSyncCursor.get(sessionId) ?? 0;

    // When latestOnly is true (e.g. session re-created after deletion),
    // only sync the last user message — the one that triggered this turn.
    // Advance cursor to end so subsequent syncs don't replay old history.
    if (latestOnly) {
      if (historyEntries.length > 0) {
        const lastUser = [...historyEntries].reverse().find(entry => entry.role === 'user');
        if (lastUser) {
          // Dedup: skip if this message already exists locally
          const session = this.store.getSession(sessionId);
          const alreadyExists =
            session?.messages.some(
              (m: CoworkMessage) => m.type === 'user' && m.content.trim() === lastUser.text,
            ) ?? false;
          if (!alreadyExists) {
            const userMessage = this.store.addMessage(sessionId, {
              type: 'user',
              content: lastUser.text,
              metadata: {},
            });
            this.emit('message', sessionId, userMessage);
          }
        }
      }
      this.channelSyncCursor.set(sessionId, historyEntries.length);
      return;
    }

    const localEntries = this.collectLocalChannelEntries(sessionId);
    const { firstNewIdx } = this.computeChannelHistoryFirstNewIndex(
      localEntries,
      historyEntries,
      cursor,
    );

    // Sync user messages from gateway history.
    // Only sync user messages here — assistant messages are already added by the
    // real-time streaming pipeline (handleChatDelta / handleAgentEvent) and by
    // syncFinalAssistantWithHistory's own addMessage/updateMessage logic.
    //
    // When syncing a user message, check whether the corresponding assistant response
    // was already created locally (e.g. due to prefetch timeout where the assistant
    // streamed before user messages were synced). If so, use insertMessageBeforeId
    // to place the user message before the assistant — preserving correct chronological
    // order. This handles the race condition where gateway chat.history lags behind
    // the real-time streaming events.
    let syncedCount = 0;

    // Collect all user message indices that need syncing:
    // 1. Normal: user messages from firstNewIdx onwards
    // 2. Repair: user messages before firstNewIdx that are missing locally
    //    (can happen when computeChannelHistoryFirstNewIndex's forward-match
    //    strategy matches the assistant but skips the preceding user message)
    const currentSession = this.store.getSession(sessionId);
    const localUserTexts = new Set<string>();
    if (currentSession) {
      for (const msg of currentSession.messages) {
        if (msg.type === 'user') {
          localUserTexts.add(msg.content.trim());
        }
      }
    }

    const userIndicesToSync: number[] = [];
    // Normal range: from firstNewIdx onwards, with dedup against local messages
    for (let i = firstNewIdx; i < historyEntries.length; i++) {
      if (historyEntries[i].role === 'user' && !localUserTexts.has(historyEntries[i].text)) {
        userIndicesToSync.push(i);
      }
    }
    // Repair range: before firstNewIdx, missing locally
    for (let i = 0; i < firstNewIdx; i++) {
      if (historyEntries[i].role === 'user' && !localUserTexts.has(historyEntries[i].text)) {
        userIndicesToSync.push(i);
      }
    }

    for (const idx of userIndicesToSync) {
      const entry = historyEntries[idx];

      // Find the next assistant entry in history after this user entry, then
      // look for a matching local assistant message. If found, insert the user
      // message before it to maintain correct chronological order.
      let insertBeforeId: string | null = null;
      if (currentSession) {
        for (let j = idx + 1; j < historyEntries.length; j++) {
          if (historyEntries[j].role !== 'assistant') continue;
          const assistantText = historyEntries[j].text;
          // Match by content prefix — local text may be segmented or truncated
          const matchPrefix = assistantText.slice(0, 100);
          const localMatch = currentSession.messages.find(
            (m: CoworkMessage) =>
              m.type === 'assistant' && m.content.trim().startsWith(matchPrefix),
          );
          if (localMatch) {
            insertBeforeId = localMatch.id;
          }
          break;
        }
      }

      let userMessage;
      if (insertBeforeId) {
        userMessage = this.store.insertMessageBeforeId(sessionId, insertBeforeId, {
          type: 'user',
          content: entry.text,
          metadata: {},
        });
        console.debug(
          '[syncChannelUserMessages] inserted user message before assistant, sessionId:',
          sessionId,
        );
      } else {
        userMessage = this.store.addMessage(sessionId, {
          type: 'user',
          content: entry.text,
          metadata: {},
        });
      }
      this.emit('message', sessionId, userMessage);
      localUserTexts.add(entry.text);
      syncedCount++;
    }

    this.channelSyncCursor.set(sessionId, historyEntries.length);
  }

  private getUserMessageCount(sessionId: string): number {
    const session = this.store.getSession(sessionId);
    if (!session) return 0;
    return session.messages.filter((m: CoworkMessage) => m.type === 'user').length;
  }

  /**
   * Sync full conversation history for a newly discovered channel session.
   * Adds both user and assistant messages to the local CoworkStore in order.
   * Skipped if the session has already been fully synced.
   *
   * Uses position-based matching to avoid false dedup of identical-content messages.
   */

  private async syncFullChannelHistory(sessionId: string, sessionKey: string): Promise<void> {
    if (this.fullySyncedSessions.has(sessionId)) return;
    this.fullySyncedSessions.add(sessionId);

    try {
      await this.reconcileWithHistory(sessionId, sessionKey, { isFullSync: true });
    } catch (error) {
      console.error('[ChannelSync] syncFullChannelHistory: error:', error);
      // Remove from synced set so retry is possible
      this.fullySyncedSessions.delete(sessionId);
    }
  }

  /**
   * Incremental sync for an already-known channel session.
   * Delegates to reconcileWithHistory which handles diff and update.
   */
  private async incrementalChannelSync(sessionId: string, sessionKey: string): Promise<void> {
    await this.reconcileWithHistory(sessionId, sessionKey);
  }

  /**
   * Trigger an immediate incremental sync after a channel session turn completes,
   * so that the renderer sees the latest messages without waiting for the next poll.
   */
  private syncChannelAfterTurn(sessionId: string, sessionKey: string): void {
    if (!this.channelSessionSync || !sessionKey) return;
    if (!this.channelSessionSync.isChannelSessionKey(sessionKey)) return;
    if (!this.fullySyncedSessions.has(sessionId)) return;

    void this.reconcileWithHistory(sessionId, sessionKey).catch(err => {
      console.warn('[ChannelSync] post-turn incremental sync failed for', sessionKey, err);
    });
  }

  private clearPendingApprovalsBySession(sessionId: string): void {
    for (const [requestId, pending] of this.pendingApprovals.entries()) {
      if (pending.sessionId === sessionId) {
        this.pendingApprovals.delete(requestId);
      }
    }
  }

  private cleanupSessionTurn(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      // Clear client-side timeout watchdog
      if (turn.timeoutTimer) {
        clearTimeout(turn.timeoutTimer);
        turn.timeoutTimer = undefined;
      }
      // Cancel any pending throttled messageUpdate timer for this turn
      if (turn.assistantMessageId) {
        this.clearPendingMessageUpdate(turn.assistantMessageId);
        this.lastMessageUpdateEmitTime.delete(turn.assistantMessageId);
        this.clearPendingStoreUpdate(turn.assistantMessageId);
        this.lastStoreUpdateTime.delete(turn.assistantMessageId);
      }
      turn.knownRunIds.forEach(knownRunId => {
        this.sessionIdByRunId.delete(knownRunId);
        this.pendingAgentEventsByRunId.delete(knownRunId);
        this.lastChatSeqByRunId.delete(knownRunId);
        this.lastAgentSeqByRunId.delete(knownRunId);
      });
    }
    this.activeTurns.delete(sessionId);
    setCoworkProxySessionId(null);
    // NOTE: Do NOT clear lastSystemPromptBySession here — it must persist
    // across turns so that the system prompt is only injected on the first
    // turn of a session (or when it actually changes).  Cleanup happens in
    // onSessionDeleted() when the session is removed entirely.
    this.reCreatedChannelSessionIds.delete(sessionId);
  }

  /**
   * Start a client-side timeout watchdog for a turn.
   * Fires after the server-side timeout + grace period, recovering the UI
   * if the gateway fails to deliver the abort/final event.
   */
  private startTurnTimeoutWatchdog(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    const timeoutMs =
      this.agentTimeoutSeconds * 1000 + OpenClawRuntimeAdapter.CLIENT_TIMEOUT_GRACE_MS;
    turn.timeoutTimer = setTimeout(() => {
      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnToken !== turn.turnToken) return;
      console.warn(
        `[OpenClawRuntime] Client-side timeout watchdog fired for session ${sessionId}, ` +
          `runId=${currentTurn.runId} after ${timeoutMs}ms — gateway did not deliver abort event`,
      );
      this.handleChatAborted(sessionId, currentTurn);
    }, timeoutMs);
  }

  /**
   * Called when a session is deleted from the store.
   * Purges all in-memory references so that new channel messages
   * with the same sessionKey can create a fresh session.
   */
  onSessionDeleted(sessionId: string, agentId?: string): void {
    // Remove sessionIdBySessionKey entries pointing to this session
    // IMPORTANT: Save removedKeys BEFORE deleting for OpenClaw sync
    const removedKeys: string[] = [];
    for (const [key, id] of this.sessionIdBySessionKey.entries()) {
      if (id === sessionId) {
        removedKeys.push(key);
        this.sessionIdBySessionKey.delete(key);
      }
    }

    // If removedKeys is empty, build sessionKey from agentId parameter or default to 'main'
    if (removedKeys.length === 0) {
      const effectiveAgentId = agentId || 'main';
      const sessionKey = this.toSessionKey(sessionId, effectiveAgentId);
      removedKeys.push(sessionKey);
    }

    console.log(
      `[OpenClaw] onSessionDeleted: sessionId=${sessionId}, agentId=${agentId}, removedKeys=${JSON.stringify(removedKeys)}, totalKeysInMap=${this.sessionIdBySessionKey.size}`,
    );

    // Sync deletion to OpenClaw Gateway FIRST (using saved removedKeys)
    // Wait for gatewayClient to be ready before attempting deletion
    this.deleteOpenClawSessionByKeysWithRetry(sessionId, removedKeys).catch(err => {
      console.warn(`[OpenClaw] deleteOpenClawSessionByKeysWithRetry error for ${sessionId}:`, err);
    });
    // Suppress polling re-creation for deleted channel keys.
    // Only real-time events (new IM messages) will re-create the session.
    for (const key of removedKeys) {
      this.deletedChannelKeys.add(key);
    }

    // Allow polling to rediscover channel sessions
    this.knownChannelSessionIds.delete(sessionId);

    // Allow full history re-sync when session is re-created
    this.fullySyncedSessions.delete(sessionId);
    this.channelSyncCursor.delete(sessionId);
    this.reCreatedChannelSessionIds.delete(sessionId);
    this.gatewayHistoryCountBySession.delete(sessionId);
    this.latestTurnTokenBySession.delete(sessionId);
    this.stoppedSessions.delete(sessionId);

    // Clean up active turn and related run-id mappings
    this.cleanupSessionTurn(sessionId);

    // Clean up pending approvals, bridged state, confirmation mode
    this.clearPendingApprovalsBySession(sessionId);
    this.bridgedSessions.delete(sessionId);
    this.confirmationModeBySession.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);

    // Propagate to channel session sync
    if (this.channelSessionSync) {
      this.channelSessionSync.onSessionDeleted(sessionId);
    }
  }

  /**
   * Sync deletion to OpenClaw Gateway by calling sessions.delete API.
   * Deletes the remote session and all its related sessions (subagents, title sessions, etc).
   */
  private async deleteOpenClawSessionByKeys(sessionKeys: string[]): Promise<void> {
    const client = this.gatewayClient;
    if (!client || sessionKeys.length === 0) {
      console.log(
        `[OpenClaw] deleteOpenClawSessionByKeys: skipped, client=${!!client}, keys=${sessionKeys.length}`,
      );
      return;
    }

    console.log(
      `[OpenClaw] deleteOpenClawSessionByKeys: starting with keys=${JSON.stringify(sessionKeys)}`,
    );

    // Extract agentId from the first sessionKey (format: agent:{agentId}:gucciai:{sessionId})
    const agentId = this.extractAgentIdFromSessionKey(sessionKeys[0]);

    // Delete all related sessions in parallel for efficiency
    const deletePromises: Promise<void>[] = [];

    for (const sessionKey of sessionKeys) {
      deletePromises.push(this.deleteSessionTree(client, sessionKey));
    }

    // Also delete orphan subagent and title sessions at agent level
    if (agentId) {
      deletePromises.push(this.deleteAgentLevelSessions(client, agentId));
    }

    await Promise.allSettled(deletePromises);
    console.log(`[OpenClaw] deleteOpenClawSessionByKeys: completed`);
  }

  /**
   * Delete orphan subagent and title sessions at agent level.
   * These sessions have keys like: agent:{agentId}:subagent:{uuid}, agent:{agentId}:title:{uuid}
   * They are not spawnedBy the GucciAI session, but should be cleaned up when the session is deleted.
   */
  private async deleteAgentLevelSessions(
    client: GatewayClientLike,
    agentId: string,
  ): Promise<void> {
    try {
      // Query all sessions for this agent
      const listResult = await client.request<{
        sessions?: Array<{ key: string; spawnedBy?: string }>;
      }>('sessions.list', { agentId, limit: 200 });

      console.log(
        `[OpenClaw] deleteAgentLevelSessions: agentId=${agentId}, found ${listResult.sessions?.length ?? 0} sessions`,
      );

      for (const session of listResult.sessions ?? []) {
        // Delete sessions that are:
        // 1. Not spawnedBy a GucciAI session (no spawnedBy or spawnedBy doesn't contain 'gucciai')
        // 2. Are subagent or title sessions (contain :subagent: or :title:)
        const isSubagentOrTitle =
          session.key.includes(':subagent:') || session.key.includes(':title:');
        const isNotSpawnedByGucciAI = !session.spawnedBy || !session.spawnedBy.includes('gucciai');

        if (isSubagentOrTitle && isNotSpawnedByGucciAI) {
          try {
            await client.request('sessions.delete', {
              key: session.key,
              deleteTranscript: true,
            });
            console.log(`[OpenClaw] deleteAgentLevelSessions: deleted ${session.key}`);
          } catch (err) {
            console.warn(
              `[OpenClaw] deleteAgentLevelSessions: failed to delete ${session.key}:`,
              err,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`[OpenClaw] deleteAgentLevelSessions: error querying agent ${agentId}:`, err);
    }
  }

  /**
   * Extract agentId from session key format: agent:{agentId}:gucciai:{sessionId}
   */
  private extractAgentIdFromSessionKey(sessionKey: string): string | null {
    const match = /^agent:([^:]+):/.exec(sessionKey);
    return match ? match[1] : null;
  }

  /**
   * Delete OpenClaw sessions with retry - waits for gatewayClient to be ready.
   */
  private async deleteOpenClawSessionByKeysWithRetry(
    sessionId: string,
    sessionKeys: string[],
  ): Promise<void> {
    if (sessionKeys.length === 0) {
      console.log(
        `[OpenClaw] deleteOpenClawSessionByKeysWithRetry: no keys to delete for sessionId=${sessionId}`,
      );
      return;
    }

    // Wait for gatewayClient to be ready (with timeout)
    const maxWaitMs = 5000;
    const startTime = Date.now();
    while (!this.gatewayClient && Date.now() - startTime < maxWaitMs) {
      try {
        await this.ensureGatewayClientReady();
      } catch (err) {
        console.warn(
          `[OpenClaw] deleteOpenClawSessionByKeysWithRetry: waiting for gatewayClient...`,
          err,
        );
      }
      if (!this.gatewayClient) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    try {
      await this.deleteOpenClawSessionByKeys(sessionKeys);
      console.log(
        `[OpenClaw] deleteOpenClawSessionByKeysWithRetry completed for sessionId=${sessionId}`,
      );
    } catch (err) {
      console.warn(
        `[OpenClaw] deleteOpenClawSessionByKeysWithRetry failed for sessionId=${sessionId}:`,
        err,
      );
    }
  }

  /**
   * Delete a session and all sessions spawned by it (recursively).
   */
  private async deleteSessionTree(client: GatewayClientLike, sessionKey: string): Promise<void> {
    try {
      // Query sessions spawned by this session (includes subagents and possibly title sessions)
      const listResult = await client.request<{
        sessions?: Array<{ key: string; spawnedBy?: string }>;
      }>('sessions.list', { spawnedBy: sessionKey, limit: 100 });

      // Recursively delete child sessions first (depth-first)
      for (const childSession of listResult.sessions ?? []) {
        await this.deleteSessionTree(client, childSession.key);
      }

      // Delete this session (if not a main session like agent:xxx:main)
      if (!this.isMainSessionKey(sessionKey)) {
        await client.request('sessions.delete', {
          key: sessionKey,
          deleteTranscript: true,
        });
      }
    } catch (err) {
      console.warn(`[OpenClaw] Error deleting session tree ${sessionKey}:`, err);
    }
  }

  /**
   * Check if a sessionKey is a main session (e.g., agent:{agentId}:main).
   * Main sessions cannot be deleted via sessions.delete API.
   */
  private isMainSessionKey(key: string): boolean {
    return key.endsWith(':main');
  }

  /**
   * Ensure an ActiveTurn exists for a session. Used for channel-originated sessions
   * where new turns arrive after the previous turn was cleaned up.
   */
  private isSessionInStopCooldown(sessionId: string): boolean {
    const stoppedAt = this.stoppedSessions.get(sessionId);
    if (stoppedAt === undefined) return false;
    if (Date.now() - stoppedAt < OpenClawRuntimeAdapter.STOP_COOLDOWN_MS) {
      return true;
    }
    // Cooldown expired, remove the entry
    this.stoppedSessions.delete(sessionId);
    return false;
  }

  private ensureActiveTurn(sessionId: string, sessionKey: string, runId: string): void {
    if (this.activeTurns.has(sessionId)) return;
    // Suppress automatic turn re-creation for sessions that are still within
    // the stop cooldown window.  This prevents late-arriving OpenClaw events
    // (e.g. from POPO/Telegram) from restarting a stopped session.
    if (this.isSessionInStopCooldown(sessionId)) {
      console.log(
        '[Debug:ensureActiveTurn] suppressed — session in stop cooldown, sessionId:',
        sessionId,
      );
      return;
    }
    // Once the cooldown has expired, clear the manual-stop marker so that
    // genuinely new channel messages can create a fresh turn.  Without this,
    // `manuallyStoppedSessions` (a permanent Set) would block all future
    // channel events for this session until `runTurn` or `onSessionDeleted`
    // happens to clear it.
    if (this.manuallyStoppedSessions.has(sessionId)) {
      console.log(
        '[Debug:ensureActiveTurn] cooldown expired, clearing manuallyStoppedSessions for channel re-activation, sessionId:',
        sessionId,
      );
      this.manuallyStoppedSessions.delete(sessionId);
    }
    const turnRunId = runId || randomUUID();
    const turnToken = this.nextTurnToken(sessionId);
    const isChannel =
      this.channelSessionSync &&
      !isManagedSessionKey(sessionKey) &&
      this.channelSessionSync.isChannelSessionKey(sessionKey);
    const session = this.store.getSession(sessionId);
    const agentId = session?.agentId || 'main';
    const agent = this.store.getAgent(agentId);
    const rawModel = agent?.model || '';
    const modelName = rawModel.includes('/') ? rawModel.slice(rawModel.indexOf('/') + 1) : rawModel;
    console.log(
      '[Debug:ensureActiveTurn] creating turn — sessionId:',
      sessionId,
      'sessionKey:',
      sessionKey,
      'runId:',
      turnRunId,
      'isChannel:',
      !!isChannel,
      'pendingUserSync:',
      !!isChannel,
    );
    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId: turnRunId,
      turnToken,
      knownRunIds: new Set(runId ? [runId] : [turnRunId]),
      assistantMessageId: null,
      committedAssistantText: '',
      currentAssistantSegmentText: '',
      currentText: '',
      agentAssistantTextLength: 0,
      currentContentText: '',
      currentContentBlocks: [],
      sawNonTextContentBlocks: false,
      textStreamMode: 'unknown',
      toolUseMessageIdByToolCallId: new Map(),
      toolResultMessageIdByToolCallId: new Map(),
      toolResultTextByToolCallId: new Map(),
      stopRequested: false,
      pendingUserSync: !!isChannel,
      bufferedChatPayloads: [],
      bufferedAgentPayloads: [],
      currentThinkingMessageId: null,
      currentThinkingContent: '',
      thinkingStreamEnded: false,
      modelName,
    });
    if (runId) {
      this.sessionIdByRunId.set(runId, sessionId);
    }
    this.store.updateSession(sessionId, { status: 'running' });
    this.startTurnTimeoutWatchdog(sessionId);

    // For channel sessions, prefetch user messages before streaming starts
    if (isChannel) {
      void this.prefetchChannelUserMessages(sessionId, sessionKey);
    }
  }

  /**
   * Prefetch user messages from gateway history at the start of a channel session turn.
   * This ensures user messages appear before the assistant's streaming response.
   * Delta/final events are buffered until this completes.
   */
  private async prefetchChannelUserMessages(sessionId: string, sessionKey: string): Promise<void> {
    console.log('[Debug:prefetch] start — sessionId:', sessionId, 'sessionKey:', sessionKey);

    // Best-effort prefetch with 2 attempts. Final correctness is ensured by
    // reconcileWithHistory after the turn completes.
    const MAX_ATTEMPTS = 2;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const client = this.gatewayClient;
        if (!client) {
          console.log('[Debug:prefetch] no gateway client available');
          break;
        }

        const history = await client.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey,
          limit: FINAL_HISTORY_SYNC_LIMIT,
        });
        const msgCount = Array.isArray(history?.messages) ? history.messages.length : 0;
        console.log(
          '[Debug:prefetch] chat.history returned',
          msgCount,
          'messages (attempt',
          attempt,
          ')',
        );

        if (Array.isArray(history?.messages) && history.messages.length > 0) {
          this.markGatewayHistoryWindowConsumed(sessionId, history.messages);
          const latestOnly = this.reCreatedChannelSessionIds.has(sessionId);
          const beforeCount = this.getUserMessageCount(sessionId);
          this.syncChannelUserMessages(
            sessionId,
            history.messages,
            latestOnly,
            sessionKey.includes(':discord:'),
          );
          const afterCount = this.getUserMessageCount(sessionId);
          const newUserMessages = afterCount - beforeCount;
          console.log(
            '[Debug:prefetch] synced user messages:',
            newUserMessages,
            '(before:',
            beforeCount,
            'after:',
            afterCount,
            ')',
          );

          if (newUserMessages > 0) {
            break;
          }

          // Retry once if buffered events suggest history hasn't caught up yet
          if (attempt < MAX_ATTEMPTS - 1) {
            const turn = this.activeTurns.get(sessionId);
            if (
              turn &&
              (turn.bufferedChatPayloads.length > 0 || turn.bufferedAgentPayloads.length > 0)
            ) {
              console.log(
                '[Debug:prefetch] no new user messages but have buffered events, retrying after 500ms...',
              );
              await new Promise(resolve => setTimeout(resolve, 500));
              continue;
            }
          }
          break;
        } else {
          // Retry once if buffered events suggest history hasn't caught up yet
          if (attempt < MAX_ATTEMPTS - 1) {
            const turn = this.activeTurns.get(sessionId);
            if (
              turn &&
              (turn.bufferedChatPayloads.length > 0 || turn.bufferedAgentPayloads.length > 0)
            ) {
              console.log(
                '[Debug:prefetch] empty history but have buffered events, retrying after 500ms...',
              );
              await new Promise(resolve => setTimeout(resolve, 500));
              continue;
            }
          }
          break;
        }
      } catch (error) {
        console.warn(
          '[OpenClawRuntime] prefetchChannelUserMessages attempt',
          attempt,
          'failed:',
          error,
        );
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      console.log(
        '[Debug:prefetch] turn was removed during prefetch, cannot replay. sessionId:',
        sessionId,
      );
      return;
    }
    turn.pendingUserSync = false;

    const chatBuffered = turn.bufferedChatPayloads.length;
    const agentBuffered = turn.bufferedAgentPayloads.length;
    console.log(
      '[Debug:prefetch] replaying buffered events — chat:',
      chatBuffered,
      'agent:',
      agentBuffered,
    );

    // Merge and replay both chat and agent events in sequence order
    // so that tool use/result messages are interleaved with assistant text segments
    // just like in direct cowork sessions.
    const allBuffered: Array<{
      type: 'chat' | 'agent';
      payload: unknown;
      seq?: number;
      bufferedAt: number;
      idx: number;
    }> = [];
    let bufIdx = 0;
    for (const event of turn.bufferedChatPayloads) {
      allBuffered.push({
        type: 'chat',
        payload: event.payload,
        seq: event.seq,
        bufferedAt: event.bufferedAt,
        idx: bufIdx++,
      });
    }
    for (const event of turn.bufferedAgentPayloads) {
      allBuffered.push({
        type: 'agent',
        payload: event.payload,
        seq: event.seq,
        bufferedAt: event.bufferedAt,
        idx: bufIdx++,
      });
    }
    turn.bufferedChatPayloads = [];
    turn.bufferedAgentPayloads = [];

    allBuffered.sort((a, b) => {
      // Primary: sort by seq if both have it
      const hasSeqA = typeof a.seq === 'number';
      const hasSeqB = typeof b.seq === 'number';
      if (hasSeqA && hasSeqB) return a.seq! - b.seq!;
      // Events with seq come before events without
      if (hasSeqA !== hasSeqB) return hasSeqA ? -1 : 1;
      // Fallback: preserve arrival order via bufferedAt, then insertion index
      if (a.bufferedAt !== b.bufferedAt) return a.bufferedAt - b.bufferedAt;
      return a.idx - b.idx;
    });

    for (const event of allBuffered) {
      if (event.type === 'chat') {
        this.handleChatEvent(event.payload, event.seq);
      } else {
        this.handleAgentEvent(event.payload, event.seq);
      }
    }
    console.log('[Debug:prefetch] replay complete, sessionId:', sessionId);
  }

  private bindRunIdToTurn(sessionId: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    turn.knownRunIds.add(normalizedRunId);
    this.sessionIdByRunId.set(normalizedRunId, sessionId);
    this.flushPendingAgentEvents(sessionId, normalizedRunId);
  }

  private resolveTurn(sessionId: string): void {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    this.pendingTurns.delete(sessionId);
    pending.resolve();
  }

  private rejectTurn(sessionId: string, error: Error): void {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    this.pendingTurns.delete(sessionId);
    pending.reject(error);
  }

  private toSessionKey(sessionId: string, agentId?: string): string {
    return buildManagedSessionKey(sessionId, agentId);
  }

  private requireGatewayClient(): GatewayClientLike {
    if (!this.gatewayClient) {
      throw new Error('OpenClaw gateway client is unavailable.');
    }
    return this.gatewayClient;
  }

  /**
   * Return the current gateway client instance, or null if not yet connected.
   * Used by CronJobService to call cron.* APIs on the same gateway.
   */
  getGatewayClient(): GatewayClientLike | null {
    return this.gatewayClient;
  }

  getSessionKeysForSession(sessionId: string): string[] {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return [];
    }

    const keys: string[] = [];
    for (const [key, mappedSessionId] of this.sessionIdBySessionKey.entries()) {
      if (mappedSessionId === normalizedSessionId) {
        keys.push(key);
      }
    }

    const session = this.store.getSession(normalizedSessionId);
    const managedKey = this.toSessionKey(normalizedSessionId, session?.agentId);
    if (!keys.includes(managedKey)) {
      keys.push(managedKey);
    }

    keys.sort((left, right) => {
      const leftManaged = isManagedSessionKey(left);
      const rightManaged = isManagedSessionKey(right);
      if (leftManaged !== rightManaged) {
        return leftManaged ? 1 : -1;
      }
      return left.localeCompare(right);
    });

    return keys;
  }

  /**
   * Ensure the gateway client is connected and ready.
   * Resolves when the WebSocket connection is established and authenticated.
   */
  async ensureReady(): Promise<void> {
    await this.ensureGatewayClientReady();
  }

  /**
   * 获取子 Agent 状态
   * @param sessionId 可选，指定父会话 ID 进行过滤
   * 状态来源：
   * 1. 内存中的 subagentStatus（实时状态）
   * 2. CoworkStore 消息中的 sessions_spawn/sessions_resume/sessions_read（持久化状态）
   */
  getSubagentStatuses(sessionId?: string): Record<string, 'running' | 'done'> {
    // 如果指定了 sessionId 但不是当前编排的父会话，从数据库提取历史状态
    if (
      sessionId &&
      this.orchestrationParentSessionId &&
      sessionId !== this.orchestrationParentSessionId
    ) {
      // 从 CoworkStore 消息中提取子任务状态
      const session = this.store.getSession(sessionId);
      if (!session?.messages) return {};

      const statuses: Record<string, 'running' | 'done'> = {};
      const spawnLabels = new Set<string>();

      for (const msg of session.messages) {
        const meta = msg.metadata;
        if (!meta) continue;

        if (msg.type === 'tool_use' && meta.toolName === 'sessions_spawn') {
          const input = meta.toolInput as Record<string, unknown> | undefined;
          const label = typeof input?.label === 'string' && input.label ? input.label : '';
          const agentId = typeof input?.agentId === 'string' && input.agentId ? input.agentId : '';
          const key = label || agentId;
          if (key) {
            spawnLabels.add(key);
            statuses[key] = 'running'; // 默认为 running
          }
        }

        // sessions_resume 或 sessions_read 表示子任务完成
        if (
          msg.type === 'tool_use' &&
          (meta.toolName === 'sessions_resume' || meta.toolName === 'sessions_read')
        ) {
          const input = meta.toolInput as Record<string, unknown> | undefined;
          const label = typeof input?.label === 'string' && input.label ? input.label : '';
          const agentId = typeof input?.agentId === 'string' && input.agentId ? input.agentId : '';
          const key = label || agentId;
          if (key && statuses[key]) {
            statuses[key] = 'done';
          }
        }
      }

      // 如果会话已完成，所有子任务也标记为完成
      if (session.status === 'completed') {
        for (const key of spawnLabels) {
          statuses[key] = 'done';
        }
      }

      return statuses;
    }

    // 当前活跃会话：合并内存状态和消息状态
    const result: Record<string, 'running' | 'done'> = {};

    // 先从消息中提取
    if (sessionId) {
      const session = this.store.getSession(sessionId);
      if (session?.messages) {
        for (const msg of session.messages) {
          const meta = msg.metadata;
          if (!meta) continue;

          if (msg.type === 'tool_use' && meta.toolName === 'sessions_spawn') {
            const input = meta.toolInput as Record<string, unknown> | undefined;
            const label = typeof input?.label === 'string' && input.label ? input.label : '';
            const agentId =
              typeof input?.agentId === 'string' && input.agentId ? input.agentId : '';
            const key = label || agentId;
            if (key) {
              result[key] = 'running';
            }
          }

          if (
            msg.type === 'tool_use' &&
            (meta.toolName === 'sessions_resume' || meta.toolName === 'sessions_read')
          ) {
            const input = meta.toolInput as Record<string, unknown> | undefined;
            const label = typeof input?.label === 'string' && input.label ? input.label : '';
            const agentId =
              typeof input?.agentId === 'string' && input.agentId ? input.agentId : '';
            const key = label || agentId;
            if (key) {
              result[key] = 'done';
            }
          }
        }

        // 会话完成则所有子任务完成
        if (session.status === 'completed') {
          for (const key of Object.keys(result)) {
            result[key] = 'done';
          }
        }
      }
    }

    // 用内存状态覆盖（内存状态更实时）
    for (const [key, status] of this.subagentStatus) {
      result[key] = status;
    }

    return result;
  }

  /**
   * Query sessions.list to find subagent sessionKey and establish mapping.
   * Called when gateway tool event doesn't contain childSessionKey directly.
   */
  private async querySubagentSessionKey(label: string, parentSessionKey: string): Promise<void> {
    if (!this.gatewayClient) return;

    try {
      const sessionsResult = await this.gatewayClient.request<{
        sessions?: Array<{ key: string; label?: string; spawnedBy?: string }>;
      }>('sessions.list', {
        spawnedBy: parentSessionKey,
        limit: 20,
      });

      const childSessions = sessionsResult?.sessions;
      if (Array.isArray(childSessions) && childSessions.length > 0) {
        // Find the matching child session by label
        const matchingChild = childSessions.find(
          cs => cs.label === label || cs.key.includes(label),
        );

        if (matchingChild && matchingChild.key) {
          console.log(
            '[OpenClawRuntime] querySubagentSessionKey: found mapping label=' +
              label +
              ' childSessionKey=' +
              matchingChild.key,
          );
          this.labelToSessionKey.set(label, matchingChild.key);
          this.sessionKeyToLabel.set(matchingChild.key, label);
          // Set status to running since we found it
          this.subagentStatus.set(label, 'running');
        }
      }
    } catch (err) {
      console.warn('[OpenClawRuntime] querySubagentSessionKey failed:', err);
    }
  }

  /**
   * 获取子 Agent 消息历史
   */
  async getSubTaskHistory(
    parentSessionId: string,
    agentId: string,
    sessionKey?: string,
  ): Promise<Array<{ role: string; content: string }>> {
    // 确保 gateway client 已准备好（重启后可能未初始化）
    try {
      await this.ensureGatewayClientReady();
    } catch (error) {
      console.warn('[OpenClawRuntime] getSubTaskHistory: gateway client not ready:', error);
      return [];
    }

    // Strategy 1: If sessionKey is provided, use it directly
    if (sessionKey && this.gatewayClient) {
      try {
        const history = await this.gatewayClient.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey,
          limit: 100,
        });
        if (Array.isArray(history?.messages)) {
          const extracted: Array<{ role: string; content: string }> = [];
          for (const entry of extractGatewayHistoryEntries(history.messages)) {
            extracted.push({ role: entry.role, content: entry.text });
          }
          if (extracted.length > 0) return extracted;
        }
      } catch (err) {
        console.warn('[OpenClawRuntime] getSubTaskHistory: gateway query failed:', err);
      }
    }

    // Strategy 1.5: Use in-memory labelToSessionKey mapping (fastest)
    const cachedSessionKey = this.labelToSessionKey.get(agentId);
    if (cachedSessionKey && this.gatewayClient) {
      try {
        const history = await this.gatewayClient.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey: cachedSessionKey,
          limit: 100,
        });
        if (Array.isArray(history?.messages)) {
          const extracted: Array<{ role: string; content: string }> = [];
          for (const entry of extractGatewayHistoryEntries(history.messages)) {
            extracted.push({ role: entry.role, content: entry.text });
          }
          if (extracted.length > 0) return extracted;
        }
      } catch (err) {
        console.warn('[OpenClawRuntime] getSubTaskHistory: cached sessionKey query failed:', err);
      }
    }

    // Strategy 2: Find childSessionKey from CoworkStore tool_result for sessions_spawn
    const parentSession = this.store.getSession(parentSessionId);
    if (parentSession && this.gatewayClient) {
      // Find all tool_use messages for sessions_spawn
      const spawnToolUses = parentSession.messages.filter(
        m => m.type === 'tool_use' && m.metadata?.toolName === 'sessions_spawn',
      );

      for (const toolUse of spawnToolUses) {
        const toolInput = toolUse.metadata?.toolInput as Record<string, unknown> | undefined;
        const label = typeof toolInput?.label === 'string' ? toolInput.label : '';
        const inputAgentId = typeof toolInput?.agentId === 'string' ? toolInput.agentId : '';
        const toolUseId = toolUse.metadata?.toolUseId;

        // Check if this spawn matches our target agentId
        if ((label === agentId || inputAgentId === agentId) && toolUseId) {
          // Find the corresponding tool_result
          const toolResult = parentSession.messages.find(
            m => m.type === 'tool_result' && m.metadata?.toolUseId === toolUseId,
          );

          if (toolResult?.content) {
            try {
              const parsed = JSON.parse(toolResult.content);
              const childSessionKey =
                typeof parsed.childSessionKey === 'string' ? parsed.childSessionKey : null;

              if (childSessionKey) {
                // Query gateway with the childSessionKey
                const history = await this.gatewayClient.request<{ messages?: unknown[] }>(
                  'chat.history',
                  {
                    sessionKey: childSessionKey,
                    limit: 100,
                  },
                );

                if (Array.isArray(history?.messages)) {
                  const extracted: Array<{ role: string; content: string }> = [];
                  for (const entry of extractGatewayHistoryEntries(history.messages)) {
                    extracted.push({ role: entry.role, content: entry.text });
                  }
                  if (extracted.length > 0) return extracted;
                }
              }
            } catch {
              // tool_result parse failed, continue to next strategy
            }
          }
        }
      }
    }

    // Strategy 2.5: Use sessions.list API to get child sessions spawned by the parent
    if (parentSession && this.gatewayClient) {
      try {
        const parentSessionKey = this.toSessionKey(
          parentSessionId,
          parentSession.agentId || 'main',
        );

        const sessionsResult = await this.gatewayClient.request<{
          sessions?: Array<{ key: string; label?: string; spawnedBy?: string }>;
        }>('sessions.list', {
          spawnedBy: parentSessionKey,
          limit: 20,
        });

        const childSessions = sessionsResult?.sessions;
        if (Array.isArray(childSessions) && childSessions.length > 0) {
          // 建立所有子会话的 sessionKey → label 映射
          for (const cs of childSessions) {
            if (cs.key && cs.label) {
              this.sessionKeyToLabel.set(cs.key, cs.label);
              this.labelToSessionKey.set(cs.label, cs.key);
            }
          }

          // Find the matching child session by label
          const matchingChild = childSessions.find(
            cs => cs.label === agentId || cs.key.includes(agentId),
          );

          if (matchingChild?.key) {
            const history = await this.gatewayClient.request<{ messages?: unknown[] }>(
              'chat.history',
              {
                sessionKey: matchingChild.key,
                limit: 100,
              },
            );

            if (Array.isArray(history?.messages)) {
              const extracted: Array<{ role: string; content: string }> = [];
              for (const entry of extractGatewayHistoryEntries(history.messages)) {
                extracted.push({ role: entry.role, content: entry.text });
              }
              if (extracted.length > 0) return extracted;
            }
          }
        }
      } catch (err) {
        console.warn('[OpenClawRuntime] getSubTaskHistory: sessions.list failed:', err);
      }
    }

    // Strategy 3: Check in-memory subagentMessages (fallback for messages captured during streaming)
    const messages = this.subagentMessages.get(agentId);
    return messages ?? [];
  }

  /**
   * Generate a session title using the configured model via GatewayClient.
   * This reuses the Gateway's authentication mechanism, avoiding separate HTTP auth handling.
   *
   * @param userIntent The user's initial prompt/message to generate title from
   * @param timeoutMs Timeout in milliseconds (default 8000ms)
   * @returns Generated title, or fallback if generation fails
   */
  async generateTitle(userIntent: string | null, timeoutMs = 8000): Promise<string> {
    const SESSION_TITLE_MAX_CHARS = 50;
    const SESSION_TITLE_FALLBACK = 'New Session';

    const normalizedInput = typeof userIntent === 'string' ? userIntent.trim() : '';
    const fallbackTitle = this.buildFallbackTitle(
      normalizedInput,
      SESSION_TITLE_FALLBACK,
      SESSION_TITLE_MAX_CHARS,
    );

    if (!normalizedInput) {
      return fallbackTitle;
    }

    // Ensure gateway client is ready
    try {
      await this.ensureGatewayClientReady();
    } catch (error) {
      console.warn('[OpenClawRuntime] generateTitle: gateway client not ready:', error);
      return fallbackTitle;
    }

    const client = this.gatewayClient;
    if (!client) {
      console.warn('[OpenClawRuntime] generateTitle: gateway client unavailable');
      return fallbackTitle;
    }

    const prompt = `Generate a short title from this input, keep the same language, return plain text only (no markdown), and keep it within ${SESSION_TITLE_MAX_CHARS} characters: ${normalizedInput}`;

    // Use a temporary session key for title generation
    const titleSessionKey = `title:${randomUUID()}`;
    const idempotencyKey = randomUUID();

    try {
      // Use agent method with expectFinal to wait for complete response
      const result = await client.request<Record<string, unknown>>(
        'agent',
        {
          message: prompt,
          sessionKey: titleSessionKey,
          idempotencyKey,
          deliver: false,
          bootstrapContextMode: 'lightweight', // Minimal context for quick response
        },
        { expectFinal: true },
      );

      // Extract title from result
      const resultText = this.extractTitleFromAgentResult(result);
      if (resultText) {
        const normalizedTitle = this.normalizeTitle(
          resultText,
          fallbackTitle,
          SESSION_TITLE_MAX_CHARS,
        );
        // Clean up the temporary title session immediately
        try {
          await client.request('sessions.delete', {
            key: titleSessionKey,
            deleteTranscript: true,
          });
        } catch (deleteErr) {
          console.warn(
            '[OpenClawRuntime] generateTitle: failed to delete temp session:',
            deleteErr,
          );
        }
        return normalizedTitle;
      }
    } catch (error) {
      console.warn('[OpenClawRuntime] generateTitle: request failed:', error);
    }

    // Clean up temp session even on failure
    try {
      await client.request('sessions.delete', {
        key: titleSessionKey,
        deleteTranscript: true,
      });
    } catch (deleteErr) {
      // Ignore cleanup errors on failure path
    }

    return fallbackTitle;
  }

  private buildFallbackTitle(input: string, fallback: string, maxChars: number): string {
    if (!input) return fallback;
    const firstLine =
      input
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(Boolean) || '';
    return this.normalizeTitle(firstLine, fallback, maxChars);
  }

  private normalizeTitle(value: string, fallback: string, maxChars: number): string {
    let title = value.trim();

    // Strip markdown code fences
    const fenced = /```(?:[\w-]+)?\s*([\s\S]*?)```/i.exec(title);
    if (fenced?.[1]) {
      title = fenced[1].trim();
    }

    // Strip markdown formatting
    title = title
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/_([^_\n]+)_/g, '$1')
      .replace(/^#{1,6}\s+/, '')
      .trim();

    // Extract from "title: xxx" format
    const labeled = /^(?:title|标题)\s*[:：]\s*(.+)$/i.exec(title);
    if (labeled?.[1]) {
      title = labeled[1].trim();
    }

    // Strip quotes
    title = title
      .replace(/^["'`"''']+/, '')
      .replace(/["'`"''']+$/, '')
      .trim();

    if (!title) return fallback;
    if (title.length > maxChars) {
      title = title.slice(0, maxChars).trim();
    }

    return title || fallback;
  }

  private extractTitleFromAgentResult(result: unknown): string | null {
    if (!result) return null;

    // Gateway agent response format: { runId, status: 'ok', summary: 'completed', result: { payloads, meta } }
    // The 'result.payloads[].text' contains the actual agent output
    const obj = result as Record<string, unknown>;

    // Check for Gateway agent final response structure
    if (obj.status === 'ok' && obj.result !== undefined) {
      const innerResult = obj.result as Record<string, unknown>;
      // result.payloads is an array of ReplyPayload objects
      const payloads = innerResult.payloads as unknown[];
      if (Array.isArray(payloads) && payloads.length > 0) {
        // Extract text from the first payload
        const firstPayload = payloads[0] as Record<string, unknown>;
        if (typeof firstPayload?.text === 'string') {
          return firstPayload.text;
        }
      }
      // Fallback: try other fields in result
      return this.extractTitleFromAgentResult(obj.result);
    }

    // Result might be a string directly
    if (typeof result === 'string') {
      return result;
    }

    // Result might be an object with text/content
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.result === 'string') return obj.result;
    if (typeof obj.summary === 'string') return obj.summary;

    // Result might have a payloads array (direct structure)
    const payloads = obj.payloads as unknown[];
    if (Array.isArray(payloads) && payloads.length > 0) {
      const firstPayload = payloads[0] as Record<string, unknown>;
      if (typeof firstPayload?.text === 'string') {
        return firstPayload.text;
      }
    }

    // Result might have a message array
    const messages = obj.messages as unknown[];
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const msgObj = msg as Record<string, unknown>;
        if (msgObj?.role === 'assistant') {
          const content = msgObj.content;
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const blockObj = block as Record<string, unknown>;
              if (blockObj?.type === 'text' && typeof blockObj.text === 'string') {
                return blockObj.text;
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Patch the model for an active session via sessions.patch API.
   * This enables real-time model switching without restarting the session.
   */
  async patchSessionModel(
    sessionId: string,
    model: string,
    agentId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const client = this.gatewayClient;
    if (!client) {
      return { ok: false, error: 'OpenClaw gateway client not connected' };
    }

    // Get agentId from session store if not provided
    const session = this.store.getSession(sessionId);
    const effectiveAgentId = agentId || session?.agentId || 'main';

    // Build session key in the format: agent:{agentId}:gucciai:{sessionId}
    const sessionKey = `agent:${effectiveAgentId}:gucciai:${sessionId}`;

    // Normalize model reference - should be in format "provider/model-id"
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return { ok: false, error: 'Model reference is required' };
    }

    console.log(
      '[OpenClawRuntime] patchSessionModel: sessionId=%s, agentId=%s, key=%s, model=%s',
      sessionId,
      effectiveAgentId,
      sessionKey,
      normalizedModel,
    );

    try {
      const result = await client.request<{ ok?: boolean; key?: string; entry?: unknown }>(
        'sessions.patch',
        {
          key: sessionKey,
          model: normalizedModel,
        },
      );
      console.log('[OpenClawRuntime] patchSessionModel: success, result=', result);
      return { ok: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn('[OpenClawRuntime] patchSessionModel: failed:', errorMsg);
      return { ok: false, error: errorMsg };
    }
  }

  // ============================================================
  // Skill Management RPC Methods
  // ============================================================

  /**
   * Get skill status from Gateway via skills.status RPC.
   * Returns all skills visible to the gateway with eligibility info.
   */
  async getSkillsStatus(agentId?: string): Promise<import('./types').GatewaySkillStatus> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    const result = await client.request<import('./types').GatewaySkillStatus>('skills.status', {
      agentId,
    });
    console.log(
      '[OpenClawRuntime] getSkillsStatus: received',
      result.skills?.length || 0,
      'skills',
    );
    return result;
  }

  /**
   * Install a skill via skills.install RPC.
   * Supports ClawHub installs (source: 'clawhub') and Gateway installer mode.
   */
  async installSkill(
    params: import('./types').SkillInstallParams,
  ): Promise<import('./types').SkillRpcResult> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    console.log('[OpenClawRuntime] installSkill: params=', params);
    const result = await client.request<import('./types').SkillRpcResult>('skills.install', params);
    console.log('[OpenClawRuntime] installSkill: result=', result);
    return result;
  }

  /**
   * Update skill config via skills.update RPC.
   * Used to enable/disable skills or set apiKey/env config.
   */
  async updateSkillConfig(
    params: import('./types').SkillUpdateParams,
  ): Promise<import('./types').SkillRpcResult> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    console.log(
      '[OpenClawRuntime] updateSkillConfig: skillKey=',
      params.skillKey,
      'enabled=',
      params.enabled,
    );
    const result = await client.request<import('./types').SkillRpcResult>('skills.update', params);
    console.log('[OpenClawRuntime] updateSkillConfig: result=', result);
    return result;
  }

  /**
   * Search ClawHub marketplace via skills.search RPC.
   */
  async searchClawHubSkills(
    query?: string,
    limit?: number,
  ): Promise<import('./types').ClawHubSearchResult[]> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    const result = await client.request<{ results?: import('./types').ClawHubSearchResult[] }>(
      'skills.search',
      { query, limit: limit || 20 },
    );
    console.log(
      '[OpenClawRuntime] searchClawHubSkills: received',
      result.results?.length || 0,
      'results',
    );
    return result.results || [];
  }

  /**
   * Get ClawHub skill detail via skills.detail RPC.
   */
  async getClawHubSkillDetail(slug: string): Promise<import('./types').ClawHubDetail | null> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    const result = await client.request<import('./types').ClawHubDetail>('skills.detail', { slug });
    console.log('[OpenClawRuntime] getClawHubSkillDetail: slug=', slug, 'result=', result);
    return result;
  }
}
