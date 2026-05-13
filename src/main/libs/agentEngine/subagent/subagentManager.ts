import type { CoworkMessageMetadata, CoworkStore } from '../../../coworkStore';
import type { GatewayClientLike, ActiveTurn } from '../gateway/types';
import { isRecord, sleep, extractMessageText } from '../utils/gatewayHelpers';

export interface SubagentManagerCallbacks {
  store: CoworkStore;
  gatewayClient: GatewayClientLike | null;
  emit: (event: string, ...args: unknown[]) => void;
  subagentStatus: Map<string, 'pending' | 'running' | 'done' | 'failed'>;
  failedSubagentIds: Set<string>;
  successfulSpawnToolCallIds: Set<string>;
  toolCallIdToSessionKey: Map<string, string>;
  sessionKeyToToolCallId: Map<string, string>;
  toolCallIdToLabel: Map<string, string>;
  toolCallIdToParentSessionId: Map<string, string>;
  toolCallArgs: Map<string, Record<string, unknown>>;
  subagentUuidToLabel: Map<string, string>;
  sessionKeyToLabel: Map<string, string>;
  uuidToToolCallId: Map<string, string>;
  pendingToolCallIds: Set<string>;
  pendingEntryTimestamps: Map<string, number>;
  subagentMessages: Map<
    string,
    Array<{ role: string; content: string; metadata?: Record<string, unknown> }>
  >;
  orchestrationSessionIds: Set<string>;
  orchestrationParentSessionId: string | null;
  activeTurns: Map<string, ActiveTurn>;
  mainAgentLifecycleEnded: boolean;
  resolveSubagentParentSessionId: (agentId: string) => string | null;
  // Sweeper-accessible collections (read-write via this)
  _announceToolMessages: Set<string>;
  _processedToolEvents: Set<string>;
  subagentThinkingByRunId: Map<string, string>;
  announceTextByRunId: Map<string, string>;
  lastAgentSeqByRunId: Map<string, number>;
  pendingAgentEventsByRunId: Map<string, unknown[]>;
  processedAnnounceRunIds: Set<string>;
}

export class SubagentManager {
  static readonly PENDING_TIMEOUT_MS = 30_000;

  private readonly cb: SubagentManagerCallbacks;

  constructor(callbacks: SubagentManagerCallbacks) {
    this.cb = callbacks;
  }

  setGatewayClient(client: GatewayClientLike | null): void {
    this.cb.gatewayClient = client;
  }

  setMainAgentLifecycleEnded(ended: boolean): void {
    this.cb.mainAgentLifecycleEnded = ended;
  }

  setOrchestrationParentSessionId(sessionId: string | null): void {
    this.cb.orchestrationParentSessionId = sessionId;
  }

  persistSubagentStatus(toolCallId: string, status: 'running' | 'done' | 'failed'): void {
    // Use per-session mapping instead of global to avoid cross-session contamination
    const parentSessionId =
      this.cb.toolCallIdToParentSessionId.get(toolCallId) || this.cb.orchestrationParentSessionId;
    if (!parentSessionId) return;
    const session = this.cb.store.getSession(parentSessionId);
    if (!session?.messages) return;

    // Find the tool_use message with matching toolUseId
    for (const msg of session.messages) {
      if (
        msg.type === 'tool_use' &&
        msg.metadata?.toolName === 'sessions_spawn' &&
        msg.metadata?.toolUseId === toolCallId
      ) {
        // Update metadata with subagentStatus (including 'failed' for restart recovery)
        const updatedMetadata = {
          ...msg.metadata,
          subagentStatus: status,
        };
        this.cb.store.updateMessage(parentSessionId, msg.id, {
          metadata: updatedMetadata as CoworkMessageMetadata,
        });
        console.log(
          '[OpenClawRuntime] persistSubagentStatus: persisted toolCallId=' +
            toolCallId +
            ' status=' +
            status +
            ' to session=' +
            parentSessionId,
        );
        break;
      }
    }
  }

  /**
   * Check if all tracked subagents for each orchestration session are 'done'.
   * Only updates session status to 'completed' when BOTH:
   * 1. All subagents are done
   * 2. The main agent itself has no pending output (no active turn / not streaming)
   * This prevents premature completion when the main agent is still processing
   * subagent results or producing follow-up output.
   */
  checkAllSubagentsDone(): void {
    // Check ALL tracked orchestration sessions (not just the most recent one)
    for (const sessionId of this.cb.orchestrationSessionIds) {
      this.checkSessionSubagentsDone(sessionId);
    }
    // Also check the legacy single-value for backward compat
    if (
      this.cb.orchestrationParentSessionId &&
      !this.cb.orchestrationSessionIds.has(this.cb.orchestrationParentSessionId)
    ) {
      this.checkSessionSubagentsDone(this.cb.orchestrationParentSessionId);
    }
  }

  private checkSessionSubagentsDone(sessionId: string): void {
    // Check in-memory subagentStatus Map - this is the authoritative source
    const hasAnyNonDone = Array.from(this.cb.subagentStatus.entries()).some(
      ([toolCallId, status]) => {
        const parentSessionId = this.cb.toolCallIdToParentSessionId.get(toolCallId);
        // Only count subagents belonging to this orchestration session
        if (parentSessionId !== sessionId) return false;
        return status !== 'done';
      },
    );

    if (!hasAnyNonDone) {
      // Verify there's at least one subagent tracked
      const hasAnySubagent = Array.from(this.cb.subagentStatus.keys()).some(
        toolCallId => this.cb.toolCallIdToParentSessionId.get(toolCallId) === sessionId,
      );

      if (hasAnySubagent) {
        // Also check that the main agent itself has no pending output.
        // If the main agent lifecycle has ended (phase=end), we trust that
        // it's done even if activeTurns hasn't been cleaned up yet (e.g., when
        // the last chat event came from a different runId and returned early).
        const mainAgentActive = this.cb.activeTurns.has(sessionId);
        if (mainAgentActive && !this.cb.mainAgentLifecycleEnded) {
          console.log(
            '[OpenClawRuntime] checkAllSubagentsDone: all subagents done but main agent still active, deferring completion: sessionId=' +
              sessionId,
          );
          return;
        }

        // NOTE: Do NOT delete activeTurns here. The main agent may have a follow-up
        // turn processing subagent results. Premature ActiveTurn deletion causes the
        // follow-up turn to lose thinking/streaming.
        // Stale ActiveTurn cleanup is handled by runTurn() when the user sends a
        // new message (it calls cleanupSessionTurn before starting a new turn).

        console.log(
          '[OpenClawRuntime] checkAllSubagentsDone: all subagents completed and main agent idle, updating session status to completed: sessionId=' +
            sessionId,
        );
        this.cb.store.updateSession(sessionId, {
          status: 'completed',
        });
        this.cb.emit('complete', sessionId, null, 'completed');
      }
    }
  }

  /**
   * Persist a nested subagent spawn event to the parent session.
   * When a subagent spawns another subagent (nested), the sessions_spawn
   * tool_use message lives in the subagent session, not the parent.
   * This method creates a synthetic entry in the parent session's messages
   * so that getSubagentStatuses can discover it after restart.
   */
  persistNestedSubagentSpawn(toolCallId: string, label: string, sessionKey: string): void {
    // Use per-session mapping instead of global to avoid cross-session contamination
    const parentSessionId =
      this.cb.toolCallIdToParentSessionId.get(toolCallId) ||
      this.findParentSessionIdForNested(toolCallId, sessionKey);
    if (!parentSessionId) return;
    const session = this.cb.store.getSession(parentSessionId);
    if (!session?.messages) return;

    // Check if already persisted (prevent duplicates)
    const alreadyExists = session.messages.some(
      msg =>
        msg.type === 'tool_use' &&
        msg.metadata?.toolName === 'sessions_spawn' &&
        msg.metadata?.toolUseId === toolCallId,
    );
    if (alreadyExists) return;

    console.log(
      '[OpenClawRuntime] persistNestedSubagentSpawn: toolCallId=' +
        toolCallId +
        ' label=' +
        label +
        ' parentSessionId=' +
        parentSessionId +
        ' sessionKey=' +
        sessionKey,
    );

    // Create a synthetic tool_use message in the parent session
    // Note: addMessage generates its own id and timestamp, so we omit those
    this.cb.store.addMessage(parentSessionId, {
      type: 'tool_use',
      content: '',
      metadata: {
        toolName: 'sessions_spawn',
        toolUseId: toolCallId,
        label,
        sessionKey,
        subagentStatus: 'running',
        isNestedSpawn: true,
        toolInput: { label, toolCallId },
      },
    });
  }

