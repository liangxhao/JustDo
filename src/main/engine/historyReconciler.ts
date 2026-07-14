/**
 * History reconciliation methods extracted from OpenClawRuntimeAdapter.
 *
 * These methods refresh the local CoworkStore UI cache from authoritative
 * gateway chat.history, patching tool results, tool args, usage data, and
 * system messages. Runtime behavior must not depend on SQLite transcript state.
 * All class-level dependencies are injected via callbacks.
 */

import { BrowserWindow } from 'electron';

import type { CoworkMessage, CoworkStore } from '../data/coworkStore';
import { isManagedSessionKey } from '../openclaw/sessions/openclawChannelSessionSync';
import { extractGatewayHistoryEntries } from '../openclaw/sessions/openclawHistory';
import type { GatewayClientLike, SessionTurn } from './gateway/types';
import {
  extractMessageText,
  extractToolText,
  FINAL_HISTORY_SYNC_LIMIT,
  isRecord,
} from './gatewayHelpers';

// Callback interface

type TokenUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

const readUsageNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const extractTokenUsage = (usage: unknown): TokenUsage | undefined => {
  if (!isRecord(usage)) return undefined;
  const input =
    readUsageNumber(usage.input) ??
    readUsageNumber(usage.input_tokens) ??
    readUsageNumber(usage.prompt_tokens);
  const output =
    readUsageNumber(usage.output) ??
    readUsageNumber(usage.output_tokens) ??
    readUsageNumber(usage.completion_tokens);
  const cacheRead =
    readUsageNumber(usage.cacheRead) ??
    readUsageNumber(usage.cache_read) ??
    readUsageNumber(usage.cache_read_input_tokens);
  const cacheWrite =
    readUsageNumber(usage.cacheWrite) ??
    readUsageNumber(usage.cache_write) ??
    readUsageNumber(usage.cache_creation_input_tokens);

  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
};

export interface HistoryReconcilerCallbacks {
  // CoworkStore delegates
  getSession: CoworkStore['getSession'];
  addMessage: CoworkStore['addMessage'];
  updateMessage: CoworkStore['updateMessage'];
  deleteMessage: CoworkStore['deleteMessage'];

  // Gateway client
  getGatewayClient: () => GatewayClientLike | null;

  // History count tracking
  getGatewayHistoryCount: (sessionId: string) => number | undefined;
  setGatewayHistoryCount: (sessionId: string, count: number) => void;
  hasGatewayHistoryCount: (sessionId: string) => boolean;

  // Channel sync cursor
  setChannelSyncCursor: (sessionId: string, cursor: number) => void;

  // EventEmitter delegate
  emit: (event: string, ...args: unknown[]) => void;

  // Turn token validation
  isCurrentTurnToken: (sessionId: string, turnToken: number) => boolean;

  // Assistant text resolution
  resolveAssistantSegmentText: (turn: SessionTurn, fullText: string) => string;

  // Message reuse
  reuseFinalAssistantMessage: (sessionId: string, content: string) => string | null;

  // Channel session helpers
  isChannelSessionKey: (sessionKey: string) => boolean;
  isReCreatedChannelSession: (sessionId: string) => boolean;
  syncChannelUserMessages: (
    sessionId: string,
    historyMessages: unknown[],
    latestOnly: boolean,
    isDiscord: boolean,
  ) => void;

  // Static constants
  getFullHistorySyncLimit: () => number;
}

// Reconciler class

export class HistoryReconciler {
  constructor(private readonly callbacks: HistoryReconcilerCallbacks) {}

