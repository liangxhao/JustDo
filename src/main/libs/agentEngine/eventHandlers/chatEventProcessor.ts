import { BrowserWindow } from 'electron';
import type { CoworkStore } from '../../../coworkStore';
import { t } from '../../../i18n';
import {
  isRecord,
  summarizeGatewayMessageShape,
  extractMessageText,
  extractThinkingContent,
  extractCurrentTurnAssistantText,
  extractTextBlocksAndSignals,
  isDroppedBoundaryTextBlockSubset,
  mergeStreamingText,
  generateStableMessageId,
  truncate,
} from '../utils/gatewayHelpers';
import { extractOpenClawAssistantStreamText } from '../../openclawAssistantText';
import type { GatewayClientLike, ChatEventPayload, ActiveTurn } from '../gateway/types';
import type { HistoryReconciler } from '../history/historyReconciler';
import type { SubagentManager } from '../subagent/subagentManager';

export interface ChatEventProcessorCallbacks {
  _announceToolMessages: Set<string>;
  _loggedThinkingStreamTypes: Set<string>;
  activeTurns: Map<string, ActiveTurn>;
  announceTextByRunId: Map<string, string>;
  cleanupSessionTurn: (sessionId: string) => void;
  clearPendingMessageUpdate: (messageId: string) => void;
  emit: (event: string, ...args: unknown[]) => void;
  ensureActiveTurn: (sessionId: string, sessionKey: string, runId: string) => void;
  finalizeThinkingMessage: (sessionId: string, messageId: string, content: string) => void;
  gatewayClient: GatewayClientLike | null;
  handleAgentThinkingEvent: (sessionId: string, turn: ActiveTurn, data: unknown) => void;
  heartbeatSessionKeys: Set<string>;
  historyReconciler: HistoryReconciler;
  lastChatSeqByRunId: Map<string, number>;
  manuallyStoppedSessions: Set<string>;
  pendingEntryTimestamps: Map<string, number>;
  pendingToolCallIds: Set<string>;
  processedAnnounceRunIds: Set<string>;
  rejectTurn: (sessionId: string, error: Error) => void;
  rememberSessionKey: (sessionId: string, sessionKey: string) => void;
  resolveSessionIdBySessionKey: (sessionKey: string) => string | null;
  resolveSessionIdFromChatPayload: (payload: ChatEventPayload) => string | null;
  resolveTurn: (sessionId: string) => void;
  reuseFinalAssistantMessage: (sessionId: string, content: string) => string | null;
  sessionIdByRunId: Map<string, string>;
  sessionKeyToToolCallId: Map<string, string>;
  store: CoworkStore;
  subagentManager: SubagentManager;
  subagentMessages: Map<
    string,
    Array<{ role: string; content: string; metadata?: Record<string, unknown> }>
  >;
  subagentStatus: Map<string, string>;
  subagentThinkingByRunId: Map<string, string>;
  throttledEmitMessageUpdate: (sessionId: string, messageId: string, content: string) => void;
  toolCallIdToParentSessionId: Map<string, string>;
  uuidToToolCallId: Map<string, string>;
  /** Mark session as pending subagent completion (prevent turn re-creation) */
  markPendingSubagentCompletion: (sessionId: string) => void;
  /** Clear pending subagent completion marker when session completes */
  clearPendingSubagentCompletion: (sessionId: string) => void;
}

export class ChatEventProcessor {
  private readonly cb: ChatEventProcessorCallbacks;
  private _channelSessionSync:
    | import('../../openclawChannelSessionSync').OpenClawChannelSessionSync
    | null = null;
  private _gatewayClient: GatewayClientLike | null = null;

  constructor(cb: ChatEventProcessorCallbacks) {
    this.cb = cb;
  }

  setChannelSessionSync(
    sync: import('../../openclawChannelSessionSync').OpenClawChannelSessionSync | null,
  ): void {
    this._channelSessionSync = sync;
  }

  setGatewayClient(client: GatewayClientLike | null): void {
    this._gatewayClient = client;
  }