  /**
   * Update the label in a synthetic nested spawn message.
   * Called when queryNestedSubagentLabel resolves a label after the initial
   * synthetic message was created with a UUID placeholder.
   */
  updateNestedSpawnLabel(toolCallId: string, label: string): void {
    // Use per-session mapping instead of global to avoid cross-session contamination
    const parentSessionId =
      this.cb.toolCallIdToParentSessionId.get(toolCallId) || this.cb.orchestrationParentSessionId;
    if (!parentSessionId) return;
    const session = this.cb.store.getSession(parentSessionId);
    if (!session?.messages) return;

    const targetMsg = session.messages.find(
      msg =>
        msg.type === 'tool_use' &&
        msg.metadata?.toolName === 'sessions_spawn' &&
        msg.metadata?.toolUseId === toolCallId,
    );
    if (!targetMsg) return;

    console.log(
      '[OpenClawRuntime] updateNestedSpawnLabel: toolCallId=' + toolCallId + ' newLabel=' + label,
    );

    const updated = {
      ...targetMsg.metadata,
      label,
      toolInput: { ...targetMsg.metadata?.toolInput, label },
    };
    this.cb.store.updateMessage(parentSessionId, targetMsg.id, {
      metadata: updated,
    });
  }

  /**
   * 获取子 Agent 状态
   * @param sessionId 可选，指定父会话 ID 进行过滤
   * 状态来源：
   * 1. sessions.list API（重启后的权威来源，过滤 gateway pruned 的无效 spawn）
   * 2. tool_use message metadata 中的 subagentStatus（持久化状态，重启后恢复）
   * 3. 内存中的 subagentStatus（实时状态，覆盖持久化状态）
   * 4. CoworkStore 消息中的 sessions_spawn/sessions_resume/sessions_read（默认 running）
   */
  async getSubagentStatuses(sessionId?: string): Promise<{
    statuses: Record<string, 'pending' | 'running' | 'done' | 'failed'>;
    displayLabels: Record<string, string>;
  }> {
    console.log(
      '[OpenClawRuntime] getSubagentStatuses called: sessionId=' +
        (sessionId || '(none)') +
        ' orchestrationParentSessionId=' +
        (this.cb.orchestrationParentSessionId || '(none)') +
        ' subagentStatus.size=' +
        this.cb.subagentStatus.size +
        ' pendingToolCallIds.size=' +
        this.cb.pendingToolCallIds.size,
    );

    const statuses: Record<string, 'pending' | 'running' | 'done' | 'failed'> = {};
    const displayLabels: Record<string, string> = {};
    const toolUseIdToLabel = new Map<string, string>();

    // === Database recovery (highest priority) ===
    // When in-memory state is empty, first recover from database.
    // This ensures subagent status survives restart regardless of gateway state.
    if (sessionId && this.cb.subagentStatus.size === 0) {
      const dbSubagents = this.cb.store.getSubagentsByParentSession(sessionId);
      if (dbSubagents.length > 0) {
        console.log(
          '[OpenClawRuntime] getSubagentStatuses: recovered ' +
            dbSubagents.length +
            ' subagents from database for sessionId=' +
            sessionId,
        );
        for (const sub of dbSubagents) {
          statuses[sub.toolCallId] = sub.status;
          displayLabels[sub.toolCallId] = sub.label;
          // Also restore in-memory mappings for subsequent events
          this.cb.subagentStatus.set(sub.toolCallId, sub.status);
          this.cb.toolCallIdToLabel.set(sub.toolCallId, sub.label);
          this.cb.toolCallIdToParentSessionId.set(sub.toolCallId, sub.parentSessionId);
          if (sub.childSessionKey) {
            this.cb.toolCallIdToSessionKey.set(sub.toolCallId, sub.childSessionKey);
            this.cb.sessionKeyToToolCallId.set(sub.childSessionKey, sub.toolCallId);
            this.cb.sessionKeyToLabel.set(sub.childSessionKey, sub.label);
          }
          if (sub.status === 'failed') {
            this.cb.failedSubagentIds.add(sub.toolCallId);
          }
        }
        // Return immediately if all data recovered from database
        // (no need to query gateway or scan messages)
        const hasRunning = dbSubagents.some(s => s.status === 'running' || s.status === 'pending');
        if (!hasRunning) {
          console.log(
            '[OpenClawRuntime] getSubagentStatuses: all subagents recovered from database, skipping gateway query',
          );
          return { statuses, displayLabels };
        }
      }
    }

    // === Gateway discovery (fallback when database empty or has running subagents) ===
    // Post-restart recovery: when subagentStatus Map is empty (in-memory state lost),
    // query sessions.list API to discover which subagents are actually tracked by the gateway.
    // This filters out spawns that were pruned as orphans.
    // sessions.list is the authoritative source — tool_use messages are only used for
    // supplementary info (persisted status, task text).
    let gatewayChildSessions: Array<{
      key: string;
      label?: string;
      spawnedBy?: string;
      spawnedAt?: number;
      status?: string;
    }> = [];

    if (sessionId && this.cb.subagentStatus.size === 0 && this.cb.gatewayClient) {
      try {
        const parentSessionKey = `agent:main:gucciai:${sessionId}`;
        const sessionsResult = await this.cb.gatewayClient.request<{
          sessions?: Array<{
            key: string;
            label?: string;
            spawnedBy?: string;
            spawnedAt?: number;
            status?: string;
          }>;
        }>('sessions.list', {
          spawnedBy: parentSessionKey,
          limit: 200,
        });

        gatewayChildSessions = (sessionsResult?.sessions ?? []).filter(cs => cs.key);

        if (gatewayChildSessions.length > 0) {
          console.log(
            '[OpenClawRuntime] getSubagentStatuses: sessions.list found ' +
              gatewayChildSessions.length +
              ' child sessions for parentSessionKey=' +
              parentSessionKey,
            'childSessionKeys:',
            gatewayChildSessions.map(cs => cs.key),
            'childLabels:',
            gatewayChildSessions.map(cs => cs.label || '(no label)'),
          );

          // Use each gateway child session as a status entry.
          // The gateway's `status` field reflects the actual subagent state
          // (computed from endedAt/outcome) — use it as the default.
          for (const cs of gatewayChildSessions) {
            const display = cs.label || cs.key;
            const gwStatus = cs.status;
            if (gwStatus === 'done' || gwStatus === 'completed') {
              statuses[cs.key] = 'done';
            } else if (gwStatus === 'failed' || gwStatus === 'killed' || gwStatus === 'timeout') {
              statuses[cs.key] = 'failed';
            } else {
              statuses[cs.key] = 'running';
            }
            displayLabels[cs.key] = display;
          }
        }
      } catch (err) {
        console.warn(
          '[OpenClawRuntime] getSubagentStatuses: sessions.list failed, falling back to message scanning:',
          err,
        );
      }
    }

    const hasGatewayDiscovery = gatewayChildSessions.length > 0;

    // 从 CoworkStore 消息中补充状态信息
    if (sessionId) {
      const session = this.cb.store.getSession(sessionId);
      if (session?.messages) {
        console.debug(
          '[OpenClawRuntime] getSubagentStatuses: session.messages.length=' +
            session.messages.length,
        );

        if (hasGatewayDiscovery) {
          // Gateway mode: use gateway child sessions as authoritative source.
          // Match each child session to its tool_result message by session key
          // (result.childSessionKey / result.sessionKey / result.key),
          // then get the toolUseId to find the tool_use message for persisted status.
          // This avoids label-based matching entirely — labels are just display titles.
          for (const cs of gatewayChildSessions) {
            // Step 1: Find the tool_result whose result contains this child session's key
            let resultToolUseId: string | null = null;
            let resultChildSessionKey: string | null = null;

            for (const msg of session.messages) {
              if (msg.type !== 'tool_result' || msg.metadata?.toolName !== 'sessions_spawn') {
                continue;
              }
              const result = msg.metadata?.toolResult;
              if (!isRecord(result)) continue;

              const childKey =
                typeof result.childSessionKey === 'string'
                  ? result.childSessionKey
                  : typeof result.sessionKey === 'string'
                    ? result.sessionKey
                    : typeof result.key === 'string'
                      ? result.key
                      : null;

              if (childKey === cs.key) {
                resultToolUseId = msg.metadata?.toolUseId || null;
                resultChildSessionKey = childKey;
                break;
              }
            }

            if (!resultToolUseId) {
              // tool_result matching failed (e.g. childSessionKey pruned for item-level spawns).
              // Fallback 1: Check subagent_completion messages persisted in the session.
              // These messages are created by the lifecycle handler and contain the actual
              // completion status ('completed' or 'stopped').
              let matchedViaCompletion = false;
              for (const msg of session.messages) {
                if (msg.type !== 'subagent_completion') continue;
                const meta = msg.metadata;
                if (!meta) continue;

                const completionStatus = typeof meta.status === 'string' ? meta.status : '';

                // Match by sessionKey first (most reliable)
                const completionSessionKey =
                  typeof meta.sessionKey === 'string' ? meta.sessionKey : '';
                if (completionSessionKey && completionSessionKey === cs.key) {
                  if (completionStatus === 'completed' || completionStatus === 'stopped') {
                    statuses[cs.key] = 'done';
                    matchedViaCompletion = true;
                    console.log(
                      '[OpenClawRuntime] getSubagentStatuses: matched via subagent_completion cs.key=' +
                        cs.key +
                        ' status=' +
                        completionStatus,
                    );
                    break;
                  }
                }

                // Also match by toolCallId if available
                const completionToolCallId =
                  typeof meta.toolCallId === 'string' ? meta.toolCallId : '';
                if (completionToolCallId) {
                  // Check if any tool_use message with this toolCallId has a result containing cs.key
                  for (const toolMsg of session.messages) {
                    if (
                      toolMsg.type === 'tool_use' &&
                      toolMsg.metadata?.toolName === 'sessions_spawn' &&
                      toolMsg.metadata?.toolUseId === completionToolCallId
                    ) {
                      // Found the spawn — now check if there's a result containing this child
                      for (const resultMsg of session.messages) {
                        if (
                          resultMsg.type !== 'tool_result' ||
                          resultMsg.metadata?.toolName !== 'sessions_spawn'
                        )
                          continue;
                        if (resultMsg.metadata?.toolUseId !== completionToolCallId) continue;
                        const result = resultMsg.metadata?.toolResult;
                        if (!isRecord(result)) continue;
                        const rKey =
                          typeof result.childSessionKey === 'string'
                            ? result.childSessionKey
                            : typeof result.sessionKey === 'string'
                              ? result.sessionKey
                              : typeof result.key === 'string'
                                ? result.key
                                : null;
                        if (rKey === cs.key) {
                          if (completionStatus === 'completed' || completionStatus === 'stopped') {
                            statuses[cs.key] = 'done';
                            matchedViaCompletion = true;
                            console.log(
                              '[OpenClawRuntime] getSubagentStatuses: matched via subagent_completion+toolCallId cs.key=' +
                                cs.key +
                                ' toolCallId=' +
                                completionToolCallId,
                            );
                          }
                          break;
                        }
                      }
                      if (matchedViaCompletion) break;
                    }
                  }
                }
                if (matchedViaCompletion) break;
              }

              if (!matchedViaCompletion) {
                // Fallback 2: Query sessions.get from gateway to check actual child session state.
                // Completed/idle sessions indicate the subagent is done.
                let matchedViaGateway = false;
                if (this.cb.gatewayClient) {
                  try {
                    const sessionInfo = await this.cb.gatewayClient.request<{
                      state?: string;
                      status?: string;
                      active?: boolean;
                    }>('sessions.get', { sessionKey: cs.key });

                    const state = sessionInfo?.state || sessionInfo?.status || '';
                    const isActive = sessionInfo?.active;

                    // If the session is not active, not in 'running' state, or explicitly inactive,
                    // the subagent has completed.
                    if (
                      state === 'idle' ||
                      state === 'completed' ||
                      state === 'stopped' ||
                      state === 'error' ||
                      isActive === false
                    ) {
                      statuses[cs.key] = 'done';
                      matchedViaGateway = true;
                      console.log(
                        '[OpenClawRuntime] getSubagentStatuses: matched via sessions.get cs.key=' +
                          cs.key +
                          ' state=' +
                          state +
                          ' active=' +
                          isActive,
                      );
                    } else if (state === 'running' || state === 'processing' || isActive === true) {
                      // Explicitly running — keep default
                      console.log(
                        '[OpenClawRuntime] getSubagentStatuses: sessions.get confirms running cs.key=' +
                          cs.key +
                          ' state=' +
                          state,
                      );
                    }
                  } catch (err) {
                    console.warn(
                      '[OpenClawRuntime] getSubagentStatuses: sessions.get failed for cs.key=' +
                        cs.key +
                        ':',
                      err,
                    );
                  }
                }

                if (!matchedViaGateway) {
                  console.log(
                    '[OpenClawRuntime] getSubagentStatuses: NO recovery for cs.key=' +
                      cs.key +
                      ' — keeping default status: ' +
                      statuses[cs.key],
                  );
                }
              }
              continue;
            }

            // Step 2: Find the tool_use message with the same toolUseId to get persisted status
            for (const msg of session.messages) {
              if (
                msg.type === 'tool_use' &&
                msg.metadata?.toolName === 'sessions_spawn' &&
                msg.metadata?.toolUseId === resultToolUseId
              ) {
                const input = msg.metadata?.toolInput as Record<string, unknown> | undefined;
                const persistedStatus = msg.metadata?.subagentStatus as
                  | 'running'
                  | 'done'
                  | 'failed'
                  | undefined;
                const task = typeof input?.task === 'string' ? input.task : '';
                const msgLabel = typeof input?.label === 'string' && input.label ? input.label : '';

                if (
                  persistedStatus === 'running' ||
                  persistedStatus === 'done' ||
                  persistedStatus === 'failed'
                ) {
                  statuses[cs.key] = persistedStatus;
                }
                displayLabels[cs.key] = msgLabel || (task ? task.slice(0, 30) : cs.key);

                console.log(
                  '[OpenClawRuntime] getSubagentStatuses: MATCHED cs.key=' +
                    cs.key +
                    ' toolUseId=' +
                    resultToolUseId +
                    ' persistedStatus=' +
                    (persistedStatus || '(none)') +
                    ' finalStatus=' +
                    statuses[cs.key],
                );
                break;
              }
            }
          }
        } else {
          // No gateway discovery (runtime mode or API failed).
          // Fall back to original behavior: scan all sessions_spawn tool_use messages.
          for (const msg of session.messages) {
            const meta = msg.metadata;
            if (!meta) continue;

            if (msg.type === 'tool_use' && meta.toolName === 'sessions_spawn') {
              const input = meta.toolInput as Record<string, unknown> | undefined;
              const toolUseId = meta.toolUseId || '';
              const label = typeof input?.label === 'string' && input.label ? input.label : '';
              const agentId =
                typeof input?.agentId === 'string' && input.agentId ? input.agentId : '';
              const task = typeof input?.task === 'string' ? input.task : '';
              const key = toolUseId;
              const display = label || agentId || (task ? task.slice(0, 30) : toolUseId);
              console.debug(
                '[OpenClawRuntime] getSubagentStatuses: sessions_spawn toolUseId=' +
                  toolUseId +
                  ' label=' +
                  label +
                  ' display=' +
                  display,
              );
              if (key) {
                const persistedStatus = meta.subagentStatus as
                  | 'running'
                  | 'done'
                  | 'failed'
                  | undefined;
                if (
                  persistedStatus === 'running' ||
                  persistedStatus === 'done' ||
                  persistedStatus === 'failed'
                ) {
                  statuses[key] = persistedStatus;
                } else {
                  statuses[key] = 'running';
                }
                displayLabels[key] = display;
                if (label) {
                  toolUseIdToLabel.set(key, label);
                }
              }
            }
          }
        }

        // NOTE: We do NOT use tool_result to determine subagent completion status.
        // tool_result for sessions_spawn only indicates that the spawn call succeeded
        // (the subagent was successfully started), NOT that the subagent has finished running.
        // The actual subagent completion is tracked via lifecycle events (agent.stopped/agent.completed)
        // which update the subagentStatus Map.

        // Override statuses from in-memory subagentStatus Map (real-time lifecycle events)
        // subagentStatus uses toolCallId as key and is the authoritative source for subagent status.
        // Lifecycle events (agent.started -> 'running', agent.stopped/agent.completed -> 'done')
        // are the only reliable indicators of actual subagent state.

        // Helper: find lifecycle status for a message key, handling key format mismatches.
        // The sessions_spawn message uses toolUseId (e.g. 'call_xxx') as key, while
        // lifecycle events may use a different key (e.g. raw UUID). We need to bridge
        // between these formats.
        const findLifecycleStatus = (
          msgKey: string,
        ): 'pending' | 'running' | 'done' | 'failed' | null => {
          // Direct match first
          const direct = this.cb.subagentStatus.get(msgKey);
          if (direct) return direct;

          // Extract UUID-like portion from msgKey for cross-format matching
          const uuidMatch = msgKey.match(
            /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
          );
          if (!uuidMatch) return null;
          const uuid = uuidMatch[1];

          // Check if any subagentStatus key matches this UUID.
          // Only match entries that belong to the current session to prevent
          // cross-session subagent leakage.
          for (const [sk, sv] of this.cb.subagentStatus) {
            if (sk === uuid || sk.includes(uuid)) {
              // Verify session ownership
              if (sessionId) {
                const skParentId = this.cb.toolCallIdToParentSessionId.get(sk);
                if (skParentId && skParentId !== sessionId) continue;
              }
              return sv;
            }
          }

          // Check sessionKey mapping: does any subagentStatus key map to the same sessionKey?
          const msgSessionKey = this.cb.toolCallIdToSessionKey.get(msgKey);
          if (msgSessionKey) {
            const viaSessionKey = this.cb.sessionKeyToToolCallId.get(msgSessionKey);
            if (viaSessionKey && viaSessionKey !== msgKey) {
              const viaStatus = this.cb.subagentStatus.get(viaSessionKey);
              if (viaStatus) return viaStatus;
            }
          }

          // Check uuidToToolCallId reverse mapping: if msgKey is a call_xxx that was linked
          // to a UUID by the nested lifecycle handler, find the UUID that maps to it and
          // use that UUID's status. This bridges announcing spawns where lifecycle events
          // are keyed by UUID but the sessions_spawn message uses call_xxx.
          for (const [uuid, linkedCallId] of this.cb.uuidToToolCallId.entries()) {
            if (linkedCallId === msgKey) {
              const uuidStatus = this.cb.subagentStatus.get(uuid);
              if (uuidStatus) return uuidStatus;
            }
          }

          // DEBUG: log why lookup failed
          console.debug(
            '[OpenClawRuntime] findLifecycleStatus: NO MATCH for msgKey=' +
              msgKey +
              ' uuid=' +
              (uuid || '(none)') +
              ' msgSessionKey=' +
              (msgSessionKey || '(none)') +
              ' mapKeys=' +
              Array.from(this.cb.subagentStatus.keys()).join(','),
          );

          return null;
        };

        for (const toolCallId of Object.keys(statuses)) {
          const memoryStatus = findLifecycleStatus(toolCallId);
          if (memoryStatus) {
            // Memory status from lifecycle events is authoritative
            statuses[toolCallId] = memoryStatus;
          }
        }

        // Deduplicate: remove bare UUID keys from statuses AND memory maps when a call_xxx entry
        // exists for the same subagent. This handles legacy entries from previous sessions or
        // race conditions where UUID entries were created before linking completed.
        for (const [uuid, linkedCallId] of this.cb.uuidToToolCallId.entries()) {
          if (statuses[uuid] && statuses[linkedCallId]) {
            console.log(
              '[OpenClawRuntime] getSubagentStatuses: deduplicating uuid=' +
                uuid +
                ' linkedCallId=' +
                linkedCallId,
            );
            delete statuses[uuid];
            // Also clean up memory maps to prevent UUID from appearing again
            this.cb.subagentStatus.delete(uuid);
            this.cb.pendingToolCallIds.delete(uuid);
            this.cb.pendingEntryTimestamps.delete(uuid);
            this.cb.toolCallIdToSessionKey.delete(uuid);
            this.cb.toolCallIdToLabel.delete(uuid);
            this.cb.toolCallIdToParentSessionId.delete(uuid);
            console.log(
              '[OpenClawRuntime] getSubagentStatuses: cleaned up UUID memory maps for uuid=' + uuid,
            );
          }
        }

        // Also check pendingToolCallIds and direct toolCallId keys in subagentStatus
        // But only include those that belong to THIS session (prevent cross-session leakage)
        // DEBUG: Log all toolCallId mappings for debugging
        console.debug(
          '[OpenClawRuntime] getSubagentStatuses: checking subagentStatus Map, size=' +
            this.cb.subagentStatus.size +
            ' sessionId=' +
            sessionId,
        );
        const currentSessionKey = sessionId ? `agent:main:gucciai:${sessionId}` : null;
        for (const [key, status] of this.cb.subagentStatus) {
          if (!statuses[key] && (key.startsWith('call_') || key.includes('-'))) {
            // Check if this toolCallId belongs to the current session
            const toolCallSessionKey = this.cb.toolCallIdToSessionKey.get(key);
            const parentSessionId = this.cb.toolCallIdToParentSessionId.get(key);
            console.debug(
              '[OpenClawRuntime] getSubagentStatuses: toolCallId=' +
                key +
                ' status=' +
                status +
                ' toolCallSessionKey=' +
                (toolCallSessionKey || '(none)') +
                ' parentSessionId=' +
                (parentSessionId || '(none)') +
                ' currentSessionKey=' +
                (currentSessionKey || '(none)'),
            );
            // Verify session ownership using either toolCallSessionKey or parentSessionId
            // toolCallSessionKey may point to parent session temporarily, so also use parentSessionId
            const belongsToCurrentSession =
              (toolCallSessionKey &&
                (toolCallSessionKey.startsWith(currentSessionKey) ||
                  toolCallSessionKey.includes(sessionId))) ||
              (parentSessionId && parentSessionId === sessionId);
            if (currentSessionKey && !belongsToCurrentSession) {
              console.debug(
                '[OpenClawRuntime] getSubagentStatuses: SKIP toolCallId=' +
                  key +
                  ' (session mismatch: toolCallSessionKey=' +
                  (toolCallSessionKey || '(none)') +
                  ' parentSessionId=' +
                  (parentSessionId || '(none)') +
                  ' != sessionId=' +
                  sessionId,
              );
              continue;
            }
            console.debug(
              '[OpenClawRuntime] getSubagentStatuses: INCLUDE toolCallId=' +
                key +
                ' status=' +
                status,
            );
            statuses[key] = status;
            // Priority: label > task description (first 30 chars) — NEVER use UUID or other fallbacks
            // 1. Get label from toolCallIdToLabel (set by sessions_spawn tool event)
            let display = this.cb.toolCallIdToLabel.get(key);

            // 2. If key is UUID and no direct label, try linked call_xxx's label
            if (!display && /^[a-f0-9-]{36}$/i.test(key)) {
              const linkedCallId = this.cb.uuidToToolCallId.get(key);
              if (linkedCallId) {
                display = this.cb.toolCallIdToLabel.get(linkedCallId);
              }
            }

            // 3. Fallback to task description (first 30 chars) from toolCallArgs
            if (!display) {
              const spawnInfo = this.cb.toolCallArgs.get(key);
              if (spawnInfo && typeof spawnInfo.task === 'string' && spawnInfo.task) {
                display = spawnInfo.task.slice(0, 30);
              }
              // Also try linked call_xxx's task if key is UUID
              if (!display && /^[a-f0-9-]{36}$/i.test(key)) {
                const linkedCallId = this.cb.uuidToToolCallId.get(key);
                if (linkedCallId) {
                  const linkedInfo = this.cb.toolCallArgs.get(linkedCallId);
                  if (linkedInfo && typeof linkedInfo.task === 'string' && linkedInfo.task) {
                    display = linkedInfo.task.slice(0, 30);
                  }
                }
              }
            }

            // Final fallback: (no label) — NEVER use UUID or call_xxx as display
            displayLabels[key] = display || '(no label)';
          }
        }

        // NOTE: We no longer use session.completed as a fallback to mark subagents as 'done'.
        // The subagentStatus Map (real-time lifecycle events) and tool_result messages
        // are the authoritative sources for subagent completion status.
        // Removing this fallback prevents marking newly started subagents as 'done'
        // when the session status might be stale or from a previous run.
      }
    }

    // Keep failed subagents in the list with 'failed' status instead of removing them
    for (const failedId of this.cb.failedSubagentIds) {
      if (statuses[failedId]) {
        statuses[failedId] = 'failed';
      }
    }

    // Check for stuck pending subagents: if a subagent has been in pending state
    // for too long without any lifecycle events, mark it as silently failed
    // (spawn returned ok but no session was actually created)
    // IMPORTANT: We check the actual subagentStatus first. If a lifecycle event
    // has already updated the status to 'running', skip even if still in
    // pendingToolCallIds (the lifecycle handler may not have cleaned up the
    // pending set yet, or events arrived out of order).
    const now = Date.now();
    for (const pendingId of this.cb.pendingToolCallIds) {
      const currentStatus = this.cb.subagentStatus.get(pendingId);
      // Skip if lifecycle already promoted to running/done
      if (currentStatus === 'running' || currentStatus === 'done') continue;

      const entryTime = this.cb.pendingEntryTimestamps.get(pendingId);
      if (entryTime && now - entryTime > SubagentManager.PENDING_TIMEOUT_MS) {
        // Only mark as failed if it belongs to current session
        if (sessionId) {
          const parentSessionId = this.cb.toolCallIdToParentSessionId.get(pendingId);
          if (parentSessionId && parentSessionId !== sessionId) continue;
        }
        console.log(
          '[OpenClawRuntime] getSubagentStatuses: pending subagent timed out after ' +
            Math.round((now - entryTime) / 1000) +
            's, marking as failed: toolCallId=' +
            pendingId,
        );
        this.cb.failedSubagentIds.add(pendingId);
        this.cb.subagentStatus.set(pendingId, 'failed');
        // Persist to database for restart recovery
        const parentSessionId = this.cb.toolCallIdToParentSessionId.get(pendingId);
        const label = this.cb.toolCallIdToLabel.get(pendingId) || '(unknown)';
        if (parentSessionId) {
          // Try to get specific error reason from gateway
          let errorReason: string | null = null;
          const childSessionKey = this.cb.toolCallIdToSessionKey.get(pendingId);
          if (childSessionKey && this.cb.gatewayClient) {
            try {
              const sessionInfo = await this.cb.gatewayClient.request<{
                state?: string;
                status?: string;
                outcome?: string;
                error?: string;
                lastError?: string;
              }>('sessions.get', { sessionKey: childSessionKey });

              if (sessionInfo) {
                // Same logic as SubTaskDetailDrawer error display:
                // priority: errorMessage > outcome > state
                const errorMessage = sessionInfo.error || sessionInfo.lastError;
                if (errorMessage) {
                  errorReason = errorMessage;
                } else if (sessionInfo.outcome) {
                  errorReason = `Outcome: ${sessionInfo.outcome.toUpperCase()}`;
                } else if (sessionInfo.state) {
                  errorReason = `State: ${sessionInfo.state.toUpperCase()}`;
                }
              }
            } catch {
              // Gateway query failed, fall through to default
            }
          }
          if (!errorReason) {
            errorReason = 'Spawn timeout - no lifecycle event received';
          }
          this.cb.store.upsertSubagent(pendingId, parentSessionId, label, 'failed', {
            errorReason,
          });
        }
        this.cb.pendingEntryTimestamps.delete(pendingId);
      }
    }
    // Clean up expired entries from failedSubagentIds
    for (const failedId of this.cb.failedSubagentIds) {
      this.cb.pendingToolCallIds.delete(failedId);
      this.cb.pendingEntryTimestamps.delete(failedId);
    }

    // Orphan detection: ensure all toolCallIds belonging to this session are represented
    // This bridges the gap between path A (CoworkStore messages) and path B (subagentStatus Map)
    if (sessionId) {
      for (const [toolCallId, parentSessionId] of this.cb.toolCallIdToParentSessionId) {
        if (parentSessionId !== sessionId) continue;
        if (statuses[toolCallId]) continue;
        if (this.cb.failedSubagentIds.has(toolCallId)) {
          statuses[toolCallId] = 'failed';
          const spawnInfo = this.cb.toolCallArgs.get(toolCallId);
          displayLabels[toolCallId] =
            this.cb.toolCallIdToLabel.get(toolCallId) ||
            (spawnInfo && typeof spawnInfo.task === 'string' ? spawnInfo.task.slice(0, 30) : '') ||
            toolCallId;
          continue;
        }
        const memoryStatus = this.cb.subagentStatus.get(toolCallId);
        if (memoryStatus) {
          statuses[toolCallId] = memoryStatus;
        } else {
          statuses[toolCallId] = 'pending';
        }
        const spawnInfo = this.cb.toolCallArgs.get(toolCallId);
        displayLabels[toolCallId] =
          this.cb.toolCallIdToLabel.get(toolCallId) ||
          (spawnInfo && typeof spawnInfo.task === 'string' ? spawnInfo.task.slice(0, 30) : '') ||
          toolCallId;
        console.debug(
          '[OpenClawRuntime] getSubagentStatuses: orphan recovery toolCallId=' +
            toolCallId +
            ' status=' +
            statuses[toolCallId] +
            ' label=' +
            displayLabels[toolCallId],
        );
      }

      // Also scan subagentStatus for UUID-keyed entries (announcing subagent spawn children)
      // These are tracked by UUID rather than call_xxx, so toolCallIdToParentSessionId won't have them
      for (const [key, status] of this.cb.subagentStatus) {
        if (statuses[key]) continue; // Already covered
        if (this.cb.failedSubagentIds.has(key)) continue; // Already marked failed
        // UUID format: not starting with 'call_' and matching UUID pattern
        const isUuid = /^[a-f0-9-]{36}$/i.test(key);
        if (!isUuid) continue;

        // Check if there's a corresponding lifecycle entry
        const childSessionKey = 'agent:main:subagent:' + key;
        const hasLifecycleEntry = this.cb.sessionKeyToToolCallId.has(childSessionKey);
        const hasSessionKey = this.cb.toolCallIdToSessionKey.has(key);

        if (!hasLifecycleEntry && !hasSessionKey) {
          // No session mapping at all — potential orphan
          // Check if main session is still active
          const mainSession = this.cb.store.getSession(sessionId);
          const sessionDone = mainSession?.status === 'completed' || mainSession?.status === 'idle';

          if (sessionDone && (status === 'running' || status === 'pending')) {
            console.log(
              '[OpenClawRuntime] getSubagentStatuses: orphan UUID key=' +
                key +
                ' status=' +
                status +
                ' — main session done, marking as failed',
            );
            statuses[key] = 'failed';
            this.cb.subagentStatus.set(key, 'failed');
            this.cb.failedSubagentIds.add(key);
            // Persist to database for restart recovery
            const label = this.cb.subagentUuidToLabel.get(key) || key;
            this.cb.store.upsertSubagent(key, sessionId, label, 'failed', {
              errorReason: 'Orphan subagent - main session completed',
            });
          } else if (sessionDone) {
            // Already done/failed status but main session completed — reflect it
            statuses[key] = status;
            const label = this.cb.subagentUuidToLabel.get(key);
            displayLabels[key] = label || key;
          }
        }
      }
    }

    // Add pending subagents (in pendingToolCallIds but not yet mapped to sessionKey)
    // These are subagents that have been spawned but are waiting for execution
    for (const pendingId of this.cb.pendingToolCallIds) {
      // Skip if already in statuses (has been mapped or has lifecycle events)
      if (statuses[pendingId]) continue;
      // Skip if failed
      if (this.cb.failedSubagentIds.has(pendingId)) continue;
      // Check if belongs to current session
      if (sessionId) {
        const parentSessionId = this.cb.toolCallIdToParentSessionId.get(pendingId);
        if (parentSessionId && parentSessionId !== sessionId) continue;
      }
      // Mark as pending (queued, waiting for execution)
      statuses[pendingId] = 'pending';
      // Get display label
      const spawnInfo = this.cb.toolCallArgs.get(pendingId);
      const label =
        this.cb.toolCallIdToLabel.get(pendingId) ||
        this.cb.subagentUuidToLabel.get(pendingId) ||
        (spawnInfo && typeof spawnInfo.task === 'string' ? spawnInfo.task.slice(0, 30) : '');
      displayLabels[pendingId] = label || pendingId;
      console.debug(
        '[OpenClawRuntime] getSubagentStatuses: pending subagent toolCallId=' +
          pendingId +
          ' label=' +
          (label || '(none)'),
      );
    }

    // Build status detail for debug logging (show what each key resolves to)
    const statusDetail = Object.entries(statuses)
      .map(([k, v]) => k + '=' + v)
      .join(', ');
    const mapDetail = Array.from(this.cb.subagentStatus.entries())
      .map(([k, v]) => k + '=' + v)
      .join(', ');
    console.log(
      '[OpenClawRuntime] getSubagentStatuses: returning count=' +
        Object.keys(statuses).length +
        ' failedSubagentIds=' +
        Array.from(this.cb.failedSubagentIds).join(',') +
        ' pendingToolCallIds=' +
        Array.from(this.cb.pendingToolCallIds).join(',') +
        ' keys=' +
        Object.keys(statuses).join(',') +
        ' statusValues={' +
        statusDetail +
        '} subagentStatusMap={' +
        mapDetail +
        '}',
    );
    return { statuses, displayLabels };
  }