  syncSystemMessagesFromHistory(
    sessionId: string,
    historyMessages: unknown[],
    options: { previousCountKnown: boolean; previousCount: number },
  ): void {
    if (historyMessages.length === 0) {
      this.callbacks.setGatewayHistoryCount(sessionId, 0);
      return;
    }

    const canUseCursor =
      options.previousCountKnown &&
      options.previousCount >= 0 &&
      options.previousCount <= historyMessages.length;
    const entries = extractGatewayHistoryEntries(
      canUseCursor ? historyMessages.slice(options.previousCount) : historyMessages,
    );
    this.callbacks.setGatewayHistoryCount(sessionId, historyMessages.length);

    const systemEntries = entries.filter(entry => entry.role === 'system');
    if (systemEntries.length === 0) {
      return;
    }

    const session = this.callbacks.getSession(sessionId);
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

      const systemMessage = this.callbacks.addMessage(sessionId, {
        type: 'system',
        content: entry.text,
        metadata: {},
      });
      existingSystemTexts.add(entry.text);
      this.callbacks.emit('message', sessionId, systemMessage);
    }
  }

  /**
   * Channel history prefetch/full-sync intentionally skips historical system entries.
   * Seed the raw gateway history cursor so those older reminders are not replayed
   * under the next assistant reply during final-history sync.
   */
  markGatewayHistoryWindowConsumed(sessionId: string, historyMessages: unknown[]): void {
    if (historyMessages.length === 0) {
      return;
    }
    this.callbacks.setGatewayHistoryCount(sessionId, historyMessages.length);
  }

  /**
   * Refresh local session message cache from the authoritative gateway chat.history.
   *
   * OpenClaw is the single source of truth: this fetches enough recent
   * transcript state to patch local tool output, tool args, usage, and system
   * rows that the JustDo runtime still needs for session bookkeeping.
   *
   * It intentionally does not replace local user/assistant rows from
   * chat.history. The rendered chat surface talks to the OpenClaw Gateway
   * directly, so mirroring the conversation into SQLite creates a second,
   * potentially stale source of truth.
   *
   * The reconciliation is idempotent — calling it multiple times produces
   * the same result.
   */
  async reconcileWithHistory(
    sessionId: string,
    sessionKey: string,
    options?: { isFullSync?: boolean },
  ): Promise<void> {
    const client = this.callbacks.getGatewayClient();
    if (!client) {
      console.log('[Reconcile] no gateway client, skipping — sessionId:', sessionId);
      return;
    }

    const isManaged = isManagedSessionKey(sessionKey);
    const limit = options?.isFullSync
      ? this.callbacks.getFullHistorySyncLimit()
      : FINAL_HISTORY_SYNC_LIMIT;

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit,
      });
      if (!Array.isArray(history?.messages) || history.messages.length === 0) {
        if (!isManaged) {
          console.log('[Reconcile] empty history — sessionId:', sessionId);
          this.callbacks.setChannelSyncCursor(sessionId, 0);
        }
        return;
      }

      // Patch tool_result messages with content from history (gateway tool events
      // don't include the actual output — only the transcript does)
      this.patchToolResultsFromHistory(sessionId, history.messages);

      // Patch tool_use args from history (gateway tool events don't include args)
      this.patchToolUseArgsFromHistory(sessionId, history.messages);

      // For managed sessions, patch usage from history and return.
      // Managed sessions don't need the full message reconciliation (user/assistant
      // messages are already correct from the CoworkForwarder), but usage data
      // only exists in chat.history — so we must patch it here.
      if (isManaged) {
        this.patchUsageFromHistory(sessionId, history.messages);
        return;
      }

      // Update gateway history cursor for system message tracking
      this.callbacks.setGatewayHistoryCount(sessionId, history.messages.length);

      // Sync system messages (reminders etc.)
      const previousHistoryCountKnown = this.callbacks.hasGatewayHistoryCount(sessionId);
      const previousHistoryCount = this.callbacks.getGatewayHistoryCount(sessionId) ?? 0;
      this.syncSystemMessagesFromHistory(sessionId, history.messages, {
        previousCountKnown: previousHistoryCountKnown,
        previousCount: previousHistoryCount,
      });

      this.patchUsageFromHistory(sessionId, history.messages);
      this.callbacks.setChannelSyncCursor(sessionId, history.messages.length);
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
  patchToolResultsFromHistory(sessionId: string, historyMessages: unknown[]): void {
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

    // Patch local tool_result messages with content from history.
    // Gateway tool events often return only short meta info (e.g., "success")
    // instead of actual tool output. Always try to patch with the full output
    // from history, which contains the real stdout/stderr for Bash commands.
    const session = this.callbacks.getSession(sessionId);
    if (!session) return;

    let patchedCount = 0;
    for (const msg of session.messages) {
      if (msg.type !== 'tool_result') continue;
      const toolUseId = msg.metadata?.toolUseId as string | undefined;
      if (!toolUseId) continue;
      const result = toolResultsByCallId.get(toolUseId);
      if (!result) continue;

      // Only patch if history has meaningful content different from current.
      // Skip if current content is identical to history (avoid redundant updates).
      const currentContent = msg.content?.trim() ?? '';
      const historyContent = result.text.trim();
      if (currentContent === historyContent) continue;

      this.callbacks.updateMessage(sessionId, msg.id, {
        content: result.text,
        metadata: {
          ...msg.metadata,
          toolResult: result.text,
          isError: result.isError,
          error: result.isError ? result.text : undefined,
        },
      });
      this.callbacks.emit('messageUpdate', sessionId, msg.id, result.text);
      patchedCount++;
    }
    if (patchedCount > 0) {
      console.log('[patchToolResults] patched', patchedCount, 'messages for sessionId:', sessionId);
    }
  }

  /**
   * Extract tool_use args from chat.history messages and patch local
   * tool_use messages that have empty or missing toolInput.
   *
   * The gateway WebSocket tool event (tool=start:edit) does not include args.
   * The args live in the assistant message's toolCall content blocks in chat.history.
   */
  patchToolUseArgsFromHistory(sessionId: string, historyMessages: unknown[]): void {
    const toolArgsByCallId = new Map<string, { name: string; args: Record<string, unknown> }>();

    // Scan history for toolCall content blocks in assistant messages
    for (const raw of historyMessages) {
      if (!isRecord(raw)) continue;
      const message = raw as Record<string, unknown>;
      const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
      if (role !== 'assistant') continue;

      // Content blocks with toolCall type
      if (Array.isArray(message.content)) {
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (!isRecord(block)) continue;
          const blockType = typeof block.type === 'string' ? block.type.toLowerCase() : '';
          if (blockType !== 'toolcall' && blockType !== 'tool_call' && blockType !== 'tooluse')
            continue;
          const toolCallId =
            typeof block.toolCallId === 'string'
              ? block.toolCallId
              : typeof block.tool_call_id === 'string'
                ? block.tool_call_id
                : typeof block.id === 'string'
                  ? block.id
                  : '';
          const name = typeof block.name === 'string' ? block.name : '';
          const args = isRecord(block.arguments)
            ? (block.arguments as Record<string, unknown>)
            : isRecord(block.input)
              ? (block.input as Record<string, unknown>)
              : {};
          if (name && toolCallId) {
            toolArgsByCallId.set(toolCallId, { name, args });
          }
        }
      }
    }

    if (toolArgsByCallId.size === 0) return;

    // Patch local tool_use messages that have empty or missing toolInput
    const session = this.callbacks.getSession(sessionId);
    if (!session) return;

    let patchedCount = 0;
    for (const msg of session.messages) {
      if (msg.type !== 'tool_use') continue;
      const toolUseId = msg.metadata?.toolUseId as string | undefined;
      if (!toolUseId) continue;
      const toolInfo = toolArgsByCallId.get(toolUseId);
      if (!toolInfo) continue;

      // Check if toolInput is empty or missing essential fields
      const existingInput = msg.metadata?.toolInput as Record<string, unknown> | undefined;
      const needsPatch = !existingInput || Object.keys(existingInput).length === 0;

      if (needsPatch) {
        this.callbacks.updateMessage(sessionId, msg.id, {
          metadata: {
            ...msg.metadata,
            toolName: toolInfo.name,
            toolInput: toolInfo.args,
          },
        });
        this.callbacks.emit('messageMetadataUpdate', sessionId, msg.id, {
          toolName: toolInfo.name,
          toolInput: toolInfo.args,
        });
        patchedCount++;
      }
    }
    if (patchedCount > 0) {
      console.log(
        '[patchToolUseArgs] patched',
        patchedCount,
        'tool_use messages for sessionId:',
        sessionId,
      );
    }
  }

  /**
   * Patch usage data into local assistant messages from gateway chat.history.
   * For managed sessions, full message reconciliation is skipped, but usage
   * data (token counts) only exists in chat.history — this method extracts
   * and patches it by matching assistant messages on content text.
   */
  patchUsageFromHistory(sessionId: string, historyMessages: unknown[]): void {
    // Build a map of assistant text -> usage from gateway history
    const usageByText = new Map<string, TokenUsage>();
    for (const raw of historyMessages) {
      if (!isRecord(raw)) continue;
      const role = typeof raw.role === 'string' ? raw.role.trim().toLowerCase() : '';
      if (role !== 'assistant') continue;
      const text = extractMessageText(raw).trim();
      if (!text) continue;
      const usage = extractTokenUsage(raw.usage);
      if (usage) {
        usageByText.set(text, usage);
      }
    }

    if (usageByText.size === 0) return;

    // Patch local assistant messages missing usage
    const session = this.callbacks.getSession(sessionId);
    if (!session) return;

    let patchedAny = false;
    for (const msg of session.messages) {
      if (msg.type !== 'assistant') continue;
      if (msg.usage) continue; // already has usage
      const trimmedContent = msg.content.trim();
      if (!trimmedContent) continue;
      const usage = usageByText.get(trimmedContent);
      if (!usage) continue;

      this.callbacks.updateMessage(sessionId, msg.id, { usage });
      // Emit via messageMetadataUpdate so renderer gets real-time notification
      // (extends the metadata event to also carry usage data)
      this.callbacks.emit(
        'messageMetadataUpdate',
        sessionId,
        msg.id,
        { isStreaming: false, isFinal: true },
        { usage },
      );
      patchedAny = true;
    }

    if (patchedAny) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('cowork:sessions:changed');
        }
      }
    }
  }

  /**
   * Patch toolInput in CoworkMessage[] from raw Gateway history messages.
   * Patch missing tool input from raw Gateway history.
   */
  patchToolInputFromHistoryRaw(
    coworkMessages: CoworkMessage[],
    rawHistory: unknown[] | undefined,
  ): void {
    if (!Array.isArray(rawHistory) || coworkMessages.length === 0) return;

    const toolArgsByCallId = new Map<string, { name: string; args: Record<string, unknown> }>();

    // Scan raw history for toolCall blocks in assistant messages
    for (const raw of rawHistory) {
      if (!isRecord(raw)) continue;
      const message = raw as Record<string, unknown>;
      const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
      if (role !== 'assistant') continue;

      // Content blocks with toolCall type
      if (Array.isArray(message.content)) {
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (!isRecord(block)) continue;
          const blockType = typeof block.type === 'string' ? block.type.toLowerCase() : '';
          // Debug: log all non-text block types to understand Gateway format
          if (blockType && blockType !== 'text' && blockType !== 'thinking') {
            console.log(
              '[patchToolInputFromHistoryRaw] found block type:',
              blockType,
              'block keys:',
              Object.keys(block).slice(0, 6),
            );
          }
          if (blockType !== 'toolcall' && blockType !== 'tool_call' && blockType !== 'tooluse')
            continue;
          const toolCallId =
            typeof block.toolCallId === 'string'
              ? block.toolCallId
              : typeof block.tool_call_id === 'string'
                ? block.tool_call_id
                : typeof block.id === 'string'
                  ? block.id
                  : '';
          const name = typeof block.name === 'string' ? block.name : '';
          const args = isRecord(block.arguments)
            ? (block.arguments as Record<string, unknown>)
            : isRecord(block.input)
              ? (block.input as Record<string, unknown>)
              : {};
          if (name && toolCallId) {
            toolArgsByCallId.set(toolCallId, { name, args });
          }
        }
      }
    }

    if (toolArgsByCallId.size === 0) {
      console.log('[patchToolInputFromHistoryRaw] no toolCall blocks found in assistant messages');
      return;
    }

    // Debug: log all found toolCallIds
    console.log(
      '[patchToolInputFromHistoryRaw] found toolCallIds:',
      Array.from(toolArgsByCallId.keys()),
    );

    // Patch coworkMessages tool_use that have empty or missing toolInput
    // Also patch tool_result messages with toolInput from toolCall blocks
    let patchedToolUseCount = 0;
    let patchedToolResultCount = 0;
    for (const msg of coworkMessages) {
      // Handle tool_use messages
      if (msg.type === 'tool_use') {
        const toolUseId = msg.metadata?.toolUseId as string | undefined;
        console.log(
          '[patchToolInputFromHistoryRaw] tool_use msg toolUseId:',
          toolUseId,
          'toolName:',
          msg.metadata?.toolName,
        );
        if (!toolUseId) continue;
        const toolInfo = toolArgsByCallId.get(toolUseId);
        if (!toolInfo) {
          console.log('[patchToolInputFromHistoryRaw] no match for toolUseId:', toolUseId);
          continue;
        }

        const existingInput = msg.metadata?.toolInput as Record<string, unknown> | undefined;
        const needsPatch = !existingInput || Object.keys(existingInput).length === 0;

        if (needsPatch) {
          msg.metadata = {
            ...msg.metadata,
            toolName: toolInfo.name,
            toolInput: toolInfo.args,
          };
          patchedToolUseCount++;
        }
      }

      // Handle tool_result messages - patch toolInput and toolName into metadata
      // Gateway history only has toolResult role, tool_use info is in assistant toolCall blocks
      if (msg.type === 'tool_result') {
        const toolUseId = msg.metadata?.toolUseId as string | undefined;
        console.log(
          '[patchToolInputFromHistoryRaw] tool_result msg toolUseId:',
          toolUseId,
          'toolName:',
          msg.metadata?.toolName,
        );
        if (!toolUseId) continue;
        const toolInfo = toolArgsByCallId.get(toolUseId);
        if (!toolInfo) {
          console.log(
            '[patchToolInputFromHistoryRaw] tool_result no match for toolUseId:',
            toolUseId,
          );
          continue;
        }

        // Patch toolName and toolInput into tool_result metadata
        const existingInput = msg.metadata?.toolInput as Record<string, unknown> | undefined;
        const existingName = msg.metadata?.toolName as string | undefined;
        const needsInputPatch = !existingInput || Object.keys(existingInput).length === 0;
        const needsNamePatch = !existingName || existingName === 'Unknown Tool';

        if (needsInputPatch || needsNamePatch) {
          msg.metadata = {
            ...msg.metadata,
            toolName: needsNamePatch ? toolInfo.name : existingName,
            toolInput: needsInputPatch ? toolInfo.args : existingInput,
          };
          patchedToolResultCount++;
        }
      }
    }

    if (patchedToolUseCount > 0 || patchedToolResultCount > 0) {
      console.log(
        '[patchToolInputFromHistoryRaw] patched',
        patchedToolUseCount,
        'tool_use messages and',
        patchedToolResultCount,
        'tool_result messages',
      );
    }
  }
}
