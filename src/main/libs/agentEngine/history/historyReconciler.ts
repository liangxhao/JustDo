/**
 * History reconciliation methods extracted from OpenClawRuntimeAdapter.
 *
 * These methods synchronize local CoworkStore messages with the authoritative
 * gateway chat.history, patching tool results, tool args, usage data, and
 * system messages. All class-level dependencies are injected via callbacks.
 */

import { BrowserWindow } from 'electron';
import * as path from 'path';

import type {
  CoworkMessage,
  CoworkStore,
} from '../../../coworkStore';
import { isManagedSessionKey } from '../../openclawChannelSessionSync';
import { extractGatewayHistoryEntries } from '../../openclawHistory';
import type {
  GatewayClientLike,
  ActiveTurn,
} from '../gateway/types';
import {
  isRecord,
  sleep,
  extractMessageText,
  stripDiscordMentions,
  extractSentFilePathsFromHistory,
  extractCurrentTurnAssistantText,
  extractToolText,
  FINAL_HISTORY_SYNC_LIMIT,
} from '../utils/gatewayHelpers';

// Callback interface

export interface HistoryReconcilerCallbacks {
  // CoworkStore delegates
  getSession: CoworkStore['getSession'];
  getAgent: CoworkStore['getAgent'];
  addMessage: CoworkStore['addMessage'];
  updateMessage: CoworkStore['updateMessage'];
  deleteMessage: CoworkStore['deleteMessage'];
  replaceConversationMessages: CoworkStore['replaceConversationMessages'];

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
  resolveAssistantSegmentText: (turn: ActiveTurn, fullText: string) => string;

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

      // Determine if this is a channel session (for Discord text normalization)
      const isChannel =
        !isManagedSessionKey(sessionKey) &&
          this.callbacks.isChannelSessionKey(sessionKey);
      const isDiscord = sessionKey.includes(':discord:');

      // Extract authoritative user/assistant entries from gateway history
      const session = this.callbacks.getSession(sessionId);
      const sessionAgentId = session?.agentId || 'main';
      const sessionAgent = this.callbacks.getAgent(sessionAgentId);
      const sessionRawModel = sessionAgent?.model || '';
      const sessionModelName = sessionRawModel.includes('/')
        ? sessionRawModel.slice(sessionRawModel.indexOf('/') + 1)
        : sessionRawModel;
      const authoritativeEntries: Array<{
        role: 'user' | 'assistant';
        text: string;
        modelName?: string;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      }> = [];
      for (const message of history.messages) {
        if (!isRecord(message)) continue;
        const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
        if (role !== 'user' && role !== 'assistant') continue;
        let text = extractMessageText(message).trim();
        if (!text) continue;
        if (isDiscord) text = stripDiscordMentions(text);

        // Extract usage from gateway message (if assistant)
        const usage =
          role === 'assistant' && message.usage
            ? (message.usage as {
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
              })
            : undefined;

        authoritativeEntries.push({
          role: role as 'user' | 'assistant',
          text,
          ...(role === 'assistant' ? { modelName: sessionModelName } : {}),
          ...(usage ? { usage } : {}),
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
        this.callbacks.setChannelSyncCursor(sessionId, 0);
        return;
      }

      // Collect local user/assistant messages for comparison
      const localSession = this.callbacks.getSession(sessionId);
      const localEntries: Array<{ role: 'user' | 'assistant'; text: string }> = [];
      if (localSession) {
        for (const msg of localSession.messages) {
          if (msg.type !== 'user' && msg.type !== 'assistant') continue;
          const text = msg.content.trim();
          if (!text) continue;
          localEntries.push({ role: msg.type, text });
        }
      }

      // Compare: if already in sync, skip the expensive replace — but still
      // patch usage into assistant messages that are missing it.
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

        // Patch usage into local assistant messages that are missing it.
        // Since isInSync guarantees same order, walk both arrays in parallel.
        const localSession = this.callbacks.getSession(sessionId);
        if (localSession) {
          let patchedAny = false;
          let authAssistantIdx = 0;
          for (const msg of localSession.messages) {
            if (msg.type !== 'assistant') continue;
            // Find the next assistant entry in authoritative
            while (
              authAssistantIdx < authoritativeEntries.length &&
              authoritativeEntries[authAssistantIdx].role !== 'assistant'
            ) {
              authAssistantIdx++;
            }
            if (authAssistantIdx >= authoritativeEntries.length) break;
            const authEntry = authoritativeEntries[authAssistantIdx];
            authAssistantIdx++;

            if (authEntry.usage && !msg.usage) {
              this.callbacks.updateMessage(sessionId, msg.id, {
                usage: authEntry.usage,
              });
              patchedAny = true;
            }
          }
          if (patchedAny) {
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) {
                win.webContents.send('cowork:sessions:changed');
              }
            }
          }
        }