  /**
   * Find the correct parent GUI session ID for a nested subagent.
   * Searches per-session mappings instead of using the global orchestrationParentSessionId,
   * which can be contaminated by concurrent sessions.
   */
  findParentSessionIdForNested(emitAgentId: string, sessionKey?: string): string | null {
    // Try 1: Check if any top-level subagent's sessionKey contains this nested subagent
    // Nested subagents are children of top-level subagents, so their parent GUI session
    // is the same as the spawning subagent's parent.
    for (const [tcId, parentSessId] of this.cb.toolCallIdToParentSessionId) {
      const childKey = this.cb.toolCallIdToSessionKey.get(tcId);
      if (childKey && childKey.includes(':subagent:')) {
        // This is a top-level subagent — check if the nested subagent's sessionKey
        // shares the same parent context
        if (sessionKey && childKey && sessionKey.includes(childKey.split(':subagent:')[0])) {
          return parentSessId;
        }
      }
    }

    // Try 2: Check if the sessionKey itself encodes a gucciai parent
    if (sessionKey) {
      const gucciaiMatch = sessionKey.match(/^agent:main:gucciai:([^:]+)/);
      if (gucciaiMatch) {
        return gucciaiMatch[1];
      }
    }

    // Try 3: Check if any running subagent's sessionKey matches our nested subagent's context
    for (const [sk, tcId] of this.cb.sessionKeyToToolCallId) {
      if (sk.includes(':subagent:') && sk.includes(emitAgentId)) {
        const parentId = this.cb.toolCallIdToParentSessionId.get(tcId);
        if (parentId) return parentId;
      }
    }

    // Fallback: use global (only if no per-session info found)
    return this.cb.orchestrationParentSessionId;
  }