  handleChatEvent(payload: unknown, seq?: number): void {
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

    const sessionId = this.cb.resolveSessionIdFromChatPayload(chatPayload);
    if (!sessionId) {
      console.log('[Debug:handleChatEvent] no sessionId resolved, dropping event');
      return;
    }

    const turn = this.cb.activeTurns.get(sessionId);
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
    // Debug logging for runId diagnosis (after runId is declared)
    console.debug(
      '[Debug:handleChatEvent] turn found, sessionId:',
      sessionId,
      'turn.runId:',
      turn.runId,
      'event.runId:',
      runId,
      'state:',
      state,
    );
    if (typeof seq === 'number' && Number.isFinite(seq) && runId) {
      const lastSeq = this.cb.lastChatSeqByRunId.get(runId);
      if (lastSeq !== undefined && seq <= lastSeq) {
        return;
      }
      this.cb.lastChatSeqByRunId.set(runId, seq);
    }

    // Handle chat events from a different runId (e.g., sub-agent announce while main agent is running).
    // This mimics OpenClaw webchat behavior: skip deltas, add final messages without affecting current streaming state.
    // Reference: openclaw/ui/src/ui/controllers/chat.ts handleChatEvent
    if (runId && turn.runId && runId !== turn.runId) {
      console.debug(
        '[OpenClawRuntime] handleChatEvent: different runId detected, runId=' +
          runId +
          ' turn.runId=' +
          turn.runId +
          ' state=' +
          state,
      );
      if (state === 'delta') {
        // Accumulate delta text from different runId (announce subagent)
        // so the UI streams announce text progressively instead of waiting
        // for the final event. Matches openclaw webchat chatStream behavior.
        const deltaMessage = chatPayload.message;
        if (deltaMessage && isRecord(deltaMessage)) {
          const role = typeof deltaMessage.role === 'string' ? deltaMessage.role.toLowerCase() : '';
          if (role === 'assistant') {
            const deltaText = extractMessageText(deltaMessage);
            if (deltaText && deltaText.trim()) {
              this.cb.announceTextByRunId.set(runId, deltaText.trim());
            }
          }
        }
        return;
      }
      if (state === 'final') {
        // For final events from different runId, just add the message without modifying turn state
        // This prevents duplicate messages when main agent yields/resumes during subagent waits

        // Deduplication: skip if this runId's final was already processed
        if (this.cb.processedAnnounceRunIds.has(runId)) {
          console.debug(
            '[OpenClawRuntime] handleChatEvent: skipping already-processed announce runId final, runId=' +
              runId.slice(0, 20),
          );
          return;
        }
        this.cb.processedAnnounceRunIds.add(runId);

        // Flush accumulated announce streaming text as a message before
        // processing the final. This ensures partial text from delta events
        // is visible in the UI.
        // Check _announceToolMessages to avoid emitting text already emitted at tool_start.
        const accumulatedText = this.cb.announceTextByRunId.get(runId);
        let alreadyEmittedAnnounceText = false;
        let announceStreamingMessageId: string | null = null;
        if (accumulatedText && accumulatedText.length > 0) {
          // Find the marker for what was already emitted at tool_start
          const markerKey = `${runId}:`;
          console.log(
            '[OpenClawRuntime] handleChatEvent: searching for marker, markerKey=' +
              markerKey.slice(0, 35) +
              ' _announceToolMessages size=' +
              this.cb._announceToolMessages.size +
              ' contents=[' +
              Array.from(this.cb._announceToolMessages)
                .map(m => m.slice(0, 40))
                .join(', ') +
              ']',
          );
          let alreadyEmittedLen = 0;
          for (const marker of this.cb._announceToolMessages) {
            if (marker.startsWith(markerKey)) {
              alreadyEmittedLen = parseInt(marker.slice(markerKey.length), 10);
              console.log(
                '[OpenClawRuntime] handleChatEvent: FOUND marker=' +
                  marker.slice(0, 35) +
                  ' alreadyEmittedLen=' +
                  alreadyEmittedLen,
              );
              break;
            }
          }
          // Check for truncated NO_REPLY before emitting accumulated text.
          // OpenClaw gateway may stream "NO" or "NO_RE" before completing "NO_REPLY".
          // We must detect and defer emission until confirmed via history sync.
          const NO_REPLY_MARKER = 'NO_REPLY';
          const accumulatedTrimmed = accumulatedText.trim();
          const isAccumulatedFullNoReply = /^NO_REPLY$/i.test(accumulatedTrimmed);
          const isAccumulatedTruncatedNoReply =
            accumulatedTrimmed.length > 0 &&
            accumulatedTrimmed.length <= NO_REPLY_MARKER.length &&
            NO_REPLY_MARKER.startsWith(accumulatedTrimmed.toUpperCase()) &&
            !isAccumulatedFullNoReply;

          // Only emit if there's new text beyond what was already emitted
          // AND it's not a possible truncated NO_REPLY marker
          if (accumulatedText.length > alreadyEmittedLen) {
            if (isAccumulatedTruncatedNoReply || isAccumulatedFullNoReply) {
              // Don't emit possible truncated NO_REPLY - will be resolved later via history sync
              console.log(
                '[OpenClawRuntime] handleChatEvent: skipping accumulated text - possible truncated NO_REPLY="' +
                  accumulatedTrimmed +
                  '"',
              );
              alreadyEmittedAnnounceText = false;
            } else {
              const newText = accumulatedText.slice(alreadyEmittedLen);
              const streamingMessage = this.cb.store.addMessage(sessionId, {
                type: 'assistant',
                content: newText,
                metadata: { isStreaming: false, isFinal: true },
                modelName: turn.modelName,
              });
              this.cb.emit('message', sessionId, streamingMessage);
              announceStreamingMessageId = streamingMessage.id;
              alreadyEmittedAnnounceText = true;
              console.log(
                '[OpenClawRuntime] handleChatEvent: emitted NEW announce text (len=' +
                  newText.length +
                  ', total=' +
                  accumulatedText.length +
                  ', already=' +
                  alreadyEmittedLen +
                  ') from accumulated deltas for runId=' +
                  runId.slice(0, 20),
              );
            }
          } else {
            // All accumulated text was already emitted at tool_start
            console.log(
              '[OpenClawRuntime] handleChatEvent: announce text already handled at tool_start, skipping (total=' +
                accumulatedText.length +
                ', already=' +
                alreadyEmittedLen +
                ') runId=' +
                runId.slice(0, 20),
            );
            alreadyEmittedAnnounceText = true;
          }
        }
        // Clean up the marker and map after final processing
        if (accumulatedText && accumulatedText.length > 0) {
          const markerKey = `${runId}:`;
          for (const marker of this.cb._announceToolMessages) {
            if (marker.startsWith(markerKey)) {
              this.cb._announceToolMessages.delete(marker);
              console.log(
                '[OpenClawRuntime] handleChatEvent: DELETED marker=' +
                  marker.slice(0, 40) +
                  ' from _announceToolMessages after final, setSize=' +
                  this.cb._announceToolMessages.size,
              );
              break;
            }
          }
        }
        this.cb.announceTextByRunId.delete(runId);

        const finalMessage = chatPayload.message;
        if (finalMessage && isRecord(finalMessage)) {
          const role = typeof finalMessage.role === 'string' ? finalMessage.role.toLowerCase() : '';
          if (role === 'assistant') {
            const text = extractMessageText(finalMessage).trim();
            // Combine thinking from the final message blocks with accumulated
            // thinking from subagent announce runs (streamed via separate events).
            let thinking = extractThinkingContent(finalMessage);
            const subagentThinking = this.cb.subagentThinkingByRunId.get(runId);
            if (subagentThinking) {
              thinking = thinking ? thinking + '\n' + subagentThinking : subagentThinking;
            }
            this.cb.subagentThinkingByRunId.delete(runId);

            // If a streaming message was already emitted (from accumulated deltas),
            // update it with thinking content now that we have it from the final.
            // The messageUpdate IPC only carries text content, so we also notify
            // the renderer to re-read the session (which includes thinkingContent).
            if (announceStreamingMessageId && thinking) {
              this.cb.store.updateMessage(sessionId, announceStreamingMessageId, {
                thinkingContent: thinking,
              });
              for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) {
                  win.webContents.send('cowork:sessions:changed');
                }
              }
            }
            // Skip silent replies (NO_REPLY) — also handle truncated versions
            // that OpenClaw gateway may produce during streaming (e.g. "NO", "NO_RE").
            // For truncated prefixes, query the subagent's chat.history to confirm
            // before skipping, to avoid suppressing legitimate short replies.
            const NO_REPLY_MARKER = 'NO_REPLY';
            const isFullNoReply = text.length > 0 && /^NO_REPLY$/i.test(text);
            const isTruncatedNoReply =
              text.length > 0 &&
              text.length <= NO_REPLY_MARKER.length &&
              NO_REPLY_MARKER.startsWith(text.toUpperCase()) &&
              !isFullNoReply;

            if (isFullNoReply) {
              // Confirmed NO_REPLY marker - skip entirely
              console.debug(
                '[OpenClawRuntime] handleChatEvent: skipping NO_REPLY final from different runId',
              );
            } else if (isTruncatedNoReply && this._gatewayClient) {
              // Possible truncated prefix — extract subagent sessionKey from runId
              // and query chat.history to confirm before deciding to skip.
              // runId format: announce:v1:agent:main:subagent:{uuid}:{runUuid}
              const subagentUuidMatch = runId.match(/subagent[:\-]([a-f0-9-]{36})/i);
              if (subagentUuidMatch) {
                const subagentSessionKey = 'agent:main:subagent:' + subagentUuidMatch[1];
                console.debug(
                  '[OpenClawRuntime] handleChatEvent: possible truncated NO_REPLY="' +
                    text +
                    '", querying subagent history to confirm',
                );
                void this.cb.subagentManager.syncFinalNoReplyWithHistory(
                  sessionId,
                  subagentSessionKey,
                  text,
                  turn.modelName,
                );
              } else {
                // Can't extract subagent UUID — show the text as-is since we can't confirm
                console.debug(
                  '[OpenClawRuntime] handleChatEvent: showing truncated text (no subagent UUID in runId), text="' +
                    text.slice(0, 50) +
                    '"',
                );
                const assistantMessage = this.cb.store.addMessage(sessionId, {
                  type: 'assistant',
                  content: text,
                  metadata: { isStreaming: false, isFinal: true },
                  modelName: turn.modelName,
                  ...(thinking ? { thinkingContent: thinking } : {}),
                });
                this.cb.emit('message', sessionId, assistantMessage);
              }
            } else if (text) {
              // Normal text from different runId - only emit as regular assistant message
              // if subagent streaming did not already capture it. Otherwise we get duplicate.
              if (runId.includes(':subagent:')) {
                const subagentUuidMatch2 = runId.match(/subagent[:\-]([a-f0-9-]{36})/i);
                if (subagentUuidMatch2) {
                  const subagentSessionKey2 = 'agent:main:subagent:' + subagentUuidMatch2[1];
                  const msgs2 = this.cb.subagentMessages.get(subagentSessionKey2);
                  const streamedAssistant2 = msgs2?.filter(m => m.role === 'assistant').pop();
                  if (
                    streamedAssistant2 &&
                    streamedAssistant2.content &&
                    streamedAssistant2.content.length > 0
                  ) {
                    // Subagent has streamed content — check if this announce text
                    // is genuinely new or just a duplicate of already-streamed content.
                    // Announce runs can carry summary text that was not part of the
                    // subagent's work output (e.g. cross-subagent summaries).
                    const allStreamedContent = (msgs2 ?? [])
                      .filter(m => m.role === 'assistant')
                      .map(m => (typeof m.content === 'string' ? m.content : ''))
                      .join('\n');
                    if (alreadyEmittedAnnounceText || allStreamedContent.includes(text)) {
                      console.log(
                        '[OpenClawRuntime] handleChatEvent: announce text already handled, skipping sessionKey=' +
                          subagentSessionKey2,
                      );
                    } else {
                      console.log(
                        '[OpenClawRuntime] handleChatEvent: announce has new content (len=' +
                          text.length +
                          ' vs streamed=' +
                          allStreamedContent.length +
                          '), emitting for sessionKey=' +
                          subagentSessionKey2,
                      );
                      const assistantMessage = this.cb.store.addMessage(sessionId, {
                        type: 'assistant',
                        content: text,
                        metadata: { isStreaming: false, isFinal: true },
                        modelName: turn.modelName,
                        ...(thinking ? { thinkingContent: thinking } : {}),
                      });
                      this.cb.emit('message', sessionId, assistantMessage);
                    }
                  } else if (!alreadyEmittedAnnounceText) {
                    // Subagent has no streamed content AND we haven't already emitted from deltas — show as regular assistant message
                    console.debug(
                      '[OpenClawRuntime] handleChatEvent: adding final message from different runId (subagent, no streaming), text="' +
                        text.slice(0, 50) +
                        '"' +
                        (thinking ? ' (with thinking)' : ''),
                    );
                    const assistantMessage = this.cb.store.addMessage(sessionId, {
                      type: 'assistant',
                      content: text,
                      metadata: { isStreaming: false, isFinal: true },
                      modelName: turn.modelName,
                      ...(thinking ? { thinkingContent: thinking } : {}),
                    });
                    this.cb.emit('message', sessionId, assistantMessage);
                  } else {
                    console.log(
                      '[OpenClawRuntime] handleChatEvent: subagent no streamed content but already emitted from deltas, skipping sessionKey=' +
                        subagentSessionKey2,
                    );
                  }
                } else {
                  // Can't extract subagent UUID — show as-is
                  console.debug(
                    '[OpenClawRuntime] handleChatEvent: adding final message from different runId, text="' +
                      text.slice(0, 50) +
                      '"' +
                      (thinking ? ' (with thinking)' : ''),
                  );
                  const assistantMessage = this.cb.store.addMessage(sessionId, {
                    type: 'assistant',
                    content: text,
                    metadata: { isStreaming: false, isFinal: true },
                    modelName: turn.modelName,
                    ...(thinking ? { thinkingContent: thinking } : {}),
                  });
                  this.cb.emit('message', sessionId, assistantMessage);
                }
              } else {
                // Not a subagent runId — show as-is
                console.debug(
                  '[OpenClawRuntime] handleChatEvent: adding final message from different runId, text="' +
                    text.slice(0, 50) +
                    '"' +
                    (thinking ? ' (with thinking)' : ''),
                );
                const assistantMessage = this.cb.store.addMessage(sessionId, {
                  type: 'assistant',
                  content: text,
                  metadata: { isStreaming: false, isFinal: true },
                  modelName: turn.modelName,
                  ...(thinking ? { thinkingContent: thinking } : {}),
                });
                this.cb.emit('message', sessionId, assistantMessage);
              }
            }
          }
        }
        // Mark the subagent as done when an announce run completes successfully.
        // Lifecycle events may only fire phase=start/error during quota retries,
        // with no phase=end. The announce completion via chat final is the
        // authoritative signal that the subagent finished.
        if (runId && runId.includes(':subagent:')) {
          const subagentUuidMatch = runId.match(/subagent[:\-]([a-f0-9-]{36})/i);
          if (subagentUuidMatch) {
            const subagentUuid = subagentUuidMatch[1];
            const subagentSessionKey = 'agent:main:subagent:' + subagentUuid;
            let toolCallId = this.cb.sessionKeyToToolCallId.get(subagentSessionKey);
            // Fallback: try without the prefix
            if (!toolCallId) {
              const shortKey = 'subagent:' + subagentUuid;
              toolCallId = this.cb.sessionKeyToToolCallId.get(shortKey);
            }
            // Fallback: direct UUID → toolCallId mapping (populated by item-level
            // result handler when childSessionKey is extracted from meta)
            if (!toolCallId) {
              toolCallId = this.cb.uuidToToolCallId.get(subagentUuid);
              if (toolCallId) {
                console.log(
                  '[OpenClawRuntime] announce completion: found toolCallId via uuidToToolCallId uuid=' +
                    subagentUuid.slice(0, 8) +
                    ' toolCallId=' +
                    toolCallId.slice(0, 20),
                );
              }
            }
            // Fallback: search subagentStatus keys that contain the UUID
            if (!toolCallId) {
              for (const [key, status] of this.cb.subagentStatus) {
                if (key.includes(subagentUuid) && status !== 'done' && status !== 'failed') {
                  toolCallId = key;
                  break;
                }
              }
            }
            if (toolCallId) {
              const currentStatus = this.cb.subagentStatus.get(toolCallId);
              if (currentStatus !== 'done' && currentStatus !== 'failed') {
                console.log(
                  '[OpenClawRuntime] announce completion: marking subagent as done toolCallId=' +
                    toolCallId +
                    ' uuid=' +
                    subagentUuid +
                    ' was=' +
                    (currentStatus || '(none)'),
                );
                this.cb.subagentStatus.set(toolCallId, 'done');
                // Update database status
                this.cb.store.updateSubagentStatus(toolCallId, 'done');
                this.cb.pendingToolCallIds.delete(toolCallId);
                this.cb.pendingEntryTimestamps.delete(toolCallId);
                this.cb.subagentManager.checkAllSubagentsDone();
              }
            } else {
              console.log(
                '[OpenClawRuntime] announce completion: lookup FAILED for uuid=' +
                  subagentUuid +
                  '. sessionKeyToToolCallId keys=' +
                  Array.from(this.cb.sessionKeyToToolCallId.keys()).join(',') +
                  ' subagentStatus keys=' +
                  Array.from(this.cb.subagentStatus.keys()).slice(0, 20).join(','),
              );
            }
          }
        }

        // NOTE: Do NOT delete activeTurns or call checkAllSubagentsDone here.
        // The main agent may have a follow-up turn after the subagent completes
        // (e.g., processing tool_result and producing a final response).
        // Premature ActiveTurn deletion causes the follow-up turn to lose
        // thinking/streaming because handleChatEvent/processAgentAssistantText
        // skip events when no ActiveTurn exists.
        // Session finalization is handled by:
        // - main agent lifecycle end (line 4442) → checkAllSubagentsDone
        // - subagent lifecycle end (line 4421) → checkAllSubagentsDone
        // - handleChatFinal (line 6216) → activeTurns.delete + reconcileWithHistory
        // Don't modify turn state, don't cleanup, just return
        return;
      }
      // Skip other states (aborted, error) from different runId
      return;
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