        this.callbacks.setChannelSyncCursor(sessionId, authoritativeEntries.length);
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
        this.callbacks.setChannelSyncCursor(sessionId, localEntries.length);
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
      this.callbacks.replaceConversationMessages(sessionId, authoritativeEntries);
      this.callbacks.setChannelSyncCursor(sessionId, authoritativeEntries.length);

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
    const usageByText = new Map<
      string,
      { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    >();
    for (const raw of historyMessages) {
      if (!isRecord(raw)) continue;
      const role = typeof raw.role === 'string' ? raw.role.trim().toLowerCase() : '';
      if (role !== 'assistant') continue;
      const text = extractMessageText(raw).trim();
      if (!text) continue;
      const usage = isRecord(raw.usage)
        ? {
            input: typeof raw.usage.input === 'number' ? raw.usage.input : undefined,
            output: typeof raw.usage.output === 'number' ? raw.usage.output : undefined,
            cacheRead: typeof raw.usage.cacheRead === 'number' ? raw.usage.cacheRead : undefined,
            cacheWrite: typeof raw.usage.cacheWrite === 'number' ? raw.usage.cacheWrite : undefined,
          }
        : undefined;
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
   * Used by getSubTaskHistory to fill missing toolInput for subagent tool_use messages.
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

  async syncFinalAssistantWithHistory(sessionId: string, turn: ActiveTurn): Promise<void> {
    console.log('[Debug:syncFinal] start — sessionId:', sessionId, 'sessionKey:', turn.sessionKey);
    const client = this.callbacks.getGatewayClient();
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
          this.callbacks.setGatewayHistoryCount(sessionId, 0);
          continue;
        }

        historyMessages = history.messages;
        const previousHistoryCountKnown = this.callbacks.hasGatewayHistoryCount(sessionId);
        const previousHistoryCount = this.callbacks.getGatewayHistoryCount(sessionId) ?? 0;
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
          !isManagedSessionKey(turn.sessionKey) &&
            this.callbacks.isChannelSessionKey(turn.sessionKey)
        );
        if (isChannel) {
          const latestOnly = this.callbacks.isReCreatedChannelSession(sessionId);
          this.callbacks.syncChannelUserMessages(
            sessionId,
            history.messages,
            latestOnly,
            turn.sessionKey.includes(':discord:'),
          );
        }

        if (!this.callbacks.isCurrentTurnToken(sessionId, turn.turnToken)) {
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
        // Patch tool_use args from history (gateway tool events don't include args)
        this.patchToolUseArgsFromHistory(sessionId, historyMessages);
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

      const canonicalSegmentText = this.callbacks.resolveAssistantSegmentText(turn, canonicalText);
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

      // Handle "NO_REPLY" special marker: clear any previously created message
      // If canonicalSegmentText is empty (filtered out "NO_REPLY"), we should
      // delete any message created during streaming that may have partial marker content
      if (!canonicalSegmentText) {
        if (turn.assistantMessageId) {
          // Delete the message created during streaming (may have "NO" partial marker)
          this.callbacks.deleteMessage(sessionId, turn.assistantMessageId);
          this.callbacks.emit('messageDelete', sessionId, turn.assistantMessageId);
          turn.assistantMessageId = null;
        }
        return;
      }

      if (!turn.assistantMessageId) {
        const reusedMessageId = this.callbacks.reuseFinalAssistantMessage(sessionId, canonicalSegmentText);
        if (reusedMessageId) {
          turn.assistantMessageId = reusedMessageId;
          return;
        }

        const assistantMessage = this.callbacks.addMessage(sessionId, {
          type: 'assistant',
          content: canonicalSegmentText,
          metadata: {
            isStreaming: false,
            isFinal: true,
          },
          modelName: turn.modelName,
        });
        turn.assistantMessageId = assistantMessage.id;
        this.callbacks.emit('message', sessionId, assistantMessage);
        return;
      }

      const session = this.callbacks.getSession(sessionId);
      const currentMessage = session?.messages.find(
        message => message.id === turn.assistantMessageId,
      );
      const currentText = currentMessage?.content.trim() ?? '';
      if (canonicalSegmentText === currentText) {
        // Content matches but renderer may not have received the last throttled update.
        // Force-emit so the UI shows the final text.
        this.callbacks.emit('messageUpdate', sessionId, turn.assistantMessageId, canonicalSegmentText);
        return;
      }

      console.debug(
        '[Debug:syncFinal] updating last segment:',
        currentText.length,
        '->',
        canonicalSegmentText.length,
      );
      this.callbacks.updateMessage(sessionId, turn.assistantMessageId, {
        content: canonicalSegmentText,
        metadata: {
          isStreaming: false,
          isFinal: true,
        },
      });
      this.callbacks.emit('messageUpdate', sessionId, turn.assistantMessageId, canonicalSegmentText);
    } catch (error) {
      console.warn('[OpenClawRuntime] chat.history sync after final failed:', error);
    }
  }
}