  /**
   * Query sessions.list to find subagent sessionKey and establish mapping.
   * Called when gateway tool event doesn't contain childSessionKey directly.
   * NOTE: Only use label for matching, no fallback to avoid mapping confusion.
   */
  async querySubagentSessionKey(
    label: string,
    parentSessionKey: string,
    toolCallId?: string,
  ): Promise<void> {
    if (!this.cb.gatewayClient) return;

    try {
      const sessionsResult = await this.cb.gatewayClient.request<{
        sessions?: Array<{ key: string; label?: string; spawnedBy?: string; spawnedAt?: number }>;
      }>('sessions.list', {
        spawnedBy: parentSessionKey,
        limit: 20,
      });

      const childSessions = sessionsResult?.sessions;
      if (Array.isArray(childSessions) && childSessions.length > 0) {
        console.log(
          '[OpenClawRuntime] querySubagentSessionKey: found ' +
            childSessions.length +
            ' child sessions for parentSessionKey=' +
            parentSessionKey,
          'childSessionKeys:',
          childSessions.map(cs => cs.key),
          'childLabels:',
          childSessions.map(cs => cs.label || '(no label)'),
        );

        // Find the matching child session by label ONLY - no fallback to avoid confusion
        const matchingChild = childSessions.find(
          cs => cs.label === label || cs.key.includes(label),
        );

        if (matchingChild && matchingChild.key) {
          const childSessionKey = matchingChild.key;
          console.log(
            '[OpenClawRuntime] querySubagentSessionKey: found mapping label=' +
              label +
              ' childSessionKey=' +
              childSessionKey +
              ' toolCallId=' +
              (toolCallId || '(none)'),
          );
          this.cb.sessionKeyToLabel.set(childSessionKey, label);
          // Also extract UUID and store for lifecycle event lookup
          const uuidMatch = childSessionKey.match(/subagent[:\-]([a-f0-9-]{36})$/i);
          if (uuidMatch && uuidMatch[1]) {
            this.cb.subagentUuidToLabel.set(uuidMatch[1], label);
          }
          // Also establish toolCallId mappings if toolCallId is provided
          if (toolCallId) {
            this.cb.toolCallIdToSessionKey.set(toolCallId, childSessionKey);
            this.cb.sessionKeyToToolCallId.set(childSessionKey, toolCallId);
            this.cb.toolCallIdToLabel.set(toolCallId, label);
          }
          // Set status to running since we found it
          // IMPORTANT: Only use toolCallId as key, NOT label!
          // label is for display only, toolCallId is the unique identifier
          if (toolCallId) {
            // Never overwrite 'done' — a completed subagent stays completed
            const existingStatus = this.cb.subagentStatus.get(toolCallId);
            if (existingStatus !== 'done') {
              this.cb.subagentStatus.set(toolCallId, 'running');
            }
          }

          // Update tool_result message content if it was created empty
          // (announce path sessions_spawn doesn't get result from gateway)
          if (toolCallId) {
            const parentSessionId = this.cb.toolCallIdToParentSessionId.get(toolCallId);
            if (parentSessionId) {
              const turn = this.cb.activeTurns.get(parentSessionId);
              if (turn) {
                const resultMessageId = turn.toolResultMessageIdByToolCallId.get(toolCallId);
                if (resultMessageId) {
                  const newContent = `Subagent spawned successfully.\nSession Key: ${childSessionKey}`;
                  this.cb.store.updateMessage(parentSessionId, resultMessageId, {
                    content: newContent,
                    metadata: {
                      toolResult: newContent,
                      toolUseId: toolCallId,
                      toolName: 'sessions_spawn',
                      toolInput: { label, task: '(from announce path)' },
                      isError: false,
                      isStreaming: false,
                      isFinal: true,
                    },
                  });
                  this.cb.emit('messageUpdate', parentSessionId, resultMessageId, newContent);
                  console.log(
                    '[OpenClawRuntime] querySubagentSessionKey: updated tool_result message for toolCallId=' +
                      toolCallId +
                      ' with childSessionKey=' +
                      childSessionKey,
                  );
                }
              }
            }
          }
        } else {
          console.log(
            '[OpenClawRuntime] querySubagentSessionKey: no matching child session found',
            'label=' + label,
            'toolCallId=' + (toolCallId || '(none)'),
          );
          // No matching child session found at this moment
          // This could be a timing issue - the child session may not have been created yet
          // DO NOT mark as failed immediately - keep in pendingToolCallIds
          // Lifecycle events will eventually establish the mapping or confirm failure
          // If lifecycle events never arrive, the subagent will remain 'pending' in status
          if (toolCallId) {
            console.log(
              '[OpenClawRuntime] querySubagentSessionKey: keeping toolCallId=' +
                toolCallId +
                ' in pendingToolCallIds, waiting for lifecycle events',
            );
            // Keep toolCallId in pendingToolCallIds - will be resolved by lifecycle events
            // or shown as 'pending' in UI if lifecycle events never arrive
          }
        }
      }
    } catch (err) {
      console.warn('[OpenClawRuntime] querySubagentSessionKey failed:', err);
    }
  }

