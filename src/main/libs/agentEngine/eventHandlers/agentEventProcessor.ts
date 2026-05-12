import type { CoworkStore } from '../../../coworkStore';
import {
  isRecord,
  extractMessageText,
  extractThinkingContent,
  extractSentFilePathsFromHistory,
  extractCurrentTurnAssistantText,
  isDroppedBoundaryTextBlockSubset,
  generateStableMessageId,
  parseSubagentCompletionEvent,
  extractSubagentCompletionMessages,
  convertToCoworkMessage,
  truncate,
} from '../utils/gatewayHelpers';
import type {
  GatewayClientLike,
  AgentEventPayload,
  ChannelHistorySyncEntry,
  ActiveTurn,
} from '../gateway/types';
import {
  type OpenClawChannelSessionSync,
  parseManagedSessionKey,
} from '../../openclawChannelSessionSync';
import type { SubagentManager } from '../subagent/subagentManager';

export interface AgentEventProcessorCallbacks {
  _announceToolMessages: Set<string>;
  activeTurns: Map<string, ActiveTurn>;
  deletedChannelKeys: Set<string>;
  emit: (event: string, ...args: unknown[]) => void;
  ensureActiveTurn: (sessionId: string, sessionKey: string, runId: string) => void;
  failedSubagentIds: Set<string>;
  fullySyncedSessions: Set<string>;
  handleAgentToolEvent: (sessionId: string, turn: ActiveTurn, data: unknown) => void;
  heartbeatSessionKeys: Set<string>;
  lastAgentSeqByRunId: Map<string, number>;
  latestTurnTokenBySession: Map<string, number>;
  mainAgentLifecycleEnded: boolean;
  orchestrationParentSessionId: string | null;
  pendingAgentEventsByRunId: Map<string, AgentEventPayload[]>;
  pendingEntryTimestamps: Map<string, number>;
  pendingToolCallIds: Set<string>;
  reCreatedChannelSessionIds: Set<string>;
  resolveSubagentParentSessionId: (agentId: string) => string | null;
  sessionIdByRunId: Map<string, string>;
  sessionIdBySessionKey: Map<string, string>;
  sessionKeyToLabel: Map<string, string>;
  sessionKeyToToolCallId: Map<string, string>;
  store: CoworkStore;
  subagentManager: SubagentManager;
  subagentMessages: Map<
    string,
    Array<{ role: string; content: string; metadata?: Record<string, unknown> }>
  >;
  subagentStatus: Map<string, string>;
  subagentUuidToLabel: Map<string, string>;
  successfulSpawnToolCallIds: Set<string>;
  toSessionKey: (sessionId: string, agentId?: string) => string;
  toolCallArgs: Map<string, Record<string, unknown>>;
  toolCallIdToLabel: Map<string, string>;
  toolCallIdToParentSessionId: Map<string, string>;
  toolCallIdToSessionKey: Map<string, string>;
  uuidToToolCallId: Map<string, string>;
}

export class AgentEventProcessor {
  private readonly cb: AgentEventProcessorCallbacks;
  private _channelSessionSync: OpenClawChannelSessionSync | null = null;
  private _gatewayClient: GatewayClientLike | null = null;

  constructor(cb: AgentEventProcessorCallbacks) {
    this.cb = cb;
  }

  setChannelSessionSync(sync: OpenClawChannelSessionSync | null): void {
    this._channelSessionSync = sync;
  }

  setGatewayClient(client: GatewayClientLike | null): void {
    this._gatewayClient = client;
  }

  handleAgentEvent(payload: unknown, seq?: number): void {
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

    const sessionIdByRunId = runId ? this.cb.sessionIdByRunId.get(runId) : undefined;
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
      !this.cb.activeTurns.has(sessionId) &&
      sessionKey &&
      stream !== 'error' &&
      !isLifecycleEnd
    ) {
      console.log(
        '[Debug:handleAgentEvent] re-creating ActiveTurn for follow-up turn, sessionId:',
        sessionId,
      );
      // OpenClaw: runId is set only at send time, events never modify it
      this.cb.ensureActiveTurn(sessionId, sessionKey, '');
    }

