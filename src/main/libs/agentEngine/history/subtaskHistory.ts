import type { CoworkMessage, CoworkStore } from '../../../coworkStore';
import { buildManagedSessionKey } from '../../openclawChannelSessionSync';
import { extractGatewayHistoryEntries } from '../../openclawHistory';
import type { GatewayClientLike } from '../gateway/types';
import {
  convertEntriesToCoworkMessages,
  convertToCoworkMessages,
  isRecord,
  markSubagentContextMessage,
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

    // Resolve sessionKey from various sources
    const rawSessionKeyFromToolCallId = this.cb.toolCallIdToSessionKey.get(agentId);
    const sessionKeyFromToolCallId = rawSessionKeyFromToolCallId?.includes(':subagent:')
      ? rawSessionKeyFromToolCallId
      : null;

    // Try to resolve effective sessionKey for Gateway query
    const effectiveSessionKey = sessionKey || sessionKeyFromToolCallId;

    // Strategy 1: Query Gateway history directly (most reliable source)
    // The first user message in Gateway history IS the actual subagent context
    if (effectiveSessionKey && gatewayClient) {
      try {
        const history = await gatewayClient.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey: effectiveSessionKey,
          limit: 100,
        });
        if (Array.isArray(history?.messages) && history.messages.length > 0) {
          console.log(
            '[OpenClawRuntime] getSubTaskHistory: using Gateway history (' +
              history.messages.length +
              ' msgs) for sessionKey=' +
              effectiveSessionKey.slice(0, 30),
          );
          const entries = extractGatewayHistoryEntries(history.messages);
          if (entries.length > 0) {
            const historyMessages = convertEntriesToCoworkMessages(entries);
            this.cb.historyReconciler.patchToolInputFromHistoryRaw(historyMessages, history.messages);
            // The first user message from Gateway IS the subagent context (sent by OpenClaw)
            // Just mark it with isSubagentContext flag for UI styling
            return markSubagentContextMessage(historyMessages);
          }
        }
      } catch (err) {
        console.warn('[OpenClawRuntime] getSubTaskHistory: Gateway query failed:', err);
      }
    }

    // In-memory fallback (only when Gateway is unavailable)
    const directMessages = this.cb.subagentMessages.get(agentId);
    const mappedMessages = sessionKeyFromToolCallId
      ? this.cb.subagentMessages.get(sessionKeyFromToolCallId)
      : null;
    const inMemoryMessages =
      (directMessages && directMessages.length > 0 ? directMessages : null) ||
      (mappedMessages && mappedMessages.length > 0 ? mappedMessages : null);

    if (inMemoryMessages && inMemoryMessages.length > 0) {
      console.log(
        '[OpenClawRuntime] getSubTaskHistory: fallback to in-memory messages (' +
          inMemoryMessages.length +
          ' msgs)',
      );
      const coworkMsgs = convertToCoworkMessages(inMemoryMessages);
      return markSubagentContextMessage(coworkMsgs);
    }

    // Try additional sessionKey resolution strategies when effectiveSessionKey not available

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