  /**
   * Sync with gateway history to resolve a possible truncated NO_REPLY marker
   * in a subagent's assistant stream. Queries chat.history, checks if the final
   * text is "NO_REPLY", and only creates a message if there's real content.
   */
  async syncSubagentNoReply(
    storageKey: string,
    emitAgentId: string,
    sessionKey: string,
    msgs: Array<{ role: string; content: string }>,
    partialText: string,
  ): Promise<void> {
    if (!this.cb.gatewayClient) return;

    try {
      const history = await this.cb.gatewayClient.request<{ messages?: unknown[] }>(
        'chat.history',
        {
          sessionKey,
          limit: 10,
        },
      );

      const historyMessages = history?.messages;
      if (!Array.isArray(historyMessages) || historyMessages.length === 0) {
        return;
      }

      // Find the last assistant message from history
      for (let i = historyMessages.length - 1; i >= 0; i--) {
        const msg = historyMessages[i];
        if (!isRecord(msg)) continue;
        const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
        if (role !== 'assistant') continue;

        const text = extractMessageText(msg).trim();
        if (!text) continue;

        // Check if this is a NO_REPLY marker
        if (/^NO_REPLY$/i.test(text)) {
          console.log(
            '[OpenClawRuntime] syncSubagentNoReply: confirmed NO_REPLY for agentId=' +
              emitAgentId +
              ', skipping',
          );
          return;
        }

        // Real content found - create the message
        console.log(
          '[OpenClawRuntime] syncSubagentNoReply: found real content for agentId=' +
            emitAgentId +
            ', text="' +
            text.slice(0, 100) +
            '"',
        );
        const newMsg = { role: 'assistant', content: text };
        msgs.push(newMsg);
        const syncParentSessionId = this.cb.resolveSubagentParentSessionId(emitAgentId);
        if (syncParentSessionId) {
          this.cb.emit('subagentMessage', syncParentSessionId, emitAgentId, {
            id: `subagent-assistant-synced-${Date.now()}`,
            type: 'assistant',
            content: text,
            timestamp: Date.now(),
          });
        }
        return;
      }
    } catch (err) {
      console.warn('[OpenClawRuntime] syncSubagentNoReply failed:', err);
    }
  }

