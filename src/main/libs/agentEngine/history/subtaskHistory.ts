import type { CoworkMessage, CoworkStore } from '../../../coworkStore';
import { buildManagedSessionKey } from '../../openclawChannelSessionSync';
import { extractGatewayHistoryEntries } from '../../openclawHistory';
import type { GatewayClientLike } from '../gateway/types';
import {
  isRecord,
  convertEntriesToCoworkMessages,
  markSubagentContextMessage,
  convertToCoworkMessages,
} from '../utils/gatewayHelpers';
import type { HistoryReconciler } from './historyReconciler';

export interface SubtaskHistoryCallbacks {
  ensureGatewayClientReady: () => Promise<void>;
  getGatewayClient: () => GatewayClientLike | null;
  historyReconciler: HistoryReconciler;
  sessionKeyToLabel: Map<string, string>;
  store: CoworkStore;
  subagentMessages: Map<string, Array<{ role: string; content: string; metadata?: Record<string, unknown> }>>;
  toolCallIdToSessionKey: Map<string, string>;
  uuidToToolCallId: Map<string, string>;
}

export class SubtaskHistory {
  private readonly cb: SubtaskHistoryCallbacks;

  constructor(cb: SubtaskHistoryCallbacks) {
    this.cb = cb;
  }

  /**
   * 获取子 Agent 消息历史
   */
  async getSubTaskHistory(
    parentSessionId: string,
    agentId: string,
    sessionKey?: string,
  ): Promise<CoworkMessage[]> {
    // 确保 gateway client 已准备好（重启后可能未初始化）
    try {
      await this.cb.ensureGatewayClientReady();
    } catch (error) {
      console.warn('[OpenClawRuntime] getSubTaskHistory: gateway client not ready:', error);
      return [];
    }

    const gatewayClient = this.cb.getGatewayClient();

    // 先获取 in-memory 的 Subagent Context 消息（用于显示启动指令）
    const rawSessionKeyFromToolCallId = this.cb.toolCallIdToSessionKey.get(agentId);
    const sessionKeyFromToolCallId = rawSessionKeyFromToolCallId?.includes(':subagent:')
      ? rawSessionKeyFromToolCallId
      : null;

    const directMessages = this.cb.subagentMessages.get(agentId);
    const mappedMessages = sessionKeyFromToolCallId
      ? this.cb.subagentMessages.get(sessionKeyFromToolCallId)
      : null;

    // 获取 Subagent Context 消息（第一条 user 消息，带有 isSubagentContext 标记）
    const subagentContextMsg = (() => {
      const candidates = [directMessages, mappedMessages];
      for (const msgs of candidates) {
        if (msgs && msgs.length > 0) {
          const contextMsg = msgs.find(m => m.role === 'user' && m.metadata?.isSubagentContext);
          if (contextMsg) return contextMsg;
        }
      }
      // Fallback: try uuidToToolCallId cross-reference for nested subagents.
      const linkedToolCallId = this.cb.uuidToToolCallId.get(agentId);
      if (linkedToolCallId) {
        const linkedMsgs = this.cb.subagentMessages.get(linkedToolCallId);
        if (linkedMsgs && linkedMsgs.length > 0) {
          const contextMsg = linkedMsgs.find(
            m => m.role === 'user' && m.metadata?.isSubagentContext,
          );
          if (contextMsg) {
            console.log(
              '[OpenClawRuntime] getSubTaskHistory: found context via uuidToToolCallId agentId=' +
                agentId +
                ' -> toolCallId=' +
                linkedToolCallId,
            );
            return contextMsg;
          }
        }
      }
      return null;
    })();

    // Debug: log lookup state for subagent context
    const allMsgKeys = [...this.cb.subagentMessages.keys()];
    console.log(
      '[OpenClawRuntime] getSubTaskHistory context lookup: agentId=' +
        agentId +
        ' directMessages=' +
        (directMessages ? directMessages.length : 'null') +
        ' mappedMessages=' +
        (mappedMessages ? mappedMessages.length : 'null') +
        ' sessionKeyFromToolCallId=' +
        (sessionKeyFromToolCallId || 'null') +
        ' allSubagentMessagesKeys=[' +
        allMsgKeys.join(', ') +
        ']',
    );
    if (subagentContextMsg) {
      console.log(
        '[OpenClawRuntime] getSubTaskHistory subagentContextMsg found: content starts with "' +
          subagentContextMsg.content.slice(0, 50) +
          '"',
      );
    } else {
      console.log(
        '[OpenClawRuntime] getSubTaskHistory NO subagentContextMsg found, will use markSubagentContextMessage fallback',
      );
    }

    // Strategy 1: If sessionKey is provided, use it directly
    if (sessionKey && gatewayClient) {
      try {
        const history = await gatewayClient.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey,
          limit: 100,
        });
        if (Array.isArray(history?.messages)) {
          console.log(
            '[OpenClawRuntime] getSubTaskHistory raw messages sample:',
            history.messages
              .slice(0, 3)
              .map(m =>
                typeof m === 'object' && m
                  ? { role: (m as any).role, content_type: typeof (m as any).content }
                  : m,
              ),
          );
          const entries = extractGatewayHistoryEntries(history.messages);
          console.log(
            '[OpenClawRuntime] getSubTaskHistory extracted entries:',
            entries.map(e => ({ role: e.role, textLen: e.text?.length, hasMeta: !!e.metadata })),
          );
          if (entries.length > 0) {
            let historyMessages = convertEntriesToCoworkMessages(entries);
            this.cb.historyReconciler.patchToolInputFromHistoryRaw(historyMessages, history?.messages);
            if (subagentContextMsg) {
              const contextContent = subagentContextMsg.content;
              console.log(
                '[OpenClawRuntime] getSubTaskHistory Strategy 1: prepending context msg, startsWith "' +
                  contextContent.slice(0, 50) +
                  '"',
              );
              const firstUserIndex = historyMessages.findIndex(m => m.type === 'user');
              if (
                firstUserIndex !== -1 &&
                !historyMessages[firstUserIndex].metadata?.isSubagentContext
              ) {
                historyMessages.splice(firstUserIndex, 1);
              }
              const contextCoworkMsg: CoworkMessage = {
                id: `subagent-context-${Date.now()}`,
                type: 'user',
                content: contextContent,
                timestamp: Date.now() - 100,
                metadata: subagentContextMsg.metadata,
              };
              historyMessages.unshift(contextCoworkMsg);
            } else {
              historyMessages = markSubagentContextMessage(historyMessages);
            }
            return historyMessages;
          }
        }
      } catch (err) {
        console.warn('[OpenClawRuntime] getSubTaskHistory: gateway query failed:', err);
      }
    }

    // Strategy 0: Check in-memory subagentMessages for Subagent Context
    const inMemoryMessages =
      (directMessages && directMessages.length > 0 ? directMessages : null) ||
      (mappedMessages && mappedMessages.length > 0 ? mappedMessages : null);

    const rawToolCallIdSessionKey = this.cb.toolCallIdToSessionKey.get(agentId);
    const validToolCallIdSessionKey = rawToolCallIdSessionKey?.includes(':subagent:')
      ? rawToolCallIdSessionKey
      : null;
    const effectiveSessionKey = sessionKey || sessionKeyFromToolCallId || validToolCallIdSessionKey;

    if (effectiveSessionKey && gatewayClient) {
      try {
        const history = await gatewayClient.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey: effectiveSessionKey,
          limit: 100,
        });
        if (Array.isArray(history?.messages) && history.messages.length > 0) {
          console.log(
            '[OpenClawRuntime] getSubTaskHistory Strategy 0: using Gateway history (' +
              history.messages.length +
              ' msgs) with Subagent Context',
          );
          console.log(
            '[OpenClawRuntime] getSubTaskHistory Strategy 0 raw messages:',
            history.messages.slice(0, 5).map(m =>
              isRecord(m)
                ? {
                    role: (m as Record<string, unknown>).role,
                    hasContent: !!(m as Record<string, unknown>).content,
                    keys: Object.keys(m).slice(0, 5),
                  }
                : m,
            ),
          );
          const entries = extractGatewayHistoryEntries(history.messages);
          console.log(
            '[OpenClawRuntime] getSubTaskHistory Strategy 0 entries:',
            entries.slice(0, 3).map(e => ({ role: e.role, textLen: e.text?.length })),
          );
          if (entries.length > 0) {
            let historyMessages = convertEntriesToCoworkMessages(entries);
            this.cb.historyReconciler.patchToolInputFromHistoryRaw(historyMessages, history.messages);

            if (subagentContextMsg) {
              const contextContent = subagentContextMsg.content;
              console.log(
                '[OpenClawRuntime] getSubTaskHistory Strategy 0: prepending context msg, startsWith "' +
                  contextContent.slice(0, 50) +
                  '"',
              );
              const firstUserIndex = historyMessages.findIndex(m => m.type === 'user');
              if (
                firstUserIndex !== -1 &&
                !historyMessages[firstUserIndex].metadata?.isSubagentContext
              ) {
                historyMessages.splice(firstUserIndex, 1);
              }
              const contextCoworkMsg: CoworkMessage = {
                id: `subagent-context-${Date.now()}`,
                type: 'user',
                content: contextContent,
                timestamp: Date.now() - 100,
                metadata: subagentContextMsg.metadata,
              };
              historyMessages.unshift(contextCoworkMsg);
            } else {
              historyMessages = markSubagentContextMessage(historyMessages);
            }
            return historyMessages;
          }
        }
      } catch (err) {
        console.warn('[OpenClawRuntime] getSubTaskHistory: Gateway history query failed:', err);
      }
    }

    // Fallback: return in-memory messages if Gateway history unavailable
    if (inMemoryMessages && inMemoryMessages.length > 0) {
      console.log(
        '[OpenClawRuntime] getSubTaskHistory: fallback to in-memory messages (' +
          inMemoryMessages.length +
          ' msgs)',
      );
      const coworkMsgs = convertToCoworkMessages(inMemoryMessages);
      return coworkMsgs;
    }

    // Strategy 1.5: Use toolCallId to find sessionKey (agentId is now toolCallId)
    const rawToolCallIdSessionKey15 = this.cb.toolCallIdToSessionKey.get(agentId);
    const toolCallIdSessionKey = rawToolCallIdSessionKey15?.includes(':subagent:')
      ? rawToolCallIdSessionKey15
      : null;
    if (toolCallIdSessionKey && gatewayClient) {
      try {
        const history = await gatewayClient.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey: toolCallIdSessionKey,
          limit: 100,
        });
        console.log(
          '[OpenClawRuntime] getSubTaskHistory strategy 1.5: sessionKey=' +
            toolCallIdSessionKey +
            ' messagesLen=' +
            (history?.messages?.length ?? 0),
        );
        if (Array.isArray(history?.messages) && history.messages.length > 0) {
          const entries = extractGatewayHistoryEntries(history.messages);
          console.log(
            '[OpenClawRuntime] getSubTaskHistory strategy 1.5 entries:',
            entries.map(e => ({ role: e.role, textLen: e.text?.length })),
          );
          if (entries.length > 0) {
            const msgs = convertEntriesToCoworkMessages(entries);
            this.cb.historyReconciler.patchToolInputFromHistoryRaw(msgs, history.messages);
            return markSubagentContextMessage(msgs);
          }
        }
      } catch (err) {
        console.warn(
          '[OpenClawRuntime] getSubTaskHistory: toolCallId sessionKey query failed:',
          err,
        );
      }
    }

    // Strategy 2: Find childSessionKey from CoworkStore tool_result for sessions_spawn
    const parentSession = this.cb.store.getSession(parentSessionId);
    if (parentSession && gatewayClient) {
      const spawnToolUses = parentSession.messages.filter(
        m => m.type === 'tool_use' && m.metadata?.toolName === 'sessions_spawn',
      );

      for (const toolUse of spawnToolUses) {
        const toolInput = toolUse.metadata?.toolInput as Record<string, unknown> | undefined;
        const label = typeof toolInput?.label === 'string' ? toolInput.label : '';
        const inputAgentId = typeof toolInput?.agentId === 'string' ? toolInput.agentId : '';
        const toolUseId = toolUse.metadata?.toolUseId;

        if (toolUseId === agentId || label === agentId || inputAgentId === agentId) {
          // First try in-memory toolCallId mapping
          if (toolUseId && this.cb.toolCallIdToSessionKey.has(toolUseId)) {
            const memSessionKey = this.cb.toolCallIdToSessionKey.get(toolUseId);
            if (memSessionKey) {
              try {
                const history = await gatewayClient.request<{ messages?: unknown[] }>(
                  'chat.history',
                  { sessionKey: memSessionKey, limit: 100 },
                );
                if (Array.isArray(history?.messages)) {
                  const extracted: Array<{
                    role: string;
                    content: string;
                    metadata?: Record<string, unknown>;
                  }> = [];
                  for (const entry of extractGatewayHistoryEntries(history.messages)) {
                    extracted.push({
                      role: entry.role,
                      content: entry.text,
                      metadata: entry.metadata,
                    });
                  }
                  if (extracted.length > 0) {
                    const msgs = convertToCoworkMessages(extracted);
                    this.cb.historyReconciler.patchToolInputFromHistoryRaw(msgs, history.messages);
                    return markSubagentContextMessage(msgs);
                  }
                }
              } catch {
                // Continue to next strategy
              }
            }
          }

          // Find the corresponding tool_result
          const effectiveToolUseId = toolUseId || agentId;
          const toolResult = parentSession.messages.find(
            m => m.type === 'tool_result' && m.metadata?.toolUseId === effectiveToolUseId,
          );

          if (toolResult?.content) {
            try {
              const parsed = JSON.parse(toolResult.content);
              const childSessionKey =
                typeof parsed.childSessionKey === 'string' ? parsed.childSessionKey : null;

              if (childSessionKey) {
                const history = await gatewayClient.request<{ messages?: unknown[] }>(
                  'chat.history',
                  {
                    sessionKey: childSessionKey,
                    limit: 100,
                  },
                );

                if (Array.isArray(history?.messages)) {
                  const extracted: Array<{
                    role: string;
                    content: string;
                    metadata?: Record<string, unknown>;
                  }> = [];
                  for (const entry of extractGatewayHistoryEntries(history.messages)) {
                    extracted.push({
                      role: entry.role,
                      content: entry.text,
                      metadata: entry.metadata,
                    });
                  }
                  if (extracted.length > 0) {
                    const msgs = convertToCoworkMessages(extracted);
                    this.cb.historyReconciler.patchToolInputFromHistoryRaw(msgs, history.messages);
                    return markSubagentContextMessage(msgs);
                  }
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
    if (parentSession && gatewayClient) {
      try {
        const parentSessionKey = buildManagedSessionKey(
          parentSessionId,
          parentSession.agentId || 'main',
        );

        const sessionsResult = await gatewayClient.request<{
          sessions?: Array<{ key: string; label?: string; spawnedBy?: string }>;
        }>('sessions.list', {
          spawnedBy: parentSessionKey,
          limit: 20,
        });

        const childSessions = sessionsResult?.sessions;
        if (Array.isArray(childSessions) && childSessions.length > 0) {
          for (const cs of childSessions) {
            if (cs.key && cs.label) {
              this.cb.sessionKeyToLabel.set(cs.key, cs.label);
            }
          }

          const matchingChild = childSessions.find(
            cs => cs.label === agentId || cs.key.includes(agentId),
          );

          if (matchingChild?.key) {
            const history = await gatewayClient.request<{ messages?: unknown[] }>(
              'chat.history',
              {
                sessionKey: matchingChild.key,
                limit: 100,
              },
            );

            if (Array.isArray(history?.messages)) {
              const extracted: Array<{
                role: string;
                content: string;
                metadata?: Record<string, unknown>;
              }> = [];
              for (const entry of extractGatewayHistoryEntries(history.messages)) {
                extracted.push({
                  role: entry.role,
                  content: entry.text,
                  metadata: entry.metadata,
                });
              }
              if (extracted.length > 0) {
                const msgs = convertToCoworkMessages(extracted);
                this.cb.historyReconciler.patchToolInputFromHistoryRaw(msgs, history.messages);
                return markSubagentContextMessage(msgs);
              }
            }
          }
        }
      } catch (err) {
        console.warn('[OpenClawRuntime] getSubTaskHistory: sessions.list failed:', err);
      }
    }

    console.log('[OpenClawRuntime] getSubTaskHistory: no messages found for agentId=' + agentId);
    return [];
  }
}