  resolveAssistantSegmentText(turn: ActiveTurn, fullText: string): string {
    // Filter out OpenClaw special marker "NO_REPLY" (no text reply, only tool calls)
    if (fullText.trim() === 'NO_REPLY') {
      return '';
    }
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

  processAgentThinkingEvent(payload: unknown): void {
    if (!isRecord(payload)) return;
    const p = payload as Record<string, unknown>;
    const streamType = typeof p.stream === 'string' ? p.stream : '';
    if (streamType !== 'thinking') {
      // Only log non-thinking agent streams once per type to avoid spam
      if (streamType && !this.cb._loggedThinkingStreamTypes.has(streamType)) {
        this.cb._loggedThinkingStreamTypes.add(streamType);
        console.log(
          '[OpenClawRuntime] processThinking: received non-thinking stream=' +
            streamType +
            ' (keys: ' +
            Object.keys(p).join(',') +
            ')',
        );
      }
      return;
    }
    console.log(
      '[OpenClawRuntime] processThinking: received thinking event, runId=' +
        (typeof p.runId === 'string' ? p.runId.slice(0, 8) : '(none)') +
        ' sessionKey=' +
        (typeof p.sessionKey === 'string' ? p.sessionKey.slice(0, 30) : '(none)'),
    );

    const dataField = isRecord(p.data) ? (p.data as Record<string, unknown>) : p;
    const text = typeof dataField.text === 'string' ? dataField.text : '';
    const delta = typeof dataField.delta === 'string' ? dataField.delta : '';

    const runId = typeof p.runId === 'string' ? p.runId.trim() : '';
    // Gateway agent events use 'session' field, not 'sessionKey'
    const sessionKey =
      (typeof p.sessionKey === 'string' ? p.sessionKey.trim() : '') ||
      (typeof p.session === 'string' ? p.session.trim() : '');
    let sessionId = runId ? this.cb.sessionIdByRunId.get(runId) : undefined;
    if (!sessionId && sessionKey) {
      sessionId = this.cb.resolveSessionIdBySessionKey(sessionKey) ?? undefined;
      if (!sessionId && this._channelSessionSync) {
        sessionId =
          this._channelSessionSync.resolveOrCreateSession(sessionKey) ||
          (!this.cb.heartbeatSessionKeys.has(sessionKey) &&
            this._channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
          this._channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
          undefined;
        if (sessionId) {
          this.cb.rememberSessionKey(sessionId, sessionKey);
        }
      }
      if (sessionId && !this.cb.activeTurns.has(sessionId)) {
        // OpenClaw: runId is set only at send time, events never modify turn.runId
        this.cb.ensureActiveTurn(sessionId, sessionKey, '');
      }
      // OpenClaw: runId is set only at send time, events never modify turn.runId
    }
    const turn = sessionId ? this.cb.activeTurns.get(sessionId) : undefined;

    if (!turn || !sessionId) {
      console.log(
        '[OpenClawRuntime] processThinking: SKIPPED - no turn/session, runId:',
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

    // Accumulate thinking events from subagent announce runs (different runId).
    // The accumulated thinking is retrieved when the subagent's chat final event is processed.
    if (runId && turn.runId && runId !== turn.runId) {
      const dataField = isRecord(p.data) ? (p.data as Record<string, unknown>) : null;
      if (dataField) {
        const text = typeof dataField.text === 'string' ? dataField.text : '';
        const delta = typeof dataField.delta === 'string' ? dataField.delta : '';
        const current = this.cb.subagentThinkingByRunId.get(runId) || '';
        // Use text as authoritative full content, fall back to delta appending
        if (text) {
          this.cb.subagentThinkingByRunId.set(runId, text);
        } else if (delta) {
          this.cb.subagentThinkingByRunId.set(runId, current + delta);
        }
      }
      return;
    }

    // Call the actual thinking event handler
    this.cb.handleAgentThinkingEvent(sessionId, turn, p.data);
  }

  processAgentAssistantText(payload: unknown): void {
    if (!isRecord(payload)) return;
    const p = payload as Record<string, unknown>;
    if (p.stream !== 'assistant') return;

    const runId = typeof p.runId === 'string' ? p.runId.trim() : '';
    // Gateway agent events use 'session' field, not 'sessionKey'
    const sessionKey =
      (typeof p.sessionKey === 'string' ? p.sessionKey.trim() : '') ||
      (typeof p.session === 'string' ? p.session.trim() : '');
    console.log(
      '[OpenClawRuntime] processAssistantText: received assistant event, runId=' +
        runId.slice(0, 8) +
        ' sessionKey=' +
        sessionKey.slice(0, 30),
    );

    const dataField = isRecord(p.data) ? (p.data as Record<string, unknown>) : p;
    const text =
      extractOpenClawAssistantStreamText(dataField) || extractOpenClawAssistantStreamText(p);

    let sessionId = runId ? this.cb.sessionIdByRunId.get(runId) : undefined;
    if (!sessionId && sessionKey) {
      sessionId = this.cb.resolveSessionIdBySessionKey(sessionKey) ?? undefined;
      if (!sessionId && this._channelSessionSync) {
        sessionId =
          this._channelSessionSync.resolveOrCreateSession(sessionKey) ||
          (!this.cb.heartbeatSessionKeys.has(sessionKey) &&
            this._channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
          this._channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
          undefined;
        if (sessionId) {
          this.cb.rememberSessionKey(sessionId, sessionKey);
        }
      }
      if (sessionId && !this.cb.activeTurns.has(sessionId)) {
        // OpenClaw: runId is set only at send time, events never modify turn.runId
        this.cb.ensureActiveTurn(sessionId, sessionKey, '');
      }
      // OpenClaw: runId is set only at send time, events never modify turn.runId
    }
    const turn = sessionId ? this.cb.activeTurns.get(sessionId) : undefined;

    if (!turn || !sessionId) {
      if (text) {
        console.debug(
          '[Debug:processAgentAssistant] skipped: text.len:',
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

    // Skip agent assistant events from a different runId (e.g., sub-agent announce while main agent is running).
    // This prevents duplicate messages when the main agent yields/resumes during subagent waits.
    // Agent events from announce runs should be skipped - they will be handled via chat events.
    if (runId && turn.runId && runId !== turn.runId) {
      console.log(
        '[OpenClawRuntime] processAgentAssistant: skipping event from different runId, runId=' +
          runId.slice(0, 20) +
          ' turn.runId=' +
          turn.runId.slice(0, 20),
      );
      return;
    }

    if (!text) {
      return;
    }

    // Text reset detection based on length comparison is unreliable because:
    // - Agent events and chat deltas may interleave
    // - Events may arrive out of order
    // - Length changes have many causes (gateway retry, content blocks, etc.)
    // OpenClaw: runId is set only at send time, different runId events are handled in handleChatEvent.
    // Only use high-water mark tracking to prevent false splits.
    turn.agentAssistantTextLength = Math.max(turn.agentAssistantTextLength, text.length);

    // Update turn text state and push to store.
    turn.currentText = text;
    turn.currentAssistantSegmentText = this.resolveAssistantSegmentText(turn, text);

    // Check if current assistantMessageId is a thinking message
    // If so, finalize it and create a new assistant message for text content
    if (turn.assistantMessageId && turn.currentThinkingMessageId === turn.assistantMessageId) {
      const session = this.cb.store.getSession(sessionId);
      const existingMsg = session?.messages.find(m => m.id === turn.assistantMessageId);
      const isThinkingMsg = existingMsg?.metadata?.isThinking === true;

      if (isThinkingMsg) {
        // Finalize thinking message and prepare for text content
        turn.thinkingStreamEnded = true;
        turn.assistantMessageId = null;
        this.cb.finalizeThinkingMessage(
          sessionId,
          turn.currentThinkingMessageId!,
          turn.currentThinkingContent,
        );
      }
    }

    // Check if segment text is a possible truncated special marker prefix
    // "NO_REPLY" may be truncated by OpenClaw gateway during streaming
    // Skip message creation/update if text might be incomplete marker
    const NO_REPLY_MARKER = 'NO_REPLY';
    const segmentText = turn.currentAssistantSegmentText;
    const isPossibleNoReplyPrefix =
      segmentText &&
      segmentText.length <= NO_REPLY_MARKER.length &&
      NO_REPLY_MARKER.startsWith(segmentText.trim()) &&
      segmentText.trim().length > 0;

    if (isPossibleNoReplyPrefix) {
      // Don't create/update message for possible truncated marker
      // Will be handled correctly in handleChatFinal with chat.history sync
      console.debug(
        '[OpenClawRuntime] processAgentAssistant: skipping for possible truncated marker',
        `segment="${segmentText.trim()}"`,
      );
      return;
    }

    if (!turn.assistantMessageId && turn.currentAssistantSegmentText) {
      // Create a new message for the new text segment (after split or thinking end).
      const assistantMessage = this.cb.store.addMessage(sessionId, {
        type: 'assistant',
        content: turn.currentAssistantSegmentText,
        metadata: { isStreaming: true, isFinal: false },
        modelName: turn.modelName,
      });
      turn.assistantMessageId = assistantMessage.id;
      this.cb.emit('message', sessionId, assistantMessage);
    } else if (turn.assistantMessageId && turn.currentAssistantSegmentText) {
      // Skip SQLite write during streaming — only emit IPC for real-time display.
      // The final message content is persisted when handleChatFinal fires.
      this.cb.throttledEmitMessageUpdate(
        sessionId,
        turn.assistantMessageId,
        turn.currentAssistantSegmentText,
      );
    }
  }

  splitAssistantSegmentBeforeTool(sessionId: string, turn: ActiveTurn): void {
    if (!turn.assistantMessageId) return;
    const messageId = turn.assistantMessageId;

    this.cb.clearPendingMessageUpdate(messageId);

    // Use in-memory turn content (currentAssistantSegmentText) instead of SQLite read.
    // During streaming, content is NOT persisted to SQLite (see processAgentAssistantText line 816),
    // only emitted via IPC. Reading from SQLite would return the initial first-token content.
    const segmentContent = turn.currentAssistantSegmentText.trim();
    console.log(
      '[Debug:splitAssistantSegmentBeforeTool]',
      'messageId:',
      messageId,
      'segmentContent.length:',
      segmentContent.length,
      'segmentContent.preview:',
      segmentContent.slice(0, 50),
    );

    if (segmentContent) {
      turn.committedAssistantText = `${turn.committedAssistantText}${segmentContent}`;
      // Persist the final content to SQLite now that streaming is ending for this segment.
      this.cb.store.updateMessage(sessionId, messageId, { content: segmentContent });
    }

    this.cb.store.updateMessage(sessionId, messageId, {
      metadata: { isStreaming: false, isFinal: true },
    });
    if (segmentContent) {
      this.cb.emit('messageUpdate', sessionId, messageId, segmentContent);
    }

    turn.assistantMessageId = null;
    turn.currentAssistantSegmentText = '';
  }

  private handleChatDelta(sessionId: string, turn: ActiveTurn, payload: ChatEventPayload): void {
    const extractedText = extractMessageText(payload.message);

    // End thinking stream when we receive text content
    // End thinking stream when we receive text content
    // Chat delta events carry accumulated full run text, which includes content
    // from all previous assistant segments. This causes content mixing when
    // combined with committedAssistantText-based segment resolution.
    // Instead, we rely entirely on processAgentAssistantText (agent stream events)
    // to handle assistant text content. handleChatDelta only handles thinking finalize.
    if (!turn.thinkingStreamEnded && turn.currentThinkingMessageId) {
      turn.thinkingStreamEnded = true;
      // Only clear assistantMessageId if it's pointing to the thinking message.
      if (turn.assistantMessageId === turn.currentThinkingMessageId) {
        turn.assistantMessageId = null;
      }
      // Finalize thinking message
      this.cb.finalizeThinkingMessage(
        sessionId,
        turn.currentThinkingMessageId,
        turn.currentThinkingContent,
      );
    }
    // Do NOT process text content from chat delta events.
    // Agent assistant stream events (processAgentAssistantText) handle all text.
  }

  private async handleChatFinal(
    sessionId: string,
    turn: ActiveTurn,
    payload: ChatEventPayload,
  ): Promise<void> {
    // Finalize any pending thinking message before processing final text
    if (turn.currentThinkingMessageId && !turn.thinkingStreamEnded) {
      this.cb.finalizeThinkingMessage(
        sessionId,
        turn.currentThinkingMessageId,
        turn.currentThinkingContent,
      );
      turn.thinkingStreamEnded = true;
      // Clear assistantMessageId if it was pointing to the thinking message
      if (turn.assistantMessageId === turn.currentThinkingMessageId) {
        turn.assistantMessageId = null;
      }
    }

    // Chat final events carry accumulated full run text (all assistant segments),
    // which cannot be correctly split by resolveAssistantSegmentText.
    // Instead, we use currentAssistantSegmentText set by processAgentAssistantText
    // (agent stream events), which correctly tracks the current segment text.
    const previousSegmentText = turn.currentAssistantSegmentText;
    console.debug(
      '[OpenClawRuntime] handleChatFinal:',
      `sessionId=${sessionId}`,
      `runId=${payload.runId ?? turn.runId}`,
      `assistantMessageId=${turn.assistantMessageId ?? '(none)'}`,
      `currentSegmentText="${truncate(previousSegmentText, 200)}"`,
    );

    if (turn.assistantMessageId) {
      this.cb.clearPendingMessageUpdate(turn.assistantMessageId);

      // Use existing segment text from processAgentAssistantText, not from chat final.
      // During streaming, the store is NOT updated (only IPC emit) — so reading from
      // the store would return stale initial content (first token), causing a visible
      // flash where the UI reverts before reconcileWithHistory replaces it.
      const persistedSegmentText = previousSegmentText;
      if (persistedSegmentText) {
        // Update BOTH content and metadata in the store so the final state is consistent.
        this.cb.store.updateMessage(sessionId, turn.assistantMessageId, {
          content: persistedSegmentText,
          metadata: { isStreaming: false, isFinal: true },
        });
        // Emit the full streamed content (not store content) to prevent UI flash
        this.cb.emit('messageUpdate', sessionId, turn.assistantMessageId, persistedSegmentText);
        // Emit metadata update so UI reflects the finalized state
        this.cb.emit('messageMetadataUpdate', sessionId, turn.assistantMessageId, {
          isStreaming: false,
          isFinal: true,
        });
      } else {
        // No streamed text — emit whatever is in the store as a fallback
        const storeSession = this.cb.store.getSession(sessionId);
        const storeMsg = storeSession?.messages.find(m => m.id === turn.assistantMessageId);
        if (storeMsg?.content) {
          this.cb.emit('messageUpdate', sessionId, turn.assistantMessageId, storeMsg.content);
        }
      }
    } else if (previousSegmentText) {
      // Check if segment text is a possible truncated special marker prefix
      // "NO_REPLY" may be truncated by OpenClaw gateway, showing only "NO"
      // In this case, don't create message yet - let syncFinal handle it
      const NO_REPLY_MARKER = 'NO_REPLY';
      const isPossibleNoReplyPrefix =
        previousSegmentText.length <= NO_REPLY_MARKER.length &&
        NO_REPLY_MARKER.startsWith(previousSegmentText.trim()) &&
        previousSegmentText.trim().length > 0;

      if (isPossibleNoReplyPrefix) {
        console.debug(
          '[OpenClawRuntime] handleChatFinal: skipping message creation for possible truncated marker',
          `segment="${previousSegmentText.trim()}"`,
          'will sync with chat.history',
        );
        // Don't create message - let syncFinal get complete text from history
      } else {
        // No assistantMessageId but we have segment text - create message
        const reusedMessageId = this.cb.reuseFinalAssistantMessage(sessionId, previousSegmentText);
        if (reusedMessageId) {
          turn.assistantMessageId = reusedMessageId;
        } else {
          const assistantMessage = this.cb.store.addMessage(sessionId, {
            type: 'assistant',
            content: previousSegmentText,
            metadata: {
              isStreaming: false,
              isFinal: true,
            },
            modelName: turn.modelName,
          });
          turn.assistantMessageId = assistantMessage.id;
          this.cb.emit('message', sessionId, assistantMessage);
        }
      }
    }

    // Check if we need to sync with history (when no text was generated locally)
    const finalText = this.resolveFinalTurnText(turn, payload.message);
    turn.currentText = finalText;

    // Special marker detection: "NO_REPLY" may be truncated by OpenClaw gateway
    // If text is a prefix of "NO_REPLY", force sync to get complete text
    const NO_REPLY_MARKER = 'NO_REPLY';
    const isNoReplyPrefix =
      finalText.length <= NO_REPLY_MARKER.length &&
      NO_REPLY_MARKER.startsWith(finalText.trim()) &&
      finalText.trim().length > 0;

    if (!finalText.trim() || isNoReplyPrefix) {
      console.debug(
        '[OpenClawRuntime] handleChatFinal: falling back to chat.history sync',
        `sessionId=${sessionId}`,
        `runId=${payload.runId ?? turn.runId}`,
        isNoReplyPrefix
          ? `reason=possible_truncated_marker("${finalText.trim()}")`
          : 'reason=no_text',
      );
      await this.cb.historyReconciler.syncFinalAssistantWithHistory(sessionId, turn);
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
      this.cb.store.updateSession(sessionId, { status: 'error' });
      this.cb.emit('error', sessionId, errorMessage);
      this.cb.cleanupSessionTurn(sessionId);
      this.cb.rejectTurn(sessionId, new Error(errorMessage));
      // Reconcile even on error so the UI shows messages already delivered.
      void this.cb.historyReconciler.reconcileWithHistory(sessionId, erroredSessionKey);
      return;
    }

    // Early cleanup of activeTurns to allow new messages while reconcileWithHistory runs.
    // This prevents "Session is still running" error when user sends message after seeing
    // messageMetadataUpdate (isStreaming: false) but before cleanupSessionTurn completes.
    // reconcileWithHistory only needs sessionId/sessionKey, not turn data.
    // CRITICAL: Only delete activeTurns if NO subagent tool calls were made.
    // When sessions_spawn was used, main agent will continue after subagent completes,
    // and subsequent agent events (thinking/assistant stream) need activeTurn to process.
    // Premature deletion causes main agent's follow-up output to be skipped.
    // Check from existing session messages (before reconcile) for sessions_spawn tool_use.
    const sessionBeforeReconcile = this.cb.store.getSession(sessionId);
    const hasSessionsSpawnToolCall =
      sessionBeforeReconcile?.messages.some(
        m => m.type === 'tool_use' && m.metadata?.toolName === 'sessions_spawn',
      ) ?? false;
    console.log(
      '[OpenClawRuntime] handleChatFinal: checking sessions_spawn tool calls, sessionId=' +
        sessionId +
        ' hasSessionsSpawnToolCall=' +
        hasSessionsSpawnToolCall,
    );
    if (!hasSessionsSpawnToolCall) {
      // IMPORTANT: Mark session as pending subagent completion BEFORE deleting activeTurns
      // to prevent ensureActiveTurn from re-creating turn on late-arriving announce events.
      this.cb.markPendingSubagentCompletion(sessionId);
      this.cb.activeTurns.delete(sessionId);
    } else {
      console.log(
        '[OpenClawRuntime] handleChatFinal: keeping activeTurns for subagent follow-up, sessionId=' +
          sessionId,
      );
    }

    // Reconcile local messages with authoritative gateway history.
    // This replaces the old syncFinalAssistantWithHistory + syncChannelAfterTurn flow.
    // Awaited so that IM handlers reading from the store see reconciled data.
    await this.cb.historyReconciler.reconcileWithHistory(sessionId, turn.sessionKey);

    // Detect thinking-only response: the last API call returned no visible text
    // (only a thinking block), causing the run to complete silently without output.
    // This happens with qwen3.5-plus under very large context (~380K tokens).
    // Signal: turn.currentText is empty AND there was at least one tool call in the run.
    // IMPORTANT: Skip this check if subagents are still running - the model is waiting for them.
    // Use toolCallIdToParentSessionId to check subagents belonging to THIS session.
    const hasRunningSubagents = Array.from(this.cb.subagentStatus.entries()).some(
      ([toolCallId, status]) => {
        if (status !== 'running') return false;
        const parentSessionId = this.cb.toolCallIdToParentSessionId.get(toolCallId);
        return parentSessionId === sessionId;
      },
    );
    const sessionAfterReconcile = this.cb.store.getSession(sessionId);
    if (sessionAfterReconcile && !hasRunningSubagents) {
      const msgs = sessionAfterReconcile.messages;
      const hadToolCall = msgs.some(m => m.type === 'tool_result');
      const hadSessionsSpawn = msgs.some(
        m => m.type === 'tool_use' && m.metadata?.toolName === 'sessions_spawn',
      );
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
        'hadSessionsSpawn:',
        hadSessionsSpawn,
        'lastApiResponseHadNoText:',
        lastApiResponseHadNoText,
      );
      // Don't show hint when sessions_spawn is involved - the agent will continue running
      // and output text after processing subagent results
      if (hadToolCall && lastApiResponseHadNoText && !hadSessionsSpawn) {
        const hintMessage = this.cb.store.addMessage(sessionId, {
          type: 'system',
          content: t('taskThinkingOnly'),
        });
        this.cb.emit('message', sessionId, hintMessage);
        console.warn('[OpenClawRuntime] thinking-only response detected, sessionId:', sessionId);
      }
    }

    // Check if any subagents are still running - if so, keep session in 'running' status.
    // Also, if subagents were involved (even if all completed), keep 'running' status
    // because the main agent is still processing results and may have follow-up runs.
    // We use a delayed check to determine if the main agent truly finished:
    // after cleanup, if no new turn is created within 500ms, mark as 'completed'.
    // NOTE: Use hasSessionsSpawnToolCall (computed earlier) to avoid duplicate check.
    const hadSubagentToolCalls = hasSessionsSpawnToolCall;
    const shouldKeepRunning = hasRunningSubagents || hadSubagentToolCalls;
    const finalStatus = shouldKeepRunning ? 'running' : 'completed';
    console.log(
      '[OpenClawRuntime] handleChatFinal: sessionId=' +
        sessionId +
        ' hasRunningSubagents=' +
        hasRunningSubagents +
        ' hadSubagentToolCalls=' +
        hadSubagentToolCalls +
        ' finalStatus=' +
        finalStatus +
        ' activeTurns.has=' +
        this.cb.activeTurns.has(sessionId),
    );
    this.cb.store.updateSession(sessionId, { status: finalStatus });
    this.cb.emit('complete', sessionId, payload.runId ?? turn.runId, finalStatus);
    // Only cleanup session turn when no subagent tool calls were made.
    // When subagents are involved, activeTurns is preserved for follow-up events.
    if (!hadSubagentToolCalls) {
      this.cb.cleanupSessionTurn(sessionId);
    }
    this.cb.resolveTurn(sessionId);

    // Delayed check: if subagents were involved and no new turn was created within 500ms,
    // the main agent has truly finished processing all results. Mark as 'completed'.
    // Use a retry loop (not single-shot) because subagents may take a long time to
    // complete and their lifecycle 'end' events arrive asynchronously.
    // NOTE: Since we preserve activeTurns for subagent scenarios, "hasNewTurn" now means
    // either: (1) a genuinely new turn was created after cleanup, OR (2) the preserved
    // turn is being actively updated by follow-up events. We check the turn's state
    // to distinguish: if thinkingStreamEnded is false or currentText has new content,
    // the main agent has resumed and is actively processing.
    if (shouldKeepRunning) {
      const MAX_RETRY_MS = 300_000; // 5 minutes cap
      const RETRY_INTERVAL_MS = 2_000; // check every 2s
      const startTime = Date.now();
      // Snapshot the turn's current state to detect if follow-up events arrive
      const initialTextSnapshot = turn.currentText;
      const initialThinkingEnded = turn.thinkingStreamEnded;

      const checkSubagentsAndFinalize = () => {
        // Check session's current status - only update if still 'running'
        // (avoid overwriting 'idle' from stopSession or 'error' from handleChatError)
        const session = this.cb.store.getSession(sessionId);
        const currentStatus = session?.status;
        if (currentStatus !== 'running') {
          // Session was already finalized by another path (checkAllSubagentsDone, stopSession, etc).
          // Clean up any stale activeTurns entry that could block future messages.
          if (this.cb.activeTurns.has(sessionId)) {
            console.log(
              '[OpenClawRuntime] handleChatFinal delayed check: cleaning up stale activeTurns: sessionId=' +
                sessionId,
            );
            this.cb.cleanupSessionTurn(sessionId);
          }
          // Clear pending subagent completion marker (if was set)
          this.cb.clearPendingSubagentCompletion(sessionId);
          console.log(
            '[OpenClawRuntime] handleChatFinal delayed check: sessionId=' +
              sessionId +
              ' currentStatus=' +
              currentStatus +
              ' -> skip (not running)',
          );
          return;
        }

        // Check if the preserved turn is being actively updated by follow-up events.
        // Compare current turn state against the initial snapshot to detect activity.
        const currentTurn = this.cb.activeTurns.get(sessionId);
        if (currentTurn) {
          const textChanged = currentTurn.currentText !== initialTextSnapshot;
          const thinkingResumed =
            currentTurn.thinkingStreamEnded !== initialThinkingEnded &&
            !currentTurn.thinkingStreamEnded;
          const isActive = textChanged || thinkingResumed;

          if (isActive) {
            console.log(
              '[OpenClawRuntime] handleChatFinal delayed check: sessionId=' +
                sessionId +
                ' isActive=' +
                isActive +
                ' (textChanged=' +
                textChanged +
                ', thinkingResumed=' +
                thinkingResumed +
                ') -> deferring, will retry',
            );
            // Main agent has resumed - defer and check again after the new activity completes
            setTimeout(checkSubagentsAndFinalize, RETRY_INTERVAL_MS);
            return;
          }
        }

        // Check if any subagents of THIS session are still running.
        // Use toolCallIdToParentSessionId to filter subagents belonging to this session.
        const stillHasRunningSubagents = Array.from(this.cb.subagentStatus.entries()).some(
          ([toolCallId, status]) => {
            if (status !== 'running') return false;
            const parentSessionId = this.cb.toolCallIdToParentSessionId.get(toolCallId);
            return parentSessionId === sessionId;
          },
        );
        if (!stillHasRunningSubagents) {
          console.log(
            '[OpenClawRuntime] handleChatFinal delayed check: sessionId=' +
              sessionId +
              ' hasActiveTurn=' +
              !!currentTurn +
              ' stillHasRunningSubagents=' +
              stillHasRunningSubagents +
              ' -> completed',
          );
          this.cb.store.updateSession(sessionId, { status: 'completed' });
          // Emit complete event to notify frontend of the status change
          // Use null for runId since this is a delayed update, not a new run completion
          this.cb.emit('complete', sessionId, null, 'completed');
          // Clear pending subagent completion marker (if was set)
          this.cb.clearPendingSubagentCompletion(sessionId);
          // Clean up the preserved activeTurns now that session is complete
          if (currentTurn) {
            this.cb.cleanupSessionTurn(sessionId);
          }
        } else if (Date.now() - startTime < MAX_RETRY_MS) {
          // Subagents still running and within retry window — check again
          console.log(
            '[OpenClawRuntime] handleChatFinal delayed check: sessionId=' +
              sessionId +
              ' stillHasRunningSubagents=' +
              stillHasRunningSubagents +
              ' -> retry in ' +
              RETRY_INTERVAL_MS +
              'ms',
          );
          setTimeout(checkSubagentsAndFinalize, RETRY_INTERVAL_MS);
        } else {
          // Timed out — force complete to prevent stuck sessions
          console.log(
            '[OpenClawRuntime] handleChatFinal delayed check: sessionId=' +
              sessionId +
              ' timed out after ' +
              MAX_RETRY_MS +
              'ms, forcing completed',
          );
          this.cb.store.updateSession(sessionId, { status: 'completed' });
          this.cb.emit('complete', sessionId, null, 'completed');
          // Clear pending subagent completion marker (if was set)
          this.cb.clearPendingSubagentCompletion(sessionId);
          // Clean up the preserved activeTurns
          if (this.cb.activeTurns.has(sessionId)) {
            this.cb.cleanupSessionTurn(sessionId);
          }
        }
      };

      setTimeout(checkSubagentsAndFinalize, 500);
    }
  }

  handleChatAborted(sessionId: string, turn: ActiveTurn): void {
    // Clear pending subagent completion marker since session is being terminated
    this.cb.clearPendingSubagentCompletion(sessionId);
    this.cb.store.updateSession(sessionId, { status: 'idle' });
    if (!turn.stopRequested && !this.cb.manuallyStoppedSessions.has(sessionId)) {
      // The run was aborted without user request — most likely a timeout.
      // Emit complete event but no timeout hint message.
      this.cb.emit('complete', sessionId, turn.runId, 'idle');
    }
    const abortedSessionKey = turn.sessionKey;
    this.cb.cleanupSessionTurn(sessionId);
    this.cb.resolveTurn(sessionId);
    void this.cb.historyReconciler.reconcileWithHistory(sessionId, abortedSessionKey);
  }

  private handleChatError(sessionId: string, turn: ActiveTurn, payload: ChatEventPayload): void {
    // Clear pending subagent completion marker since session is being terminated
    this.cb.clearPendingSubagentCompletion(sessionId);
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
    this.cb.store.updateSession(sessionId, { status: 'error' });
    // Persist error message to SQLite so it survives session switches
    const errorMsg = this.cb.store.addMessage(sessionId, {
      type: 'system',
      content: errorMessage,
      metadata: { error: errorMessage },
    });
    this.cb.emit('message', sessionId, errorMsg);
    this.cb.emit('error', sessionId, errorMessage);
    this.cb.cleanupSessionTurn(sessionId);
    this.cb.rejectTurn(sessionId, new Error(errorMessage));
    void this.cb.historyReconciler.reconcileWithHistory(sessionId, erroredSessionKey);
  }
}