  /**
   * Retry wrapper for querying subagent chat.history.
   * Retries up to `retries` times with `delayMs` between attempts.
   * Returns the last result even if all attempts yield empty messages.
   */
  private async querySubagentHistoryWithRetry(
    sessionKey: string,
    retries: number,
    delayMs: number,
  ): Promise<{ messages?: unknown[] }> {
    if (!this.cb.gatewayClient) return {};

    let result: { messages?: unknown[] } = {};
    for (let i = 0; i <= retries; i++) {
      try {
        result = await this.cb.gatewayClient.request('chat.history', {
          sessionKey,
          limit: 10,
        });
        const msgs = result?.messages;
        if (Array.isArray(msgs) && msgs.length > 0) {
          return result;
        }
      } catch {
        // Transient error — retry again
      }
      if (i < retries) {
        await sleep(delayMs);
      }
    }
    return result;
  }

  /**
   * Query subagent chat.history to resolve a possible truncated NO_REPLY marker
   * in a different-runId final event. Retries once to handle slow history flush.
   * Only adds a message to the parent session if history confirms real content
   * (not NO_REPLY). Falls back to showing partialText as-is if history remains
   * empty after retry — better to show "NO" than to lose real content.
   */
  async syncFinalNoReplyWithHistory(
    parentSessionId: string,
    subagentSessionKey: string,
    partialText: string,
    modelName?: string,
  ): Promise<void> {
    if (!this.cb.gatewayClient) return;

    try {
      const history = await this.querySubagentHistoryWithRetry(
        subagentSessionKey,
        1, // one retry
        1000, // 1s between attempts
      );

      const historyMessages = history?.messages;
      if (!Array.isArray(historyMessages) || historyMessages.length === 0) {
        // History still empty after retry — fall back to showing text as-is.
        // This avoids losing legitimate short replies like "NO" when the
        // model response hasn't flushed yet.
        // But if subagent streaming already captured content, skip to avoid duplicate.
        const storageKey = subagentSessionKey;
        const msgs = this.cb.subagentMessages.get(storageKey);
        const streamedAssistant = msgs?.filter(m => m.role === 'assistant').pop();
        if (
          streamedAssistant &&
          streamedAssistant.content &&
          streamedAssistant.content.length > 0
        ) {
          console.log(
            '[OpenClawRuntime] syncFinalNoReplyWithHistory: history empty but subagent already has streamed content for sessionKey=' +
              subagentSessionKey +
              ', skipping (avoids duplicate)',
          );
          return;
        }
        console.log(
          '[OpenClawRuntime] syncFinalNoReplyWithHistory: history empty after retry for sessionKey=' +
            subagentSessionKey +
            ', showing text as-is',
        );
        const assistantMessage = this.cb.store.addMessage(parentSessionId, {
          type: 'assistant',
          content: partialText,
          metadata: { isStreaming: false, isFinal: true },
          modelName,
        });
        this.cb.emit('message', parentSessionId, assistantMessage);
        return;
      }

      // Find the last assistant message from history
      for (let i = historyMessages.length - 1; i >= 0; i--) {
        const msg = historyMessages[i];
        if (!isRecord(msg)) continue;
        const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
        if (role !== 'assistant') continue;

        const text = extractMessageText(msg).trim();
        if (!text) continue;

        // Check if this is a NO_REPLY marker
        if (/^NO_REPLY$/i.test(text)) {
          console.log(
            '[OpenClawRuntime] syncFinalNoReplyWithHistory: confirmed NO_REPLY for sessionKey=' +
              subagentSessionKey +
              ', skipping',
          );
          return;
        }

        // Real content found - add to parent session ONLY if subagent streaming
        // did not already capture it. Otherwise we get duplicate display:
        // the subagent_completion message AND this regular assistant message.
        const storageKey = subagentSessionKey;
        const msgs = this.cb.subagentMessages.get(storageKey);
        const streamedAssistant = msgs?.filter(m => m.role === 'assistant').pop();
        if (
          streamedAssistant &&
          streamedAssistant.content &&
          streamedAssistant.content.length > 0
        ) {
          console.log(
            '[OpenClawRuntime] syncFinalNoReplyWithHistory: subagent already has streamed content for sessionKey=' +
              subagentSessionKey +
              ', skipping (avoids duplicate)',
          );
          return;
        }

        console.log(
          '[OpenClawRuntime] syncFinalNoReplyWithHistory: found real content for sessionKey=' +
            subagentSessionKey +
            ', text="' +
            text.slice(0, 100) +
            '"',
        );
        const assistantMessage = this.cb.store.addMessage(parentSessionId, {
          type: 'assistant',
          content: text,
          metadata: { isStreaming: false, isFinal: true },
          modelName,
        });
        this.cb.emit('message', parentSessionId, assistantMessage);
        return;
      }
    } catch (err) {
      console.warn('[OpenClawRuntime] syncFinalNoReplyWithHistory failed:', err);
    }
  }