    // Try to resolve channel-originated sessions (e.g. Telegram via OpenClaw)
    if (!sessionId && sessionKey && this._channelSessionSync) {
      const channelSessionId =
        this._channelSessionSync.resolveOrCreateSession(sessionKey) ||
        (!this.cb.heartbeatSessionKeys.has(sessionKey) &&
          this._channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
        this._channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
        null;
      console.log('[Debug:handleAgentEvent] channel resolve — channelSessionId:', channelSessionId);
      if (channelSessionId) {
        // If this key was previously deleted, allow re-creation but skip history sync
        if (this.cb.deletedChannelKeys.has(sessionKey)) {
          this.cb.deletedChannelKeys.delete(sessionKey);
          this.cb.fullySyncedSessions.add(channelSessionId);
          this.cb.reCreatedChannelSessionIds.add(channelSessionId);
          console.log(
            '[Debug:handleAgentEvent] re-created after delete, skipping history sync for:',
            sessionKey,
          );
        }
        this.rememberSessionKey(channelSessionId, sessionKey);
        sessionId = channelSessionId;
        // OpenClaw: runId is set only at send time, events never modify it
        this.cb.ensureActiveTurn(channelSessionId, sessionKey, '');
      }
    }

    if (!sessionId) {
      // 即使没有 sessionId，也处理子 Agent 的生命周期事件
      // 使用 sessionKeyToLabel 映射获取 agentId/label
      if (sessionKey && stream === 'lifecycle') {
        // Try to get toolCallId from sessionKeyToToolCallId mapping first
        // toolCallId is the unique identifier, label is only for display
        let toolCallId = this.cb.sessionKeyToToolCallId.get(sessionKey);
        // Also try with 'subagent:' prefix (gateway might use short format)
        if (!toolCallId && sessionKey.startsWith('subagent:')) {
          const fullSessionKey = 'agent:main:' + sessionKey;
          toolCallId = this.cb.sessionKeyToToolCallId.get(fullSessionKey);
        }
        // Final fallback: if sessionKey is a subagent and we have pending toolCallIds,
        // use the first UNMAPPED pending toolCallId and establish the mapping.
        // This handles cases where gateway strips result.childSessionKey from tool events.
        if (
          !toolCallId &&
          sessionKey.includes(':subagent:') &&
          this.cb.pendingToolCallIds.size > 0
        ) {
          // Filter to only pending toolCallIds that haven't been mapped to a childSessionKey.
          // NOTE: toolCallIdToSessionKey may contain temporary mappings to parentSessionKey
          // (set during sessions_spawn start), which should NOT count as "mapped" here.
          // We only consider a toolCallId as mapped when it maps to a childSessionKey (contains :subagent:).
          const unmappedPendingIds = Array.from(this.cb.pendingToolCallIds).filter(id => {
            const mappedSessionKey = this.cb.toolCallIdToSessionKey.get(id);
            // Unmapped if: no mapping OR mapping points to parent session (not child subagent)
            return !mappedSessionKey || !mappedSessionKey.includes(':subagent:');
          });
          if (unmappedPendingIds.length > 0) {
            // Extract the UUID from the incoming sessionKey to find the correct match.
            // Item-level spawns register with call_xxx toolCallIds but lack childSessionKey.
            // When lifecycle events arrive, sessionKey contains the UUID which may match
            // a pending entry directly or via partial matching.
            const uuidMatch = sessionKey.match(/subagent[:\-]([a-f0-9-]{36})/i);
            let pendingId: string | undefined;
            if (uuidMatch) {
              const uuid = uuidMatch[1];
              // First: check if the UUID itself is a pending toolCallId (short UUID format)
              if (unmappedPendingIds.includes(uuid)) {
                pendingId = uuid;
                console.log(
                  '[OpenClawRuntime] subagent lifecycle fallback: UUID match uuid=' + uuid,
                );
              } else {
                // Second: search pending IDs whose existing sessionKey mapping contains this UUID
                // (handles cases where toolCallIdToSessionKey was set during item-level spawn)
                for (const id of unmappedPendingIds) {
                  const existingMapping = this.cb.toolCallIdToSessionKey.get(id);
                  if (existingMapping && existingMapping.includes(uuid)) {
                    pendingId = id;
                    console.log(
                      '[OpenClawRuntime] subagent lifecycle fallback: partial UUID match toolCallId=' +
                        id +
                        ' existingMapping=' +
                        existingMapping,
                    );
                    break;
                  }
                }
              }
            }
            // Only use first unmapped if no UUID was found in sessionKey at all
            // (pure random UUID fallback — very unlikely but keep for safety).
            // When a subagent UUID IS present, let the nested handler (line 2754)
            // do the proper matching via sessionKey or temporal+parent logic.
            if (!pendingId && !uuidMatch) {
              pendingId = unmappedPendingIds[0];
              console.log(
                '[OpenClawRuntime] subagent lifecycle fallback: no UUID in sessionKey, using first unmapped toolCallId=' +
                  pendingId,
              );
            }
            if (!pendingId) {
              // Diagnostic: log state to understand why UUID matching failed
              const uuid = uuidMatch?.[1] || '(none)';
              const pendingList = Array.from(this.cb.pendingToolCallIds).join(',');
              const unmappedList = unmappedPendingIds.join(',');
              console.log(
                '[OpenClawRuntime] subagent lifecycle fallback: UUID present but no match, skipping — uuid=' +
                  uuid +
                  ' pendingToolCallIds=' +
                  pendingList +
                  ' unmappedPendingIds=' +
                  unmappedList,
              );
              // Do NOT set toolCallId here; the nested handler will do proper matching.

              // Secondary fallback: search for call_xxx entries by label + parent session.
              // Announcing spawns may not be in pendingToolCallIds if they weren't seen
              // as stream=item events from the main session. Find them via label matching.
              if (sessionKey.includes(':subagent:')) {
                const subagentUuidFromKey = sessionKey.split(':subagent:')[1] || '';
                // Try to find a matching call_xxx by checking subagentUuidToLabel or
                // toolCallIdToLabel for the same subagent UUID.
                if (subagentUuidFromKey) {
                  const labelFromUuid = this.cb.subagentUuidToLabel.get(subagentUuidFromKey);
                  if (labelFromUuid) {
                    for (const [callId, callLabel] of this.cb.toolCallIdToLabel.entries()) {
                      if (!callId.startsWith('call_')) continue;
                      if (callLabel !== labelFromUuid) continue;
                      // Found matching label — verify parent session alignment
                      const parentId = this.cb.toolCallIdToParentSessionId.get(callId);
                      if (parentId && parentId === this.cb.orchestrationParentSessionId) {
                        toolCallId = callId;
                        console.log(
                          '[OpenClawRuntime] subagent lifecycle fallback: label match sessionKey=' +
                            sessionKey +
                            ' toolCallId=' +
                            callId +
                            ' label=' +
                            labelFromUuid,
                        );
                        this.cb.toolCallIdToSessionKey.set(toolCallId, sessionKey);
                        this.cb.sessionKeyToToolCallId.set(sessionKey, toolCallId);
                        this.cb.uuidToToolCallId.set(subagentUuidFromKey, toolCallId);
                        break;
                      }
                    }
                  }
                }
              }
            } else {
              console.log(
                '[OpenClawRuntime] subagent lifecycle fallback: assigning pending toolCallId=' +
                  pendingId +
                  ' to sessionKey=' +
                  sessionKey +
                  ' (unmapped pending count: ' +
                  unmappedPendingIds.length +
                  ')',
              );
              toolCallId = pendingId;
              // Establish bidirectional mapping
              this.cb.toolCallIdToSessionKey.set(toolCallId, sessionKey);
              this.cb.sessionKeyToToolCallId.set(sessionKey, toolCallId);
              // Remove from pending since mapping is now established
              this.cb.pendingToolCallIds.delete(toolCallId);
              this.cb.pendingEntryTimestamps.delete(toolCallId);
            }
          } else {
            console.log(
              '[OpenClawRuntime] subagent lifecycle fallback: no unmapped pending toolCallIds available for sessionKey=' +
                sessionKey +
                ' (all ' +
                this.cb.pendingToolCallIds.size +
                ' pending IDs are already mapped)',
            );
          }
        }
        // Get display label for logging only (not used as key)
        const displayLabel = this.cb.toolCallIdToLabel.get(toolCallId || '') || '';
        // phase already extracted above for logging
        if (toolCallId) {
          console.log(
            '[OpenClawRuntime] subagent lifecycle (no sessionId): toolCallId=' +
              toolCallId +
              ' label=' +
              (displayLabel || '(none)') +
              ' phase=' +
              phase +
              ' sessionKey=' +
              sessionKey,
          );
          if (phase === 'start' || phase === 'running') {
            // If previously marked as failed (e.g. by pending timeout firing before
            // lifecycle events arrived), recover: the subagent is actually running.
            if (this.cb.failedSubagentIds.has(toolCallId)) {
              console.log(
                '[OpenClawRuntime] subagent lifecycle: recovering from failed status, toolCallId=' +
                  toolCallId +
                  ' (lifecycle start event arrived late)',
              );
              this.cb.failedSubagentIds.delete(toolCallId);
            }
            // Skip if already done (don't override completion with late start/running event)
            if (this.cb.subagentStatus.get(toolCallId) === 'done') {
              console.log(
                '[OpenClawRuntime] subagent lifecycle: ignoring start/running for completed toolCallId=' +
                  toolCallId,
              );
              return;
            }
            // Remove from pending since subagent is now running
            this.cb.pendingToolCallIds.delete(toolCallId);
            this.cb.pendingEntryTimestamps.delete(toolCallId);
            this.cb.subagentStatus.set(toolCallId, 'running');
          } else if (phase === 'end' || phase === 'completed' || phase === 'stopped') {
            // If previously marked as failed (e.g. by pending timeout firing before
            // lifecycle events arrived), recover: the subagent actually completed.
            if (this.cb.failedSubagentIds.has(toolCallId)) {
              console.log(
                '[OpenClawRuntime] subagent lifecycle: recovering from failed status, toolCallId=' +
                  toolCallId +
                  ' (lifecycle event arrived late)',
              );
              this.cb.failedSubagentIds.delete(toolCallId);
            }
            console.log(
              '[OpenClawRuntime] subagent lifecycle: setting done for toolCallId=' +
                toolCallId +
                ' sessionKey=' +
                sessionKey,
            );
            this.cb.subagentStatus.set(toolCallId, 'done');
            this.cb.subagentManager.persistSubagentStatus(toolCallId, 'done');
            this.cb.subagentManager.checkAllSubagentsDone();

            // Also clean up any parallel UUID entry created by the nested lifecycle handler.
            // The phase=start for nested subagents goes through the nested handler (line 2563)
            // which uses sessionKey's UUID as key, while phase=end comes through this main
            // handler with a resolved toolCallId. This leaves a dangling 'running' UUID entry
            // that gets incorrectly killed by the idle timeout.
            if (sessionKey && sessionKey.includes(':subagent:')) {
              const subagentUuid = sessionKey.split(':subagent:')[1] || '';
              if (subagentUuid && subagentUuid !== toolCallId) {
                const uuidStatus = this.cb.subagentStatus.get(subagentUuid);
                if (uuidStatus === 'running') {
                  console.log(
                    '[OpenClawRuntime] subagent lifecycle: cleaning up dangling UUID entry uuid=' +
                      subagentUuid +
                      ' toolCallId=' +
                      toolCallId,
                  );
                  this.cb.subagentStatus.delete(subagentUuid);
                }
              }
            }

            // Emit subagent_completion message to parent session
            // Use per-session mapping to avoid cross-session contamination
            const completionParentId =
              this.cb.toolCallIdToParentSessionId.get(toolCallId) ||
              this.cb.orchestrationParentSessionId;
            if (completionParentId) {
              const label = this.cb.toolCallIdToLabel.get(toolCallId) || displayLabel || 'Subagent';
              const childSessionKey = this.cb.toolCallIdToSessionKey.get(toolCallId) || '';

              // Get result content from subagentMessages - find last assistant message
              const storageKey = childSessionKey || toolCallId;
              const msgs = this.cb.subagentMessages.get(storageKey) || [];
              const lastAssistantMsg = msgs.filter(m => m.role === 'assistant').pop();
              const resultContent = lastAssistantMsg?.content || '';

              console.log(
                '[OpenClawRuntime] subagent lifecycle: emitting completion for toolCallId=' +
                  toolCallId +
                  ' label=' +
                  label +
                  ' sessionKey=' +
                  childSessionKey +
                  ' resultLength=' +
                  resultContent.length,
              );

              const completionMessage = {
                id: `subagent-completion-${toolCallId}-${Date.now()}`,
                type: 'subagent_completion',
                role: 'assistant',
                content: resultContent || `Subagent "${label}" completed successfully.`,
                timestamp: Date.now(),
                metadata: {
                  taskLabel: label,
                  status: phase === 'stopped' ? 'stopped' : 'completed',
                  sessionKey: childSessionKey,
                  toolCallId,
                },
              };

              const parentSessionId = this.cb.resolveSubagentParentSessionId(toolCallId);
              if (parentSessionId) {
                this.cb.emit('message', parentSessionId, completionMessage);
              }
            }
          } else if (phase === 'error') {
            // Subagent lifecycle error: only mark as failed if spawn itself failed.
            // If the spawn result was successful (isError=false), a transient lifecycle error
            // should not remove the subagent from the list.
            // The toolCallId in lifecycle events may differ from the spawn toolCallId
            // (lifecycle uses UUID while spawn uses call_ ID). Check label mapping to bridge.
            const lifecycleLabel = this.cb.toolCallIdToLabel.get(toolCallId) || displayLabel || '';
            const spawnSucceeded =
              this.cb.successfulSpawnToolCallIds.has(toolCallId) ||
              (lifecycleLabel &&
                Array.from(this.cb.successfulSpawnToolCallIds).some(
                  spawnId => this.cb.toolCallIdToLabel.get(spawnId) === lifecycleLabel,
                ));
            if (spawnSucceeded) {
              console.log(
                '[OpenClawRuntime] subagent lifecycle error but spawn succeeded, keeping in list: toolCallId=' +
                  toolCallId +
                  ' label=' +
                  (displayLabel || '(none)'),
              );
              // Keep status as 'running' — the subagent hasn't actually finished.
              // Transient lifecycle errors (e.g. quota exceeded) should not mark
              // the subagent as done, otherwise later retry start events are ignored.
              this.cb.pendingToolCallIds.delete(toolCallId);
              this.cb.subagentManager.checkAllSubagentsDone();
            } else {
              // Spawn failed - keep in list with 'failed' status for frontend display
              console.log(
                '[OpenClawRuntime] subagent lifecycle error: marking failed toolCallId=' +
                  toolCallId +
                  ' label=' +
                  (displayLabel || '(none)'),
              );
              this.cb.failedSubagentIds.add(toolCallId);
              this.cb.subagentStatus.set(toolCallId, 'failed');
              this.cb.pendingToolCallIds.delete(toolCallId);
              this.cb.pendingEntryTimestamps.delete(toolCallId);
              this.cb.toolCallIdToSessionKey.delete(toolCallId);
              this.cb.toolCallIdToParentSessionId.delete(toolCallId);
              this.cb.toolCallIdToLabel.delete(toolCallId);
              this.cb.subagentMessages.delete(toolCallId);
            }
          }
        } else if (sessionKey && sessionKey.includes(':subagent:')) {
          // No toolCallId but this is a subagent (spawned by a subagent, not directly by main agent).
          // Use the subagent UUID portion as the tracking key.
          const subagentUuid = sessionKey.split(':subagent:')[1] || sessionKey;
          const emitAgentId = subagentUuid;

          // Compute parent session ID upfront — needed by temporal matching in both phase=start and phase=end.
          const nestedParentSessionId = this.cb.subagentManager.findParentSessionIdForNested(
            emitAgentId,
            sessionKey,
          );

          // Try to find the corresponding call_xxx toolCallId BEFORE creating any status entries.
          // This prevents duplicate entries (UUID vs call_xxx) in the subagent list.
          let linkedCallId: string | null = null;

          // First: try sessionKey match (same logic as lines 508-518 below)
          for (const [pendingId, pendingKey] of this.cb.toolCallIdToSessionKey.entries()) {
            if (pendingKey && pendingKey.includes(':subagent:') && pendingKey === sessionKey) {
              linkedCallId = pendingId;
              console.log(
                '[OpenClawRuntime] subagent lifecycle (nested): pre-link via sessionKey UUID=' +
                  emitAgentId +
                  ' -> toolCallId=' +
                  pendingId,
              );
              break;
            }
          }

          // Second: temporal+parent matching if no sessionKey match and we have parentSessionId
          if (!linkedCallId && nestedParentSessionId) {
            const linkedUuids = new Set<string>();
            for (const [, callId] of this.cb.uuidToToolCallId.entries()) {
              linkedUuids.add(callId);
            }
            const candidates: Array<{ id: string; time: number }> = [];
            for (const pendingId of this.cb.pendingToolCallIds) {
              if (!pendingId.startsWith('call_')) continue;
              if (linkedUuids.has(pendingId)) continue;
              const parentSessionId = this.cb.toolCallIdToParentSessionId.get(pendingId);
              if (parentSessionId !== nestedParentSessionId) continue;
              const mappedKey = this.cb.toolCallIdToSessionKey.get(pendingId);
              if (mappedKey && mappedKey.includes(':subagent:')) continue; // already mapped to child
              const entryTime = this.cb.pendingEntryTimestamps.get(pendingId) || 0;
              candidates.push({ id: pendingId, time: entryTime });
            }
            if (candidates.length > 0) {
              candidates.sort((a, b) => b.time - a.time);
              linkedCallId = candidates[0].id;
              console.log(
                '[OpenClawRuntime] subagent lifecycle (nested): pre-link via temporal UUID=' +
                  emitAgentId +
                  ' -> toolCallId=' +
                  linkedCallId +
                  ' parentSessionId=' +
                  nestedParentSessionId,
              );
            } else {
              // Secondary fallback: search all call_xxx entries by parent session
              for (const [callId] of this.cb.toolCallIdToLabel.entries()) {
                if (!callId.startsWith('call_')) continue;
                if (linkedUuids.has(callId)) continue;
                const parentId = this.cb.toolCallIdToParentSessionId.get(callId);
                if (parentId !== nestedParentSessionId) continue;
                const mappedKey = this.cb.toolCallIdToSessionKey.get(callId);
                if (mappedKey && mappedKey.includes(':subagent:')) continue;
                linkedCallId = callId;
                console.log(
                  '[OpenClawRuntime] subagent lifecycle (nested): pre-link via label-based UUID=' +
                    emitAgentId +
                    ' -> toolCallId=' +
                    callId,
                );
                break;
              }
            }
          }

          // Use linkedCallId as the primary tracking key if found, otherwise fall back to UUID
          const trackingKey = linkedCallId || emitAgentId;

          if (phase === 'start' || phase === 'running') {
            // Skip if already running or done (don't override completion with late start/running)
            const existingStatus = this.cb.subagentStatus.get(trackingKey);
            if (existingStatus === 'running' || existingStatus === 'done') return;
            // Skip if already marked as failed
            if (this.cb.failedSubagentIds.has(trackingKey)) return;

            // Clean up pending state and set running status on the tracking key
            this.cb.pendingToolCallIds.delete(trackingKey);
            this.cb.pendingEntryTimestamps.delete(trackingKey);
            this.cb.subagentStatus.set(trackingKey, 'running');
            this.cb.sessionKeyToToolCallId.set(sessionKey, trackingKey);
            this.cb.toolCallIdToSessionKey.set(trackingKey, sessionKey);

            // Store UUID → call_xxx mapping for context lookup (even if we found it here)
            if (linkedCallId) {
              this.cb.uuidToToolCallId.set(emitAgentId, linkedCallId);
            }
            if (nestedParentSessionId) {
              this.cb.toolCallIdToParentSessionId.set(trackingKey, nestedParentSessionId);
            }

            // Extract label from multiple sources for nested subagents
            // 1. sessionKeyToLabel (set by sessions_spawn result from parent)
            // 2. subagentUuidToLabel (from previous sessions.list query or tool event)
            // 3. emitAgentId's existing label (may have been set by tool event)
            // 4. event data.meta (format: 'label xxx, task yyy')
            // 5. event data.name or data.label field
            // 6. UUID fallback
            let nestedLabel: string | null = this.cb.sessionKeyToLabel.get(sessionKey) || null;
            if (!nestedLabel) {
              nestedLabel = this.cb.subagentUuidToLabel.get(subagentUuid) || null;
            }
            if (!nestedLabel) {
              nestedLabel = this.cb.toolCallIdToLabel.get(emitAgentId) || null;
            }
            if (!nestedLabel) {
              const metaField = typeof data.meta === 'string' ? data.meta.trim() : '';
              if (metaField) {
                const labelMatch = metaField.match(/label\s+([^,]+)/);
                if (labelMatch && labelMatch[1]) {
                  nestedLabel = labelMatch[1].trim();
                }
              }
            }
            if (!nestedLabel) {
              const dataName = typeof data.name === 'string' ? data.name.trim() : '';
              const dataLabel = typeof data.label === 'string' ? data.label.trim() : '';
              nestedLabel = dataLabel || dataName || null;
            }
            // Priority: label > task description (first 30 chars) — never use UUID as display
            // Try to get task description from toolCallArgs if label is empty
            if (!nestedLabel) {
              const spawnInfo = this.cb.toolCallArgs.get(trackingKey);
              if (spawnInfo && typeof spawnInfo.task === 'string' && spawnInfo.task) {
                nestedLabel = spawnInfo.task.slice(0, 30);
              }
            }
            const displayLabel = nestedLabel || '(no label)';
            // Store label under trackingKey (call_xxx or UUID)
            if (!this.cb.toolCallIdToLabel.has(trackingKey)) {
              this.cb.toolCallIdToLabel.set(trackingKey, displayLabel);
            }
            // Store UUID → label mapping for direct lookup by lifecycle events
            if (nestedLabel) {
              this.cb.subagentUuidToLabel.set(subagentUuid, nestedLabel);
            }

            // Persist nested spawn to parent session so it survives restart
            // Use trackingKey (call_xxx when linked) so frontend can find it
            this.cb.subagentManager.persistNestedSubagentSpawn(
              trackingKey,
              displayLabel,
              sessionKey,
            );
            // If no label found, query sessions.list to resolve
            if (!nestedLabel && this._gatewayClient) {
              // Construct the correct parent session key for the query.
              // Prefer per-session lookup over global to avoid cross-session contamination.
              let queryParentKey: string | null = null;
              // First try: extract from sessionKey directly (for nested format)
              if (sessionKey) {
                const gucciaiMatch = sessionKey.match(/^agent:main:gucciai:([^:]+):subagent:/);
                if (gucciaiMatch) {
                  queryParentKey = 'agent:main:gucciai:' + gucciaiMatch[1];
                }
              }
              // Second try: use the per-session parent mapping we just established
              if (!queryParentKey && nestedParentSessionId) {
                queryParentKey = 'agent:main:gucciai:' + nestedParentSessionId;
              }
              // Fallback: global (only if no per-session info available)
              if (!queryParentKey && this.cb.orchestrationParentSessionId) {
                queryParentKey = 'agent:main:gucciai:' + this.cb.orchestrationParentSessionId;
              }
              if (queryParentKey) {
                console.log(
                  '[OpenClawRuntime] nested subagent: no label for UUID=' +
                    subagentUuid +
                    ', querying sessions.list with parentKey=' +
                    queryParentKey,
                );
                void this.cb.subagentManager.queryNestedSubagentLabel(
                  subagentUuid,
                  queryParentKey,
                  trackingKey,
                );
              }
            }
            console.log(
              '[OpenClawRuntime] subagent lifecycle (nested): START toolCallId=' +
                trackingKey +
                ' linkedCallId=' +
                (linkedCallId || '(none)') +
                ' label=' +
                displayLabel +
                ' sessionKey=' +
                sessionKey,
            );
          } else if (phase === 'end' || phase === 'completed' || phase === 'stopped') {
            // Determine tracking key: prefer linked call_xxx from uuidToToolCallId
            const existingLink = this.cb.uuidToToolCallId.get(emitAgentId);
            const endTrackingKey = existingLink || emitAgentId;

            if (this.cb.failedSubagentIds.has(endTrackingKey)) return;

            // If no existing link, try to find one now (phase=end may arrive before phase=start in rare cases)
            if (!existingLink && nestedParentSessionId) {
              const linkedUuids = new Set<string>();
              for (const [, callId] of this.cb.uuidToToolCallId.entries()) {
                linkedUuids.add(callId);
              }
              const candidates: Array<{ id: string; time: number }> = [];
              for (const pendingId of this.cb.pendingToolCallIds) {
                if (!pendingId.startsWith('call_')) continue;
                if (linkedUuids.has(pendingId)) continue;
                const parentSessionId = this.cb.toolCallIdToParentSessionId.get(pendingId);
                if (parentSessionId !== nestedParentSessionId) continue;
                const mappedKey = this.cb.toolCallIdToSessionKey.get(pendingId);
                if (mappedKey && mappedKey.includes(':subagent:')) continue;
                const entryTime = this.cb.pendingEntryTimestamps.get(pendingId) || 0;
                candidates.push({ id: pendingId, time: entryTime });
              }
              if (candidates.length > 0) {
                candidates.sort((a, b) => b.time - a.time);
                const matchedCallId = candidates[0].id;
                this.cb.uuidToToolCallId.set(emitAgentId, matchedCallId);
                console.log(
                  '[OpenClawRuntime] subagent lifecycle (nested): late link (phase=end) UUID=' +
                    emitAgentId +
                    ' -> toolCallId=' +
                    matchedCallId,
                );
                // Now use the matched call_xxx as tracking key
                this.cb.subagentStatus.set(matchedCallId, 'done');
                this.cb.subagentManager.persistSubagentStatus(matchedCallId, 'done');
              } else {
                // Secondary fallback: search all call_xxx entries by parent session
                for (const [callId] of this.cb.toolCallIdToLabel.entries()) {
                  if (!callId.startsWith('call_')) continue;
                  if (linkedUuids.has(callId)) continue;
                  const parentId = this.cb.toolCallIdToParentSessionId.get(callId);
                  if (parentId !== nestedParentSessionId) continue;
                  const mappedKey = this.cb.toolCallIdToSessionKey.get(callId);
                  if (mappedKey && mappedKey.includes(':subagent:')) continue;
                  this.cb.uuidToToolCallId.set(emitAgentId, callId);
                  console.log(
                    '[OpenClawRuntime] subagent lifecycle (nested): late label-based link (phase=end) UUID=' +
                      emitAgentId +
                      ' -> toolCallId=' +
                      callId,
                  );
                  this.cb.subagentStatus.set(callId, 'done');
                  this.cb.subagentManager.persistSubagentStatus(callId, 'done');
                  break;
                }
              }
            } else {
              // Use existing tracking key
              this.cb.subagentStatus.set(endTrackingKey, 'done');
              this.cb.subagentManager.persistSubagentStatus(endTrackingKey, 'done');
            }

            this.cb.subagentManager.checkAllSubagentsDone();
            console.log(
              '[OpenClawRuntime] subagent lifecycle (nested): DONE toolCallId=' +
                endTrackingKey +
                ' linkedCallId=' +
                (existingLink || '(none)') +
                ' sessionKey=' +
                sessionKey,
            );
          } else if (phase === 'error') {
            // Determine tracking key: prefer linked call_xxx from uuidToToolCallId
            const existingLink = this.cb.uuidToToolCallId.get(emitAgentId);
            const errorTrackingKey = existingLink || emitAgentId;

            // Nested subagent lifecycle error: if already marked done from a prior
            // completed/stopped event, don't overwrite with failure.
            if (this.cb.subagentStatus.get(errorTrackingKey) === 'done') {
              console.log(
                '[OpenClawRuntime] subagent lifecycle (nested): error but already done, keeping: trackingKey=' +
                  errorTrackingKey +
                  ' sessionKey=' +
                  sessionKey,
              );
            } else {
              this.cb.failedSubagentIds.add(errorTrackingKey);
              this.cb.subagentStatus.delete(errorTrackingKey);
              this.cb.pendingToolCallIds.delete(errorTrackingKey);
              this.cb.pendingEntryTimestamps.delete(errorTrackingKey);
              this.cb.toolCallIdToSessionKey.delete(errorTrackingKey);
              this.cb.sessionKeyToToolCallId.delete(sessionKey);
              this.cb.toolCallIdToParentSessionId.delete(errorTrackingKey);
              this.cb.toolCallIdToLabel.delete(errorTrackingKey);
              this.cb.subagentMessages.delete(sessionKey);
              console.log(
                '[OpenClawRuntime] subagent lifecycle (nested): ERROR toolCallId=' +
                  errorTrackingKey +
                  ' sessionKey=' +
                  sessionKey,
              );
            }
          }
        } else {
          // No toolCallId and not a subagent — lifecycle event for an agent not spawned via sessions_spawn.
          // These are not tracked in the subagent list; they run as implicit children.
          console.log(
            '[OpenClawRuntime] subagent lifecycle (no toolCallId): ignoring untracked sessionKey=' +
              sessionKey +
              ' phase=' +
              phase,
          );
        }
      }

      // 处理子 Agent 的 thinking/assistant/tool/user/item/command_output 事件（无 sessionId）
      if (
        sessionKey &&
        sessionKey.includes(':subagent:') &&
        (stream === 'thinking' ||
          stream === 'assistant' ||
          stream === 'tool' ||
          stream === 'tools' ||
          stream === 'user' ||
          stream === 'item' ||
          stream === 'command_output')
      ) {
        const mappedLabel = this.cb.sessionKeyToLabel.get(sessionKey);
        const storageKey = sessionKey || mappedLabel;
        // Get the toolCallId for IPC emission (frontend expects toolCallId as agentId)
        // The frontend SubTaskDetailDrawer uses toolCallId (toolUseId) as agentId
        // Priority: 1. direct sessionKey → toolCallId mapping
        //           2. label → toolCallId mapping via toolCallIdToLabel
        //           3. reverse lookup from parent session
        //           4. pending toolCallIds with matching label
        //           5. final fallback: use toolCallId from lifecycle fallback mapping
        let emitAgentId =
          (storageKey ? this.cb.sessionKeyToToolCallId.get(storageKey) : undefined) || '';
        // If no direct mapping, try reverse lookup
        if (!emitAgentId && storageKey && this.cb.orchestrationParentSessionId) {
          emitAgentId = this.cb.subagentManager.findToolCallIdByChildSessionKey(storageKey) || '';
        }
        // Try to find by label from toolCallIdToLabel
        if (!emitAgentId && mappedLabel) {
          for (const [tcId, tcLabel] of this.cb.toolCallIdToLabel) {
            if (tcLabel === mappedLabel) {
              emitAgentId = tcId;
              // Also establish the mapping for future events
              this.cb.sessionKeyToToolCallId.set(storageKey, tcId);
              this.cb.toolCallIdToSessionKey.set(tcId, storageKey);
              console.log(
                '[OpenClawRuntime] subagent event: established mapping via label match. label=' +
                  mappedLabel +
                  ' toolCallId=' +
                  tcId +
                  ' sessionKey=' +
                  storageKey,
              );
              break;
            }
          }
        }
        // Check pendingToolCallIds - try to match with label or use FIFO for multiple pending
        if (!emitAgentId && this.cb.pendingToolCallIds.size > 0) {
          const unmappedPendingIds = Array.from(this.cb.pendingToolCallIds).filter(id => {
            const mappedSessionKey = this.cb.toolCallIdToSessionKey.get(id);
            return !mappedSessionKey || !mappedSessionKey.includes(':subagent:');
          });
          // First try label matching with pending IDs
          if (mappedLabel && unmappedPendingIds.length > 0) {
            for (const pendingId of unmappedPendingIds) {
              const pendingLabel = this.cb.toolCallIdToLabel.get(pendingId);
              if (pendingLabel === mappedLabel) {
                emitAgentId = pendingId;
                this.cb.sessionKeyToToolCallId.set(storageKey, emitAgentId);
                this.cb.toolCallIdToSessionKey.set(emitAgentId, storageKey);
                console.log(
                  '[OpenClawRuntime] subagent event: established mapping via pending label match. label=' +
                    mappedLabel +
                    ' toolCallId=' +
                    emitAgentId +
                    ' sessionKey=' +
                    storageKey,
                );
                break;
              }
            }
          }
          // If still no match and only one unmapped pending, use it
          if (!emitAgentId && unmappedPendingIds.length === 1) {
            emitAgentId = unmappedPendingIds[0];
            this.cb.sessionKeyToToolCallId.set(storageKey, emitAgentId);
            this.cb.toolCallIdToSessionKey.set(emitAgentId, storageKey);
            console.log(
              '[OpenClawRuntime] subagent event: established mapping via single pending. toolCallId=' +
                emitAgentId +
                ' sessionKey=' +
                storageKey,
            );
          }
          // If multiple unmapped pending but no label match, log warning
          if (!emitAgentId && unmappedPendingIds.length > 1) {
            console.log(
              '[OpenClawRuntime] subagent event: multiple unmapped pending (' +
                unmappedPendingIds.length +
                '), cannot determine which one for sessionKey=' +
                storageKey +
                ' label=' +
                (mappedLabel || '(none)'),
            );
          }
        }
        // Final fallback: use storageKey (sessionKey) - log this as potential mismatch
        if (!emitAgentId) {
          emitAgentId = storageKey || '';
          console.log(
            '[OpenClawRuntime] subagent event: using storageKey as fallback emitAgentId=' +
              emitAgentId +
              ' (may not match frontend toolCallId)',
          );
        }
        // 只处理 subagent sessionKey（格式: agent:*:subagent:*）
        // 使用直接匹配而非排除逻辑，更健壮且能处理未来边缘情况
        if (sessionKey?.includes(':subagent:')) {
          console.log(
            '[OpenClawRuntime] subagent event (no sessionId): capturing ' +
              stream +
              ' for storageKey=' +
              storageKey +
              ' mappedLabel=' +
              (mappedLabel || '(none)') +
              ' emitAgentId=' +
              emitAgentId +
              ' data=' +
              JSON.stringify(agentPayload.data).slice(0, 200),
          );
          // 初始化存储结构 - 只存储到 storageKey（避免重复）
          // 注意：当 sessions_spawn 结束时，会将消息从 toolCallId 复制到 sessionKey 或反之
          if (!this.cb.subagentMessages.has(storageKey)) {
            this.cb.subagentMessages.set(storageKey, []);
          }
          const msgs = this.cb.subagentMessages.get(storageKey)!;
          const subData = isRecord(agentPayload.data)
            ? (agentPayload.data as Record<string, unknown>)
            : null;
          const eventText = typeof subData?.text === 'string' ? subData.text : '';

          if (stream === 'user' && eventText) {
            const msgId = `subagent-user-${Date.now()}-${msgs.length}`;
            const newMsg = { role: 'user', content: eventText };
            msgs.push(newMsg);
            // Emit IPC event for streaming
            const parentSessionId = this.cb.resolveSubagentParentSessionId(emitAgentId);
            if (parentSessionId) {
              this.cb.emit('subagentMessage', parentSessionId, emitAgentId, {
                id: msgId,
                type: 'user',
                content: eventText,
                timestamp: Date.now(),
              });
            }
          } else if (stream === 'assistant' && eventText) {
            // Check for truncated NO_REPLY markers (OpenClaw special marker)
            // When detected, query chat.history to get complete text before showing
            const trimmedEventText = eventText.trim();
            const NO_REPLY_MARKER = 'NO_REPLY';
            const isFullNoReply = /^NO_REPLY$/i.test(trimmedEventText);
            if (isFullNoReply) {
              // Full NO_REPLY confirmed - skip entirely
              return;
            }
            const isPossibleNoReply =
              trimmedEventText.length <= NO_REPLY_MARKER.length &&
              NO_REPLY_MARKER.startsWith(trimmedEventText) &&
              trimmedEventText.length > 0;

            if (isPossibleNoReply) {
              // Possible truncated prefix - query history to resolve
              if (this.cb.orchestrationParentSessionId && emitAgentId && this._gatewayClient) {
                console.log(
                  '[OpenClawRuntime] subagent assistant: possible truncated NO_REPLY="' +
                    trimmedEventText +
                    '", syncing with history',
                );
                const subagentSessionKey = sessionKey;
                void this.cb.subagentManager.syncSubagentNoReply(
                  storageKey,
                  emitAgentId,
                  subagentSessionKey,
                  msgs,
                  trimmedEventText,
                );
              }
              return;
            }

            // Normal text - proceed with message creation

            // Check if the last message is tool_result - if so, start a new assistant message
            const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
            const isAfterToolResult = lastMsg && lastMsg.role === 'tool_result';

            // Find last assistant message (but only if we're not after a tool_result)
            const lastAssistant = isAfterToolResult
              ? null
              : msgs.filter(m => m.role === 'assistant').pop();

            const msgId = lastAssistant
              ? `subagent-assistant-${Date.now()}-${msgs.length - 1}`
              : `subagent-assistant-${Date.now()}-${msgs.length}`;

            if (lastAssistant && !isAfterToolResult) {
              // Continue appending to existing assistant message (streaming)
              const prevContent = lastAssistant.content;
              lastAssistant.content = eventText.startsWith(prevContent)
                ? eventText
                : prevContent + eventText;
              // Emit update event
              const parentSessionId = this.cb.resolveSubagentParentSessionId(emitAgentId);
              if (parentSessionId) {
                this.cb.emit(
                  'subagentMessageUpdate',
                  parentSessionId,
                  emitAgentId,
                  msgId,
                  lastAssistant.content,
                );
              }
            } else {
              // Create new assistant message (after tool_result or no existing assistant)
              const newMsg = { role: 'assistant', content: eventText };
              msgs.push(newMsg);
              // Emit new message event
              const parentSessionId = this.cb.resolveSubagentParentSessionId(emitAgentId);
              if (parentSessionId) {
                this.cb.emit('subagentMessage', parentSessionId, emitAgentId, {
                  id: msgId,
                  type: 'assistant',
                  content: eventText,
                  timestamp: Date.now(),
                });
              }
            }
          } else if (stream === 'thinking') {
            const thinkingDelta = typeof subData?.delta === 'string' ? subData.delta : '';
            const thinkingText = typeof subData?.text === 'string' ? subData.text : '';
            const msgId = `subagent-thinking-${Date.now()}`;
            // 将 thinking 添加到最后一个 assistant 消息
            const lastAssistant = msgs.filter(m => m.role === 'assistant').pop();
            const thinkingContent = thinkingDelta || thinkingText;
            if (lastAssistant) {
              lastAssistant.content = thinkingContent;
            } else {
              msgs.push({ role: 'assistant', content: thinkingContent });
            }
            // Emit thinking update event
            const thinkingParentSessionId = this.cb.resolveSubagentParentSessionId(emitAgentId);
            if (thinkingParentSessionId && thinkingContent) {
              this.cb.emit(
                'subagentThinkingUpdate',
                thinkingParentSessionId,
                emitAgentId,
                msgId,
                thinkingContent,
              );
            }
          } else if (stream === 'tool' || stream === 'tools') {
            const toolPhase = typeof subData?.phase === 'string' ? subData.phase : '';
            const toolName = typeof subData?.name === 'string' ? subData.name : '';
            const toolCallId = typeof subData?.toolCallId === 'string' ? subData.toolCallId : '';
            if (toolPhase === 'start' && toolName) {
              const msgId = `subagent-tool-${toolCallId || Date.now()}`;
              const toolContent = `Using tool: ${toolName}\n\nInput: ${JSON.stringify(subData?.args || {}, null, 2)}`;
              const toolMsg = {
                role: 'tool_use',
                content: toolContent,
                metadata: {
                  toolName,
                  toolUseId: toolCallId,
                  toolInput: subData?.args,
                },
              };
              msgs.push(toolMsg);
              // Emit tool_use message
              const toolParentSessionId = this.cb.resolveSubagentParentSessionId(emitAgentId);
              if (toolParentSessionId) {
                this.cb.emit('subagentMessage', toolParentSessionId, emitAgentId, {
                  id: msgId,
                  type: 'tool_use',
                  content: toolContent,
                  timestamp: Date.now(),
                  metadata: {
                    toolName,
                    toolUseId: toolCallId,
                    toolInput: subData?.args,
                  },
                });
                // Also add to main session's store so it appears in the conversation
                if (
                  toolName === 'sessions_spawn' ||
                  toolName === 'sessions_resume' ||
                  toolName === 'sessions_read'
                ) {
                  const mainToolUseId = toolCallId || emitAgentId;
                  if (mainToolUseId && !this.cb._announceToolMessages.has(mainToolUseId + ':use')) {
                    this.cb._announceToolMessages.add(mainToolUseId + ':use');
                    this.cb.store.addMessage(toolParentSessionId, {
                      type: 'tool_use',
                      content: `Using tool: ${toolName}`,
                      metadata: {
                        toolName,
                        toolInput: isRecord(subData?.args)
                          ? (subData.args as Record<string, unknown>)
                          : {},
                        toolUseId: mainToolUseId,
                      },
                    });
                  }
                }
              }
            } else if (toolPhase === 'result' && toolCallId) {
              const resultText = typeof subData?.result === 'string' ? subData.result : '';
              const isError = Boolean(subData?.isError);
              const resultMsg = {
                role: 'tool_result',
                content: resultText,
                metadata: {
                  toolUseId: toolCallId,
                  isError,
                  toolResult: subData?.result,
                },
              };
              msgs.push(resultMsg);
              // Emit tool_result
              const resultParentSessionId = this.cb.resolveSubagentParentSessionId(emitAgentId);
              if (resultParentSessionId) {
                this.cb.emit(
                  'subagentToolResult',
                  this.cb.orchestrationParentSessionId,
                  emitAgentId,
                  toolCallId,
                  resultText,
                  isError,
                );
                // Also add to main session's store for sessions_spawn results
                if (
                  toolName === 'sessions_spawn' ||
                  toolName === 'sessions_resume' ||
                  toolName === 'sessions_read'
                ) {
                  const mainToolUseId = toolCallId || emitAgentId;
                  if (
                    mainToolUseId &&
                    !this.cb._announceToolMessages.has(mainToolUseId + ':result')
                  ) {
                    // Gateway strips data.result from stream=tool events unless verbose=full.
                    // If result is empty, skip store.addMessage and let the stream=item end
                    // path handle it (item events carry the full result object).
                    if (!resultText && !isRecord(subData?.result)) {
                      console.log(
                        '[OpenClawRuntime] tool result stripped by gateway, deferring to item path: toolCallId=' +
                          mainToolUseId,
                      );
                    } else {
                      this.cb._announceToolMessages.add(mainToolUseId + ':result');
                      this.cb.store.addMessage(resultParentSessionId, {
                        type: 'tool_result',
                        content: resultText,
                        metadata: {
                          toolUseId: mainToolUseId,
                          toolName,
                          toolResult:
                            typeof subData?.result === 'string'
                              ? subData.result
                              : JSON.stringify(subData?.result ?? ''),
                          isError,
                        },
                      });
                    }
                  }
                }
              }
            }
          } else if (stream === 'item') {
            // item stream 包含 tool 执行的详细信息
            // 数据结构: { itemId, phase: 'start'|'update'|'end', kind: 'tool'|'command', title, status, name, meta (string), toolCallId }
            const itemKind = typeof subData?.kind === 'string' ? subData.kind : '';
            const itemPhase = typeof subData?.phase === 'string' ? subData.phase : '';
            const itemId = typeof subData?.itemId === 'string' ? subData.itemId : '';
            const itemName = typeof subData?.name === 'string' ? subData.name : '';
            const itemStatus = typeof subData?.status === 'string' ? subData.status : '';
            const itemTitle = typeof subData?.title === 'string' ? subData.title : '';
            const itemToolCallId =
              typeof subData?.toolCallId === 'string' ? subData.toolCallId : itemId;
            // meta is a string in OpenClaw AgentItemEventData, parse it as JSON if possible
            const metaRaw = typeof subData?.meta === 'string' ? subData.meta : '';
            let itemMeta: Record<string, unknown> = {};
            if (metaRaw) {
              try {
                itemMeta = JSON.parse(metaRaw) as Record<string, unknown>;
              } catch {
                // meta may not be JSON, use it as plain text
              }
            }
            // Also check if meta is already an object (legacy/alternative format)
            if (!Object.keys(itemMeta).length && isRecord(subData?.meta)) {
              itemMeta = subData.meta as Record<string, unknown>;
            }

            console.log(
              '[OpenClawRuntime] item event: kind=' +
                itemKind +
                ' phase=' +
                itemPhase +
                ' name=' +
                itemName +
                ' title=' +
                itemTitle +
                ' toolCallId=' +
                itemToolCallId +
                ' status=' +
                itemStatus +
                ' metaRaw=' +
                metaRaw.slice(0, 100),
            );

            if (itemKind === 'tool') {
              const effectiveToolCallId = itemToolCallId || itemId;
              if (itemPhase === 'start') {
                // 工具开始执行
                const msgId = `subagent-tool-${effectiveToolCallId || Date.now()}`;

                // Extract toolInput from multiple sources:
                // 1. itemMeta.args or itemMeta.input (parsed JSON meta)
                // 2. subData.args (top-level field in item event)
                // 3. Parse meta string for announce format: "label xxx, task yyy"
                let toolInput: Record<string, unknown> = {};
                if (isRecord(itemMeta?.args)) {
                  toolInput = itemMeta.args as Record<string, unknown>;
                } else if (isRecord(itemMeta?.input)) {
                  toolInput = itemMeta.input as Record<string, unknown>;
                } else if (isRecord(subData?.args)) {
                  toolInput = subData.args as Record<string, unknown>;
                } else if (metaRaw) {
                  // Announce subagent format: "label xxx, task yyy"
                  // Extract label, task from meta string
                  const labelMatch = metaRaw.match(/label\s+([^,]+)/);
                  const taskMatch = metaRaw.match(/,\s*task\s+(.+)$/i);
                  if (labelMatch || taskMatch) {
                    if (labelMatch && labelMatch[1]) {
                      toolInput.label = labelMatch[1].trim();
                    }
                    if (taskMatch && taskMatch[1]) {
                      toolInput.task = taskMatch[1].trim();
                    }
                  }
                }

                const toolContent = `Using tool: ${itemName}\n${itemTitle}\n\nInput: ${JSON.stringify(toolInput, null, 2)}`;
                const toolMsg = {
                  role: 'tool_use',
                  content: toolContent,
                  metadata: {
                    toolName: itemName,
                    toolUseId: effectiveToolCallId,
                    toolInput,
                    status: itemStatus,
                  },
                };
                msgs.push(toolMsg);
                // Emit tool_use message
                const itemParentSessionId = this.cb.resolveSubagentParentSessionId(emitAgentId);
                if (itemParentSessionId) {
                  this.cb.emit('subagentMessage', itemParentSessionId, emitAgentId, {
                    id: msgId,
                    type: 'tool_use',
                    content: toolContent,
                    timestamp: Date.now(),
                    metadata: {
                      toolName: itemName,
                      toolUseId: effectiveToolCallId,
                      toolInput,
                      status: itemStatus,
                    },
                  });
                  // Also add to main session's store for sessions_spawn
                  if (
                    itemName === 'sessions_spawn' ||
                    itemName === 'sessions_resume' ||
                    itemName === 'sessions_read'
                  ) {
                    const mainToolUseId = effectiveToolCallId || emitAgentId;
                    if (
                      mainToolUseId &&
                      !this.cb._announceToolMessages.has(mainToolUseId + ':use')
                    ) {
                      this.cb._announceToolMessages.add(mainToolUseId + ':use');
                      // Include label/task in content for display
                      const announceLabel =
                        typeof toolInput.label === 'string' ? toolInput.label : '';
                      const announceContent = `Using tool: ${itemName}${announceLabel ? ' — ' + announceLabel : ''}`;
                      this.cb.store.addMessage(itemParentSessionId, {
                        type: 'tool_use',
                        content: announceContent,
                        metadata: {
                          toolName: itemName,
                          toolInput,
                          toolUseId: mainToolUseId,
                        },
                      });
                    }
                  }
                }

                // Track nested sessions_spawn (subagent spawning another subagent)
                // This is for nested subagent spawns that use stream=item format instead of stream=tool
                // The main sessions_spawn tracking in handleAgentToolEvent only handles stream=tool events
                if (itemName === 'sessions_spawn') {
                  const nestedArgs = isRecord(toolInput) ? toolInput : {};

                  // Extract displayLabel: prefer label, then fall back to task description
                  const taskText =
                    typeof nestedArgs.task === 'string' && nestedArgs.task
                      ? nestedArgs.task
                      : typeof nestedArgs.prompt === 'string' && nestedArgs.prompt
                        ? nestedArgs.prompt
                        : '';
                  const nestedDisplayLabel =
                    typeof nestedArgs.label === 'string' && nestedArgs.label
                      ? nestedArgs.label
                      : taskText
                        ? taskText.slice(0, 30)
                        : '';

                  // Extract promptText from args.task or args.prompt
                  let nestedPromptText = '';
                  if (typeof nestedArgs.task === 'string' && nestedArgs.task) {
                    nestedPromptText = nestedArgs.task;
                  } else if (typeof nestedArgs.prompt === 'string' && nestedArgs.prompt) {
                    nestedPromptText = nestedArgs.prompt;
                  }

                  console.log(
                    '[OpenClawRuntime] nested sessions_spawn start (stream=item): TRACKING toolCallId=' +
                      effectiveToolCallId +
                      ' parentSessionKey=' +
                      sessionKey +
                      ' displayLabel=' +
                      (nestedDisplayLabel || '(none)') +
                      ' emitAgentId=' +
                      emitAgentId +
                      ' orchestrationParentSessionId=' +
                      (this.cb.orchestrationParentSessionId || '(none)'),
                  );

                  // Set status to pending
                  this.cb.subagentStatus.set(effectiveToolCallId, 'pending');
                  this.cb.pendingToolCallIds.add(effectiveToolCallId);
                  this.cb.pendingEntryTimestamps.set(effectiveToolCallId, Date.now());

                  // Map to parent's sessionKey (temporary, will be updated when tool result arrives)
                  if (sessionKey) {
                    this.cb.toolCallIdToSessionKey.set(effectiveToolCallId, sessionKey);
                  }

                  // Extract main sessionId from sessionKey (format: agent:main:gucciai:sessionId:subagent:xxx)
                  // Or use orchestrationParentSessionId as fallback
                  const sessionIdFromKey = sessionKey?.split(':')[3];
                  const parentSessionId =
                    sessionIdFromKey || this.cb.orchestrationParentSessionId || '';
                  if (parentSessionId) {
                    this.cb.toolCallIdToParentSessionId.set(effectiveToolCallId, parentSessionId);
                  }

                  // Store display label
                  if (nestedDisplayLabel) {
                    this.cb.toolCallIdToLabel.set(effectiveToolCallId, nestedDisplayLabel);
                  }

                  // Save args for result phase
                  this.cb.toolCallArgs.set(effectiveToolCallId, {
                    ...nestedArgs,
                    _extractedPrompt: nestedPromptText,
                  });

                  // Initialize subagent messages array
                  if (!this.cb.subagentMessages.has(effectiveToolCallId)) {
                    this.cb.subagentMessages.set(effectiveToolCallId, []);
                  }

                  // Add context message if promptText exists
                  if (nestedPromptText) {
                    const nestedMsgs = this.cb.subagentMessages.get(effectiveToolCallId)!;
                    const nestedContextMsg = {
                      role: 'user',
                      content: `[Nested Subagent Context]\n\n${nestedPromptText}`,
                      metadata: {
                        isSubagentContext: true,
                        label: nestedDisplayLabel,
                      },
                    };
                    nestedMsgs.push(nestedContextMsg);
                    console.log(
                      '[OpenClawRuntime] nested sessions_spawn: added context message, key=' +
                        effectiveToolCallId +
                        ' content starts with "' +
                        nestedContextMsg.content.slice(0, 60) +
                        '" msgsLen=' +
                        nestedMsgs.length,
                    );
                  }
                }
              } else if (itemPhase === 'end') {
                // 工具执行结束
                let resultContent: string;
                const isError =
                  itemStatus === 'failed' || itemStatus === 'error' || Boolean(itemMeta?.is_error);

                // For sessions_spawn, format result nicely
                if (itemName === 'sessions_spawn' && isRecord(itemMeta?.result)) {
                  const childSessionKey =
                    typeof itemMeta.result.childSessionKey === 'string'
                      ? itemMeta.result.childSessionKey
                      : typeof itemMeta.result.sessionKey === 'string'
                        ? itemMeta.result.sessionKey
                        : '';
                  const sessionIdFromResult =
                    typeof itemMeta.result.sessionId === 'string' ? itemMeta.result.sessionId : '';

                  if (!isError && childSessionKey) {
                    resultContent = `Subagent spawned successfully.\nSession Key: ${childSessionKey}`;
                    if (sessionIdFromResult) {
                      resultContent += `\nSession ID: ${sessionIdFromResult}`;
                    }
                  } else if (isError) {
                    resultContent = `Subagent spawn failed: ${itemTitle || 'Unknown error'}`;
                  } else {
                    resultContent = JSON.stringify(itemMeta.result, null, 2);
                  }
                } else if (typeof itemMeta?.result === 'string') {
                  resultContent = itemMeta.result;
                } else if (isRecord(itemMeta?.result)) {
                  resultContent = JSON.stringify(itemMeta.result, null, 2);
                } else if (typeof itemMeta?.output === 'string') {
                  resultContent = itemMeta.output;
                } else if (typeof subData?.summary === 'string') {
                  resultContent = subData.summary;
                } else {
                  resultContent = itemTitle || 'Tool execution completed';
                }
                const resultText = isError ? `Error: ${resultContent}` : resultContent;
                const resultMsg = {
                  role: 'tool_result',
                  content: resultText,
                  metadata: {
                    toolUseId: effectiveToolCallId,
                    isError,
                    toolResult: resultContent,
                  },
                };
                msgs.push(resultMsg);
                // Emit tool_result
                const resultParentSessionId2 = this.cb.resolveSubagentParentSessionId(emitAgentId);
                if (resultParentSessionId2) {
                  this.cb.emit(
                    'subagentToolResult',
                    resultParentSessionId2,
                    emitAgentId,
                    effectiveToolCallId,
                    resultContent,
                    isError,
                  );
                  // Also add to main session's store for sessions_spawn results
                  if (
                    itemName === 'sessions_spawn' ||
                    itemName === 'sessions_resume' ||
                    itemName === 'sessions_read'
                  ) {
                    const mainToolUseId = effectiveToolCallId || emitAgentId;
                    if (
                      mainToolUseId &&
                      !this.cb._announceToolMessages.has(mainToolUseId + ':result')
                    ) {
                      this.cb._announceToolMessages.add(mainToolUseId + ':result');
                      this.cb.store.addMessage(resultParentSessionId2, {
                        type: 'tool_result',
                        content: resultText,
                        metadata: {
                          toolUseId: mainToolUseId,
                          toolName: itemName,
                          toolResult: resultContent,
                          isError,
                        },
                      });
                    }

                    // Extract childSessionKey from result meta for sessions_spawn end phase
                    if (itemName === 'sessions_spawn' && effectiveToolCallId) {
                      let childKey: string | null = null;
                      // Try itemMeta.result.childSessionKey (parsed JSON meta)
                      if (isRecord(itemMeta?.result)) {
                        childKey =
                          typeof itemMeta.result.childSessionKey === 'string'
                            ? itemMeta.result.childSessionKey
                            : null;
                      }
                      // Try itemMeta.childSessionKey
                      if (!childKey) {
                        childKey =
                          typeof itemMeta?.childSessionKey === 'string'
                            ? itemMeta.childSessionKey
                            : null;
                      }
                      // Try subData.result.childSessionKey (raw event data)
                      if (!childKey && isRecord(subData?.result)) {
                        childKey =
                          typeof subData.result.childSessionKey === 'string'
                            ? subData.result.childSessionKey
                            : null;
                      }
                      // Try subData.childSessionKey
                      if (!childKey) {
                        childKey =
                          typeof subData?.childSessionKey === 'string'
                            ? subData.childSessionKey
                            : null;
                      }

                      if (childKey) {
                        // Correct any wrong existing mappings
                        const existingToolCallId = this.cb.sessionKeyToToolCallId.get(childKey);
                        if (existingToolCallId && existingToolCallId !== effectiveToolCallId) {
                          console.log(
                            '[OpenClawRuntime] item-level sessions_spawn end: correcting wrong mapping childSessionKey=' +
                              childKey +
                              ' from=' +
                              existingToolCallId +
                              ' to=' +
                              effectiveToolCallId,
                          );
                          this.cb.subagentStatus.delete(existingToolCallId);
                          this.cb.toolCallIdToSessionKey.delete(existingToolCallId);
                          this.cb.sessionKeyToToolCallId.delete(childKey);
                        }

                        const existingSessionKey =
                          this.cb.toolCallIdToSessionKey.get(effectiveToolCallId);
                        if (existingSessionKey && existingSessionKey !== childKey) {
                          this.cb.sessionKeyToToolCallId.delete(existingSessionKey);
                        }

                        this.cb.toolCallIdToSessionKey.set(effectiveToolCallId, childKey);
                        this.cb.sessionKeyToToolCallId.set(childKey, effectiveToolCallId);

                        // Copy pending messages from toolCallId storage to sessionKey storage
                        const pendingMsgs = this.cb.subagentMessages.get(effectiveToolCallId);
                        if (pendingMsgs && pendingMsgs.length > 0) {
                          if (!this.cb.subagentMessages.has(childKey)) {
                            this.cb.subagentMessages.set(childKey, [...pendingMsgs]);
                          } else {
                            const existingMsgs = this.cb.subagentMessages.get(childKey)!;
                            for (const msg of pendingMsgs) {
                              const isDup = existingMsgs.some(
                                e =>
                                  e.role === msg.role &&
                                  (e.content === msg.content ||
                                    e.content.startsWith(msg.content) ||
                                    msg.content.startsWith(e.content)),
                              );
                              if (!isDup) {
                                existingMsgs.push(msg);
                              }
                            }
                          }
                        }

                        // Store display label from saved args
                        const savedArgs = this.cb.toolCallArgs.get(effectiveToolCallId);
                        if (savedArgs && isRecord(savedArgs)) {
                          const label =
                            typeof savedArgs.label === 'string' && savedArgs.label
                              ? savedArgs.label
                              : typeof savedArgs.agentId === 'string' && savedArgs.agentId
                                ? savedArgs.agentId
                                : null;
                          if (label) {
                            this.cb.sessionKeyToLabel.set(childKey, label);
                            this.cb.toolCallIdToLabel.set(effectiveToolCallId, label);
                            const uuidMatch = childKey.match(/subagent[:\-]([a-f0-9-]{36})$/i);
                            if (uuidMatch && uuidMatch[1]) {
                              this.cb.subagentUuidToLabel.set(uuidMatch[1], label);
                            }
                          }
                        }

                        // Extract UUID for announce completion matching
                        const uuidMatch = childKey.match(/subagent[:\-]([a-f0-9-]{36})$/i);
                        if (uuidMatch && uuidMatch[1]) {
                          this.cb.uuidToToolCallId.set(uuidMatch[1], effectiveToolCallId);
                        }

                        // Clear pending state
                        this.cb.pendingToolCallIds.delete(effectiveToolCallId);
                        this.cb.pendingEntryTimestamps.delete(effectiveToolCallId);

                        console.log(
                          '[OpenClawRuntime] item-level sessions_spawn end: established childSessionKey mapping toolCallId=' +
                            effectiveToolCallId +
                            ' childSessionKey=' +
                            childKey +
                            (uuidMatch?.[1] ? ' uuid=' + uuidMatch[1] : ''),
                        );
                      } else {
                        console.log(
                          '[OpenClawRuntime] item-level sessions_spawn end: childSessionKey not found in result, toolCallId=' +
                            effectiveToolCallId,
                        );
                      }
                    }
                  }
                }
              }
            }
            // 兼容旧数据结构: type === 'tool_use'|'tool_result'
            const itemType = typeof subData?.type === 'string' ? subData.type : '';
            const toolUseId =
              typeof subData?.tool_use_id === 'string' ? subData.tool_use_id : itemId;

            if (itemType === 'tool_use' && itemName) {
              const toolInput = isRecord(subData?.input) ? subData.input : {};
              const toolContent = `Using tool: ${itemName}\n\nInput: ${JSON.stringify(toolInput, null, 2)}`;
              msgs.push({
                role: 'tool_use',
                content: toolContent,
              });
              // Emit tool_use message
              const itemParentSessionId2 = this.cb.resolveSubagentParentSessionId(emitAgentId);
              if (itemParentSessionId2) {
                this.cb.emit('subagentMessage', itemParentSessionId2, emitAgentId, {
                  id: `subagent-item-${itemId || Date.now()}`,
                  type: 'tool_use',
                  content: toolContent,
                  timestamp: Date.now(),
                  metadata: {
                    toolName: itemName,
                    toolUseId: itemId,
                    toolInput,
                  },
                });
              }
            } else if (itemType === 'tool_result' && toolUseId) {
              const resultContent = typeof subData?.content === 'string' ? subData.content : '';
              const isError = Boolean(subData?.is_error);
              const resultText = isError ? `Error: ${resultContent}` : resultContent;
              msgs.push({
                role: 'tool_result',
                content: resultText,
              });
              // Emit tool_result
              if (this.cb.orchestrationParentSessionId) {
                this.cb.emit(
                  'subagentToolResult',
                  this.cb.orchestrationParentSessionId,
                  emitAgentId,
                  toolUseId,
                  resultContent,
                  isError,
                );
              }
            }
          } else if (stream === 'command_output') {
            // command_output 是工具执行的输出，追加到最后一个 tool_result
            const outputText = typeof subData?.text === 'string' ? subData.text : '';
            // toolCallId is in subData.toolCallId (from Gateway command_output event)
            const commandToolCallId =
              typeof subData?.toolCallId === 'string' ? subData.toolCallId : undefined;
            if (outputText) {
              const lastToolResult = msgs.filter(m => m.role === 'tool_result').pop();
              if (lastToolResult) {
                lastToolResult.content = lastToolResult.content + '\n' + outputText;
                // Emit update for tool_result content
                if (this.cb.orchestrationParentSessionId) {
                  // Use toolCallId from subData (Gateway sends it in command_output event)
                  const toolUseId =
                    commandToolCallId || (lastToolResult.metadata?.toolUseId as string | undefined);
                  if (toolUseId) {
                    this.cb.emit(
                      'subagentToolResult',
                      this.cb.orchestrationParentSessionId,
                      emitAgentId,
                      toolUseId,
                      lastToolResult.content,
                      false,
                    );
                  }
                }
              }
            }
          }
        }
      }

      // If we processed subagent events above, return early to avoid dropping them
      if (
        sessionKey &&
        (stream === 'user' ||
          stream === 'assistant' ||
          stream === 'thinking' ||
          stream === 'tool' ||
          stream === 'tools' ||
          stream === 'item' ||
          stream === 'command_output' ||
          stream === 'lifecycle')
      ) {
        // Event was handled above, no need to drop
        return;
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

    const turn = this.cb.activeTurns.get(sessionId);
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
      const mappedSessionId = this.cb.sessionIdByRunId.get(runId);
      if (mappedSessionId && mappedSessionId !== sessionId) {
        console.log(
          '[Debug:handleAgentEvent] runId mapped to different session, dropping. mapped:',
          mappedSessionId,
          'current:',
          sessionId,
        );
        return;
      }
      // OpenClaw: runId is set only at send time, events never modify turn.runId
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
      const lastSeq = this.cb.lastAgentSeqByRunId.get(runId);
      if (lastSeq !== undefined && seq <= lastSeq) {
        return;
      }
      this.cb.lastAgentSeqByRunId.set(runId, seq);
    }

    // 捕获子 Agent 事件 (stream 格式: 'assistant' | 'user' | 'tool' | 'tools' | 'item' | 'command_output')
    // sessionKey 格式: agent:${agentId}:subagent:${uuid} 或 channel:main-agent
    if (
      stream === 'assistant' ||
      stream === 'user' ||
      stream === 'tool' ||
      stream === 'tools' ||
      stream === 'item' ||
      stream === 'command_output'
    ) {
      // 从 sessionKey 中提取 agentId: agent:${agentId}:subagent:${uuid} -> ${agentId}
      const agentIdMatch = sessionKey?.match(/^agent:([^:]+):/);
      const extractedAgentId = agentIdMatch ? agentIdMatch[1] : null;

      // 使用 sessionKey → label 映射找到正确的 label
      const mappedLabel = sessionKey ? this.cb.sessionKeyToLabel.get(sessionKey) : null;
      // 优先使用映射的 label，否则使用提取的 agentId
      const storageKey = mappedLabel || extractedAgentId || sessionKey;
      // Get toolCallId for IPC emission (frontend expects toolCallId as agentId)
      // Priority: 1. direct sessionKey → toolCallId mapping
      //           2. storageKey → toolCallId mapping
      //           3. label → toolCallId mapping (if we have mappedLabel)
      //           4. reverse lookup from parent session
      //           5. pending toolCallIds check (for events before sessionKey mapping established)
      let emitAgentId =
        (sessionKey ? this.cb.sessionKeyToToolCallId.get(sessionKey) : undefined) ||
        (storageKey ? this.cb.sessionKeyToToolCallId.get(storageKey) : undefined) ||
        '';
      if (!emitAgentId) {
        emitAgentId = storageKey || '';
        console.log(
          '[OpenClawRuntime] emitAgentId final fallback: using storageKey=' + emitAgentId,
        );
      }

      console.log(
        '[OpenClawRuntime] emitAgentId result: sessionKey=' +
          (sessionKey || '(none)') +
          ' storageKey=' +
          (storageKey || '(none)') +
          ' emitAgentId=' +
          emitAgentId +
          ' sessionKeyToToolCallId=' +
          JSON.stringify(Array.from(this.cb.sessionKeyToToolCallId.entries()).slice(0, 5)),
      );

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
            ' emitAgentId=' +
            emitAgentId +
            ' stream=' +
            stream,
        );
      }

      // 只处理 subagent sessionKey（格式: agent:*:subagent:*）
      // 使用直接匹配而非排除逻辑，更健壮且能处理未来边缘情况
      if (sessionKey?.includes(':subagent:')) {
        if (!this.cb.subagentMessages.has(storageKey)) {
          this.cb.subagentMessages.set(storageKey, []);
        }
        const msgs = this.cb.subagentMessages.get(storageKey)!;
        const subData = isRecord(agentPayload.data)
          ? (agentPayload.data as Record<string, unknown>)
          : null;
        const eventText = typeof subData?.text === 'string' ? subData.text : '';

        if ((stream === 'assistant' || stream === 'user') && eventText.length > 0) {
          const role = stream;

          // Check for truncated NO_REPLY markers (OpenClaw special marker)
          // When detected, query chat.history to get complete text before showing
          if (role === 'assistant') {
            const trimmedEventText = eventText.trim();
            const NO_REPLY_MARKER = 'NO_REPLY';
            const isFullNoReply = /^NO_REPLY$/i.test(trimmedEventText);
            if (isFullNoReply) {
              return;
            }
            const isPossibleNoReply =
              trimmedEventText.length <= NO_REPLY_MARKER.length &&
              NO_REPLY_MARKER.startsWith(trimmedEventText) &&
              trimmedEventText.length > 0;

            if (isPossibleNoReply) {
              // Possible truncated prefix - query history to resolve
              if (emitAgentId && this._gatewayClient) {
                console.log(
                  '[OpenClawRuntime] subagent assistant (sessionId): possible truncated NO_REPLY="' +
                    trimmedEventText +
                    '", syncing with history',
                );
                void this.cb.subagentManager.syncSubagentNoReply(
                  storageKey,
                  emitAgentId,
                  sessionKey,
                  msgs,
                  trimmedEventText,
                );
              }
              return;
            }
          }

          const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          if (lastMsg && lastMsg.role === role) {
            if (
              eventText.length >= lastMsg.content.length &&
              eventText.startsWith(lastMsg.content)
            ) {
              lastMsg.content = eventText;
              // Emit update event
              if (this.cb.orchestrationParentSessionId && emitAgentId) {
                this.cb.emit(
                  'subagentMessageUpdate',
                  this.cb.orchestrationParentSessionId,
                  emitAgentId,
                  `subagent-${role}-${Date.now()}`,
                  eventText,
                );
              }
            } else if (!lastMsg.content.startsWith(eventText)) {
              const newMsg = { role, content: eventText };
              msgs.push(newMsg);
              // Emit new message event
              const sessParentId1 = this.cb.resolveSubagentParentSessionId(emitAgentId);
              if (sessParentId1 && emitAgentId) {
                this.cb.emit('subagentMessage', sessParentId1, emitAgentId, {
                  id: `subagent-${role}-${Date.now()}-${msgs.length}`,
                  type: role,
                  content: eventText,
                  timestamp: Date.now(),
                });
              }
            }
          } else {
            const newMsg = { role, content: eventText };
            msgs.push(newMsg);
            // Emit new message event
            const sessParentId2 = this.cb.resolveSubagentParentSessionId(emitAgentId);
            if (sessParentId2 && emitAgentId) {
              this.cb.emit('subagentMessage', sessParentId2, emitAgentId, {
                id: `subagent-${role}-${Date.now()}-${msgs.length}`,
                type: role,
                content: eventText,
                timestamp: Date.now(),
              });
            }
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
              const toolCallId = typeof subData?.toolCallId === 'string' ? subData.toolCallId : '';
              const toolMsg = {
                role: 'tool_use',
                content: toolSummary,
                metadata: {
                  toolName,
                  toolUseId: toolCallId,
                  toolInput: subData.args,
                },
              };
              msgs.push(toolMsg);
              // Emit tool_use message
              const toolParentSessionId3 = this.cb.resolveSubagentParentSessionId(emitAgentId);
              if (toolParentSessionId3 && emitAgentId) {
                this.cb.emit('subagentMessage', toolParentSessionId3, emitAgentId, {
                  id: `subagent-tool-${toolCallId || Date.now()}`,
                  type: 'tool_use',
                  content: toolSummary,
                  timestamp: Date.now(),
                  metadata: {
                    toolName,
                    toolUseId: toolCallId,
                    toolInput: subData.args,
                  },
                });
              }
            }
          }
        } else if (stream === 'item') {
          // item stream: tool execution details
          // Data structure: { itemId, phase: 'start'|'update'|'end', kind: 'tool'|'command', title, status, name, meta (string), toolCallId }
          if (subData) {
            const itemKind = typeof subData.kind === 'string' ? subData.kind : '';
            const itemPhase = typeof subData.phase === 'string' ? subData.phase : '';
            const itemId = typeof subData.itemId === 'string' ? subData.itemId : '';
            const itemName = typeof subData.name === 'string' ? subData.name : '';
            const itemStatus = typeof subData.status === 'string' ? subData.status : '';
            const itemTitle = typeof subData.title === 'string' ? subData.title : '';
            const itemToolCallId =
              typeof subData.toolCallId === 'string' ? subData.toolCallId : itemId;
            // meta is a string in OpenClaw AgentItemEventData, parse it as JSON if possible
            const metaRaw = typeof subData.meta === 'string' ? subData.meta : '';
            let itemMeta: Record<string, unknown> = {};
            if (metaRaw) {
              try {
                itemMeta = JSON.parse(metaRaw) as Record<string, unknown>;
              } catch {
                // meta may not be JSON, ignore
              }
            }
            if (!Object.keys(itemMeta).length && isRecord(subData.meta)) {
              itemMeta = subData.meta as Record<string, unknown>;
            }

            console.log(
              '[OpenClawRuntime] subagent item event (with sessionId): kind=' +
                itemKind +
                ' phase=' +
                itemPhase +
                ' name=' +
                itemName +
                ' title=' +
                itemTitle +
                ' toolCallId=' +
                itemToolCallId +
                ' status=' +
                itemStatus,
            );

            if (itemKind === 'tool') {
              const effectiveToolCallId = itemToolCallId || itemId;
              if (itemPhase === 'start') {
                const msgId = `subagent-tool-${effectiveToolCallId || Date.now()}`;
                const toolInput = isRecord(itemMeta?.args)
                  ? itemMeta.args
                  : isRecord(itemMeta?.input)
                    ? itemMeta.input
                    : {};
                const toolContent = `Using tool: ${itemName}\n${itemTitle}\n\nInput: ${JSON.stringify(toolInput, null, 2)}`;
                const toolMsg = {
                  role: 'tool_use',
                  content: toolContent,
                  metadata: {
                    toolName: itemName,
                    toolUseId: effectiveToolCallId,
                    toolInput,
                    status: itemStatus,
                  },
                };
                msgs.push(toolMsg);
                const itemParentSessionId4 = this.cb.resolveSubagentParentSessionId(emitAgentId);
                if (itemParentSessionId4 && emitAgentId) {
                  this.cb.emit('subagentMessage', itemParentSessionId4, emitAgentId, {
                    id: msgId,
                    type: 'tool_use',
                    content: toolContent,
                    timestamp: Date.now(),
                    metadata: {
                      toolName: itemName,
                      toolUseId: effectiveToolCallId,
                      toolInput,
                      status: itemStatus,
                    },
                  });
                }
              } else if (itemPhase === 'end') {
                const resultContent =
                  typeof itemMeta?.result === 'string'
                    ? itemMeta.result
                    : typeof itemMeta?.output === 'string'
                      ? itemMeta.output
                      : typeof subData.summary === 'string'
                        ? subData.summary
                        : itemTitle;
                const isError =
                  itemStatus === 'failed' || itemStatus === 'error' || Boolean(itemMeta?.is_error);
                const resultText = isError ? `Error: ${resultContent}` : resultContent;
                const resultMsg = {
                  role: 'tool_result',
                  content: resultText,
                  metadata: {
                    toolUseId: effectiveToolCallId,
                    isError,
                    toolResult: resultContent,
                  },
                };
                msgs.push(resultMsg);
                if (this.cb.orchestrationParentSessionId && emitAgentId) {
                  this.cb.emit(
                    'subagentToolResult',
                    this.cb.orchestrationParentSessionId,
                    emitAgentId,
                    effectiveToolCallId,
                    resultContent,
                    isError,
                  );
                }
              }
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

    // Extract sessionKey from payload for lifecycle events
    let sessionKey =
      typeof agentPayload.sessionKey === 'string'
        ? agentPayload.sessionKey.trim()
        : typeof (agentPayload as Record<string, unknown>).session === 'string'
          ? ((agentPayload as Record<string, unknown>).session as string).trim()
          : '';
    // Normalize subagent sessionKey: if it starts with 'subagent:', add 'agent:main:' prefix
    if (sessionKey && sessionKey.startsWith('subagent:') && !sessionKey.startsWith('agent:')) {
      sessionKey = 'agent:main:' + sessionKey;
    }

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

    // Handle stream=item events by converting to gateway format and routing
    // through handleAgentToolEvent. This unifies sessions_spawn handling.
    if (stream === 'item') {
      const subData = isRecord(agentPayload.data)
        ? (agentPayload.data as Record<string, unknown>)
        : null;
      if (subData) {
        const itemKind = typeof subData.kind === 'string' ? subData.kind : '';
        const itemPhase = typeof subData.phase === 'string' ? subData.phase : '';
        const itemName = typeof subData.name === 'string' ? subData.name : '';
        const itemToolCallId = typeof subData.toolCallId === 'string' ? subData.toolCallId : '';

        if (itemKind === 'tool' && itemToolCallId) {
          // Convert stream=item format to gateway format for handleAgentToolEvent
          // item: { kind:'tool', phase:'start', name:'sessions_spawn', toolCallId:'call_xxx', meta:'{"args":{...}}' }
          // gateway: { tool:'start:sessions_spawn', call:'call_xxx', meta:'...', args:{...} }

          // Parse meta JSON to extract args
          let itemArgs: Record<string, unknown> | undefined;
          const metaRaw = typeof subData.meta === 'string' ? subData.meta : '';
          if (metaRaw) {
            try {
              const parsed = JSON.parse(metaRaw) as Record<string, unknown>;
              if (isRecord(parsed.args)) {
                itemArgs = parsed.args as Record<string, unknown>;
              }
            } catch {
              /* meta may not be JSON, ignore */
            }
          }
          // Fallback: check if args is already a separate field
          if (!itemArgs && isRecord(subData.args)) {
            itemArgs = subData.args as Record<string, unknown>;
          }

          const mappedPhase = itemPhase === 'end' ? 'result' : itemPhase;
          const gatewayData: Record<string, unknown> = {
            tool: `${mappedPhase}:${itemName}`,
            call: itemToolCallId,
            meta: typeof subData.meta === 'string' ? subData.meta : '',
            args: itemArgs,
            result: subData.result,
            isError: subData.isError,
          };
          this.cb.handleAgentToolEvent(sessionId, turn, gatewayData);
        }
      }
    }

    // Process tool events directly — no buffering for announce runIds.
    const isToolStream = stream === 'tool' || stream === 'tools' || (!stream && hasToolShape);

    if (isToolStream) {
      // Gateway format check: tool events may have 'tool', 'call', 'meta' directly in payload
      // (not nested in 'data'). Example: { stream: 'tool', tool: 'result:sessions_spawn', call: 'xxx', meta: 'label xxx' }
      // Also check for session.tool gateway format where data carries { tool, call, meta }
      const hasGatewayToolShape =
        typeof (agentPayload as Record<string, unknown>).tool === 'string' ||
        (isRecord(agentPayload.data) &&
          typeof (agentPayload.data as Record<string, unknown>).tool === 'string');

      if (Array.isArray(agentPayload.data)) {
        for (const entry of agentPayload.data) {
          this.cb.handleAgentToolEvent(sessionId, turn, entry);
        }
      } else if (hasGatewayToolShape) {
        // Gateway format: pass entire payload (contains tool, call, meta)
        this.cb.handleAgentToolEvent(sessionId, turn, agentPayload);
      } else {
        this.cb.handleAgentToolEvent(sessionId, turn, agentPayload.data);
      }
      return;
    }

    if (stream === 'lifecycle') {
      this.handleAgentLifecycleEvent(sessionId, sessionKey, agentPayload.data);
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

    const queued = this.cb.pendingAgentEventsByRunId.get(normalizedRunId) ?? [];
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
    this.cb.pendingAgentEventsByRunId.set(normalizedRunId, queued);

    if (this.cb.pendingAgentEventsByRunId.size > 400) {
      const oldestRunId = this.cb.pendingAgentEventsByRunId.keys().next().value as
        | string
        | undefined;
      if (oldestRunId) {
        this.cb.pendingAgentEventsByRunId.delete(oldestRunId);
      }
    }
  }

  flushPendingAgentEvents(sessionId: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;

    const queued = this.cb.pendingAgentEventsByRunId.get(normalizedRunId);
    if (!queued || queued.length === 0) return;
    this.cb.pendingAgentEventsByRunId.delete(normalizedRunId);

    const turn = this.cb.activeTurns.get(sessionId);
    if (!turn) return;

    for (const event of queued) {
      this.dispatchAgentEvent(sessionId, turn, event);
    }
  }

  rememberSessionKey(sessionId: string, sessionKey: string): void {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    this.cb.sessionIdBySessionKey.set(normalizedSessionKey, sessionId);
  }

  resolveSessionIdBySessionKey(sessionKey: string): string | null {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return null;

    const mappedSessionId = this.cb.sessionIdBySessionKey.get(normalizedSessionKey);
    if (mappedSessionId) {
      return mappedSessionId;
    }

    const parsedManagedSession = parseManagedSessionKey(normalizedSessionKey);
    if (!parsedManagedSession) {
      return null;
    }

    const session = this.cb.store.getSession(parsedManagedSession.sessionId);
    if (!session) {
      return null;
    }

    this.rememberSessionKey(session.id, normalizedSessionKey);
    this.rememberSessionKey(session.id, this.cb.toSessionKey(session.id, session.agentId));
    return session.id;
  }

  nextTurnToken(sessionId: string): number {
    const nextToken = (this.cb.latestTurnTokenBySession.get(sessionId) ?? 0) + 1;
    this.cb.latestTurnTokenBySession.set(sessionId, nextToken);
    return nextToken;
  }

  isCurrentTurnToken(sessionId: string, turnToken: number): boolean {
    return (this.cb.latestTurnTokenBySession.get(sessionId) ?? 0) === turnToken;
  }

  reuseFinalAssistantMessage(sessionId: string, content: string): string | null {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return null;
    }

    const session = this.cb.store.getSession(sessionId);
    const lastMessage = session?.messages[session.messages.length - 1];
    if (!lastMessage || lastMessage.type !== 'assistant') {
      return null;
    }
    if (lastMessage.content.trim() !== normalizedContent) {
      return null;
    }

    this.cb.store.updateMessage(sessionId, lastMessage.id, {
      content,
      metadata: {
        isStreaming: false,
        isFinal: true,
      },
    });
    return lastMessage.id;
  }

  private handleAgentLifecycleEvent(sessionId: string, sessionKey: string, data: unknown): void {
    if (!isRecord(data)) return;
    const phase = typeof data.phase === 'string' ? data.phase.trim() : '';

    // 捕获子 Agent 生命周期事件
    // Use sessionKey to find toolCallId (unique), NOT agentId/label (not unique across sessions)
    const agentId = typeof data.agentId === 'string' ? data.agentId : undefined;
    const isMainAgent = !agentId || agentId === 'main-agent';

    if (!isMainAgent && sessionKey) {
      // Normalize sessionKey: if it starts with 'subagent:', add 'agent:main:' prefix
      let normalizedSessionKey = sessionKey;
      if (sessionKey.startsWith('subagent:') && !sessionKey.startsWith('agent:')) {
        normalizedSessionKey = 'agent:main:' + sessionKey;
      }

      // Try to find toolCallId by sessionKey (unique identifier)
      let toolCallId = this.cb.sessionKeyToToolCallId.get(normalizedSessionKey);

      // Fallback 1: Try with 'subagent:' short prefix (gateway might use short format)
      if (!toolCallId && normalizedSessionKey.startsWith('agent:main:subagent:')) {
        const shortSessionKey = normalizedSessionKey.slice('agent:main:'.length);
        toolCallId = this.cb.sessionKeyToToolCallId.get(shortSessionKey);
      }

      // Fallback 2: Extract UUID from sessionKey and search subagentStatus keys
      if (!toolCallId && normalizedSessionKey.includes(':subagent:')) {
        const uuidPart = normalizedSessionKey.split(':subagent:')[1];
        if (uuidPart) {
          for (const [key, _status] of this.cb.subagentStatus) {
            if (key === uuidPart || key.includes(uuidPart)) {
              toolCallId = key;
              // Establish mapping for future lookups
              this.cb.sessionKeyToToolCallId.set(normalizedSessionKey, toolCallId);
              this.cb.toolCallIdToSessionKey.set(toolCallId, normalizedSessionKey);
              break;
            }
          }
        }
      }

      // Fallback 3: For end/completed/stopped phases, try to find any unmapped
      // running subagent — the most likely candidate for a completion event.
      if (!toolCallId && (phase === 'end' || phase === 'completed' || phase === 'stopped')) {
        for (const [key, status] of this.cb.subagentStatus) {
          if (status === 'running' && !this.cb.sessionKeyToToolCallId.has(normalizedSessionKey)) {
            // Verify this key isn't already mapped to a different sessionKey
            const mappedKey = this.cb.toolCallIdToSessionKey.get(key);
            if (!mappedKey || mappedKey === normalizedSessionKey) {
              toolCallId = key;
              this.cb.sessionKeyToToolCallId.set(normalizedSessionKey, toolCallId);
              this.cb.toolCallIdToSessionKey.set(toolCallId, normalizedSessionKey);
              console.log(
                '[OpenClawRuntime] subagent lifecycle: fallback matched running toolCallId=' +
                  toolCallId +
                  ' to sessionKey=' +
                  normalizedSessionKey +
                  ' phase=' +
                  phase,
              );
              break;
            }
          }
        }
      }

      if (toolCallId) {
        // Update status using toolCallId as key (unique)
        if (phase === 'start' || phase === 'running') {
          // Never overwrite 'done' — a completed subagent stays completed
          const existingStatus = this.cb.subagentStatus.get(toolCallId);
          if (existingStatus !== 'done') {
            this.cb.subagentStatus.set(toolCallId, 'running');
          }
        } else if (
          phase === 'end' ||
          phase === 'completed' ||
          phase === 'stopped' ||
          phase === 'error'
        ) {
          this.cb.subagentStatus.set(toolCallId, 'done');
          this.cb.subagentManager.persistSubagentStatus(toolCallId, 'done');
          if (phase !== 'error') {
            this.cb.subagentManager.checkAllSubagentsDone();
          }
        }
      }
    }

    // Main agent lifecycle events control session status
    // Only set status on lifecycle start to ensure running state when main agent begins.
    // Do NOT set 'completed' on lifecycle end - let handleChatFinal decide the final status.
    // This prevents status flicker (lifecycle end -> completed -> chat final -> running)
    // when main agent has follow-up runs after processing subagent results.
    if (isMainAgent && phase === 'start') {
      this.cb.store.updateSession(sessionId, { status: 'running' });
      this.cb.mainAgentLifecycleEnded = false;
      this.cb.subagentManager.setMainAgentLifecycleEnded(false);
    }
    if (isMainAgent && phase === 'end') {
      this.cb.mainAgentLifecycleEnded = true;
      this.cb.subagentManager.setMainAgentLifecycleEnded(true);
      // Check if all subagents are already done. If so, finalize immediately.
      // If not, checkAllSubagentsDone will handle it when subagents complete.
      // This also covers the case where the last chat event comes from a different
      // runId (subagent announce) and returns early without calling handleChatFinal.
      this.cb.subagentManager.checkAllSubagentsDone();
    }
  }

  finalizeThinkingMessage(
    sessionId: string,
    messageId: string,
    finalThinkingContent?: string,
  ): void {
    const session = this.cb.store.getSession(sessionId);
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

    this.cb.store.updateMessage(sessionId, messageId, updates);
    // Emit metadata update so UI reflects the finalized state (isStreaming: false)
    this.cb.emit('messageMetadataUpdate', sessionId, messageId, newMetadata);
  }

  handleAgentThinkingEvent(sessionId: string, turn: ActiveTurn, data: unknown): void {
    if (!isRecord(data)) return;

    const text = typeof data.text === 'string' ? data.text : '';
    const delta = typeof data.delta === 'string' ? data.delta : '';

    // If thinking stream was previously ended (tool event received), reset state
    // to create a new thinking message for the subsequent thinking events
    // Also reset assistantMessageId so the next assistant stream creates a new text message
    if (turn.thinkingStreamEnded) {
      turn.currentThinkingMessageId = null;
      turn.currentThinkingContent = '';
      turn.thinkingStreamEnded = false;
      // Reset assistantMessageId to null so next assistant stream creates new message
      // instead of continuing to write to the previous text message
      turn.assistantMessageId = null;
      // Reset segment text tracking for the new response segment
      turn.currentAssistantSegmentText = '';
      turn.agentAssistantTextLength = 0;
      // Reset committedAssistantText and currentText so chat delta events
      // for the new assistant segment don't get confused with old content
      turn.committedAssistantText = '';
      turn.currentText = '';
      turn.currentContentText = '';
      turn.currentContentBlocks = [];
      turn.textStreamMode = 'unknown';
    }

    // First thinking event: create the assistant message if not exists
    if (!turn.currentThinkingMessageId) {
      // If we already have an assistantMessageId, check if it's a thinking message
      // Only reuse it if it's specifically a thinking message (isThinking: true)
      // Otherwise, create a new message to avoid mixing thinking content with text content
      if (turn.assistantMessageId) {
        const session = this.cb.store.getSession(sessionId);
        const existingMsg = session?.messages.find(m => m.id === turn.assistantMessageId);
        const isThinkingMsg = existingMsg?.metadata?.isThinking === true;

        if (isThinkingMsg) {
          // Reuse the existing thinking message
          turn.currentThinkingMessageId = turn.assistantMessageId;
        } else {
          // Existing message is a text message, create a new thinking message
          const initialThinkingContent = text || delta || '';
          const thinkingMessage = this.cb.store.addMessage(sessionId, {
            type: 'assistant',
            content: '',
            metadata: { isStreaming: true, isThinking: true },
            thinkingContent: initialThinkingContent,
            modelName: turn.modelName,
          });
          turn.currentThinkingMessageId = thinkingMessage.id;
          // Don't update assistantMessageId - keep it for the text message
          // Initialize turn state with the first text/delta content
          turn.currentThinkingContent = initialThinkingContent;
          this.cb.emit('message', sessionId, thinkingMessage);
          // Return early to skip the update logic below - the initial content is already set
          return;
        }
      } else {
        // Use store.addMessage to create message - it generates its own ID
        // Set initial thinkingContent to the actual content from this event
        // OpenClaw's emitReasoningStream only sends events when text.trim() is non-empty,
        // so the first event should always have content
        const initialThinkingContent = text || delta || '';
        const thinkingMessage = this.cb.store.addMessage(sessionId, {
          type: 'assistant',
          content: '',
          metadata: { isStreaming: true, isThinking: true },
          thinkingContent: initialThinkingContent,
          modelName: turn.modelName,
        });
        turn.currentThinkingMessageId = thinkingMessage.id;
        // IMPORTANT: Do NOT set assistantMessageId to thinking message id
        // This prevents text content from being written to the thinking message
        // Instead, keep assistantMessageId null so text creates a separate message
        // turn.assistantMessageId = thinkingMessage.id; // REMOVED
        // Initialize turn state with the first text/delta content
        turn.currentThinkingContent = initialThinkingContent;
        this.cb.emit('message', sessionId, thinkingMessage);
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
      this.cb.emit('thinkingUpdate', sessionId, messageId, actualDelta);
    }
  }
}