  /**
   * Query sessions.list to find the label for a nested subagent identified by UUID.
   * Used when lifecycle START event fires before the tool event provides label info.
   */
  async queryNestedSubagentLabel(
    subagentUuid: string,
    parentSessionKey: string,
    toolCallId?: string,
  ): Promise<void> {
    if (!this.cb.gatewayClient) return;

    try {
      const sessionsResult = await this.cb.gatewayClient.request<{
        sessions?: Array<{ key: string; label?: string; spawnedBy?: string; spawnedAt?: number }>;
      }>('sessions.list', {
        spawnedBy: parentSessionKey,
        limit: 50,
      });

      const childSessions = sessionsResult?.sessions;
      if (Array.isArray(childSessions) && childSessions.length > 0) {
        // Find the child session whose key contains our UUID
        const matchingChild = childSessions.find(
          cs => cs.key.includes(subagentUuid) || cs.key.endsWith(subagentUuid),
        );

        if (matchingChild && matchingChild.label) {
          const label = matchingChild.label;
          console.log(
            '[OpenClawRuntime] queryNestedSubagentLabel: resolved UUID=' +
              subagentUuid +
              ' -> label=' +
              label,
          );
          this.cb.subagentUuidToLabel.set(subagentUuid, label);
          // Also add UUID to successfulSpawnToolCallIds so the lifecycle
          // error handler can find it (lifecycle events use UUID as toolCallId).
          this.cb.successfulSpawnToolCallIds.add(subagentUuid);
          if (toolCallId) {
            this.cb.toolCallIdToLabel.set(toolCallId, label);
            // Also update the synthetic tool_use message label in the parent session
            this.updateNestedSpawnLabel(toolCallId, label);
          }
        }
      }
    } catch (err) {
      console.warn('[OpenClawRuntime] queryNestedSubagentLabel failed:', err);
    }
  }

  /**
   * Find toolCallId by childSessionKey from parent session's sessions_spawn results.
   * Used when mapping isn't established yet (race condition between subagent events and spawn result).
   */
  findToolCallIdByChildSessionKey(childSessionKey: string): string | null {
    // Search across all orchestration sessions instead of using the global
    // to avoid cross-session contamination when multiple GUI sessions are concurrent
    for (const parentSessionId of this.cb.orchestrationSessionIds) {
      const parentSession = this.cb.store.getSession(parentSessionId);
      if (!parentSession?.messages) continue;

      // Find sessions_spawn tool_result messages that contain this childSessionKey
      for (const msg of parentSession.messages) {
        if (msg.type === 'tool_result' && msg.metadata?.toolName === 'sessions_spawn') {
          const toolUseId = msg.metadata?.toolUseId;
          const result = msg.metadata?.toolResult;
          if (
            toolUseId &&
            isRecord(result) &&
            (result.childSessionKey === childSessionKey ||
              result.sessionKey === childSessionKey ||
              result.key === childSessionKey)
          ) {
            // Found matching result - establish mapping and return
            this.cb.toolCallIdToSessionKey.set(toolUseId, childSessionKey);
            this.cb.sessionKeyToToolCallId.set(childSessionKey, toolUseId);
            return toolUseId;
          }
        }
      }
    }

    return null;
  }

  /**
   * Find childSessionKey by toolCallId from parent session's sessions_spawn results.
   * This is the preferred method when gateway tool event doesn't include childSessionKey.
   * Uses toolCallId as unique identifier instead of unreliable label matching.
   */
  findChildSessionKeyByToolCallId(toolCallId: string): string | null {
    // Search across all orchestration sessions instead of using the global
    // to avoid cross-session contamination when multiple GUI sessions are concurrent
    for (const parentSessionId of this.cb.orchestrationSessionIds) {
      const parentSession = this.cb.store.getSession(parentSessionId);
      if (!parentSession?.messages) continue;

      // Find sessions_spawn tool_result messages that match this toolCallId
      for (const msg of parentSession.messages) {
        if (
          msg.type === 'tool_result' &&
          msg.metadata?.toolName === 'sessions_spawn' &&
          msg.metadata?.toolUseId === toolCallId
        ) {
          // Parse result to find childSessionKey
          const result = msg.metadata?.toolResult;
          if (isRecord(result)) {
            const childSessionKey =
              typeof result.childSessionKey === 'string'
                ? result.childSessionKey
                : typeof result.sessionKey === 'string'
                  ? result.sessionKey
                  : typeof result.key === 'string'
                    ? result.key
                    : null;
            if (childSessionKey) {
              // Found matching result - establish mapping and return
              this.cb.toolCallIdToSessionKey.set(toolCallId, childSessionKey);
              this.cb.sessionKeyToToolCallId.set(childSessionKey, toolCallId);
              console.log(
                '[OpenClawRuntime] findChildSessionKeyByToolCallId: found mapping toolCallId=' +
                  toolCallId +
                  ' childSessionKey=' +
                  childSessionKey,
              );
              return childSessionKey;
            }
          }
          // Also try parsing content as JSON (legacy format)
          if (typeof msg.content === 'string') {
            try {
              const parsed = JSON.parse(msg.content);
              const childSessionKey =
                typeof parsed.childSessionKey === 'string'
                  ? parsed.childSessionKey
                  : typeof parsed.sessionKey === 'string'
                    ? parsed.sessionKey
                    : null;
              if (childSessionKey) {
                this.cb.toolCallIdToSessionKey.set(toolCallId, childSessionKey);
                this.cb.sessionKeyToToolCallId.set(childSessionKey, toolCallId);
                console.log(
                  '[OpenClawRuntime] findChildSessionKeyByToolCallId: found mapping from content toolCallId=' +
                    toolCallId +
                    ' childSessionKey=' +
                    childSessionKey,
                );
                return childSessionKey;
              }
            } catch {
              // Content not JSON, ignore
            }
          }
        }
      }
    }

    return null;
  }

  // --- Sweeper ---

  private sweeperIntervalId: ReturnType<typeof setInterval> | null = null;

  startSweeper(): void {
    if (this.sweeperIntervalId) return;
    console.log('[OpenClawRuntime] sweeper: starting (interval=5min, stale=30min)');
    this.sweeperIntervalId = setInterval(() => this.sweep(), 5 * 60 * 1000);
  }

  stopSweeper(): void {
    if (this.sweeperIntervalId) {
      clearInterval(this.sweeperIntervalId);
      this.sweeperIntervalId = null;
      console.log('[OpenClawRuntime] sweeper: stopped');
    }
  }

  private sweep(): void {
    const now = Date.now();
    const staleThreshold = 30 * 60 * 1000; // 30 minutes
    let cleaned = 0;

    // 1. Clean up _processedToolEvents (cap at 2000 entries)
    const maxProcessedEvents = 2000;
    if (this.cb._processedToolEvents.size > maxProcessedEvents) {
      const toRemove = this.cb._processedToolEvents.size - maxProcessedEvents;
      const entries = Array.from(this.cb._processedToolEvents);
      for (let i = 0; i < toRemove; i++) {
        this.cb._processedToolEvents.delete(entries[i]);
      }
      cleaned += toRemove;
      console.log(
        '[OpenClawRuntime] sweeper: trimmed _processedToolEvents from ' +
          (this.cb._processedToolEvents.size + toRemove) +
          ' to ' +
          this.cb._processedToolEvents.size,
      );
    }

    // 2. Clean up announce/cascade maps for processed runIds
    // Only clean entries for runIds that were processed long ago
    const processedRunIds = this.cb.processedAnnounceRunIds;
    if (processedRunIds.size > 500) {
      // Trim to recent 300
      const entries = Array.from(processedRunIds);
      const toRemove = entries.length - 300;
      for (let i = 0; i < toRemove; i++) {
        const runId = entries[i];
        processedRunIds.delete(runId);
        this.cb.subagentThinkingByRunId.delete(runId);
        this.cb.announceTextByRunId.delete(runId);
        this.cb.lastAgentSeqByRunId.delete(runId);
        this.cb.pendingAgentEventsByRunId.delete(runId);
        cleaned += 4;
      }
      console.log(
        '[OpenClawRuntime] sweeper: trimmed processedAnnounceRunIds from ' +
          (processedRunIds.size + toRemove) +
          ' to ' +
          processedRunIds.size,
      );
    }

    // 3. Clean up subagentMessages for done/failed subagents
    for (const [key, status] of this.cb.subagentStatus) {
      if (status === 'done' || status === 'failed') {
        // Keep messages for detail page viewing, but limit size
        const msgs = this.cb.subagentMessages.get(key);
        if (msgs && msgs.length > 200) {
          // Keep first 100 + last 50
          const trimmed = [...msgs.slice(0, 100), ...msgs.slice(-50)];
          this.cb.subagentMessages.set(key, trimmed);
          cleaned += msgs.length - trimmed.length;
        }
      }
    }

    // 4. Clean up _announceToolMessages for done/failed subagents
    // Remove dedup keys for subagents that completed > staleThreshold ago
    // We can't easily track age per dedup key, so cap at 3000 entries
    const maxAnnounceToolMessages = 3000;
    if (this.cb._announceToolMessages.size > maxAnnounceToolMessages) {
      const toRemove = this.cb._announceToolMessages.size - maxAnnounceToolMessages;
      const entries = Array.from(this.cb._announceToolMessages);
      for (let i = 0; i < toRemove; i++) {
        this.cb._announceToolMessages.delete(entries[i]);
      }
      cleaned += toRemove;
      console.log(
        '[OpenClawRuntime] sweeper: trimmed _announceToolMessages from ' +
          (this.cb._announceToolMessages.size + toRemove) +
          ' to ' +
          this.cb._announceToolMessages.size,
      );
    }

    // 5. Clean up pendingToolCallIds and pendingEntryTimestamps for done/failed
    for (const pendingId of [...this.cb.pendingToolCallIds]) {
      const status = this.cb.subagentStatus.get(pendingId);
      if (status === 'done' || status === 'failed') {
        this.cb.pendingToolCallIds.delete(pendingId);
        this.cb.pendingEntryTimestamps.delete(pendingId);
        cleaned++;
      }
    }

    // 6. Clean up toolCallArgs for done/failed subagents older than staleThreshold
    // (args are only needed during active lifecycle)
    for (const toolCallId of this.cb.toolCallArgs.keys()) {
      const status = this.cb.subagentStatus.get(toolCallId);
      if (status === 'done' || status === 'failed') {
        const ts = this.cb.pendingEntryTimestamps.get(toolCallId);
        if (!ts || now - ts > staleThreshold) {
          this.cb.toolCallArgs.delete(toolCallId);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      console.log('[OpenClawRuntime] sweeper: cleaned ' + cleaned + ' stale entries total');
    }
  }
}
