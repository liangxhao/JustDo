import type { CoworkStore } from '../../../coworkStore';
import type { OpenClawGatewayConnectionInfo } from '../../openclawEngineManager';
import type { ActiveTurn } from '../gateway/types';
import type { SubagentManager } from '../subagent/subagentManager';
import {
  isRecord,
  extractToolText,
  mergeStreamingText,
  toToolInputRecord,
} from '../utils/gatewayHelpers';

export interface AgentToolEventCallbacks {
  processedToolEvents: Set<string>;
  toolCallArgs: Map<string, Record<string, unknown>>;
  subagentStatus: Map<string, 'pending' | 'running' | 'done' | 'failed'>;
  pendingToolCallIds: Set<string>;
  pendingEntryTimestamps: Map<string, number>;
  toolCallIdToSessionKey: Map<string, string>;
  toolCallIdToParentSessionId: Map<string, string>;
  toolCallIdToLabel: Map<string, string>;
  subagentMessages: Map<
    string,
    Array<{ role: string; content: string; metadata?: Record<string, unknown> }>
  >;
  successfulSpawnToolCallIds: Set<string>;
  sessionKeyToToolCallId: Map<string, string>;
  sessionKeyToLabel: Map<string, string>;
  subagentUuidToLabel: Map<string, string>;
  failedSubagentIds: Set<string>;
  orchestrationParentSessionId: string | null;
  store: CoworkStore;
  subagentManager: SubagentManager;
  resolveSubagentParentSessionId: (agentId: string) => string | null;
  emit: (event: string, ...args: unknown[]) => void;
  splitAssistantSegmentBeforeTool: (sessionId: string, turn: ActiveTurn) => void;
  getGatewayConnectionInfo: () => OpenClawGatewayConnectionInfo;
}

export class AgentToolEventHandler {
  private readonly cb: AgentToolEventCallbacks;

  constructor(cb: AgentToolEventCallbacks) {
    this.cb = cb;
  }

  handleAgentToolEvent(sessionId: string, turn: ActiveTurn, data: unknown): void {
    if (!isRecord(data)) return;

    // Dedup: both stream=tool and stream=item can carry the same tool event
    const quickToolCallId = typeof data.toolCallId === 'string' ? data.toolCallId.trim() : '';
    const quickToolField = typeof data.tool === 'string' ? data.tool.trim() : '';
    const quickCall = typeof data.call === 'string' ? data.call.trim() : '';
    const quickPhase =
      typeof data.phase === 'string'
        ? data.phase.trim() === 'end'
          ? 'result'
          : data.phase.trim()
        : quickToolField.includes(':')
          ? quickToolField.split(':')[0] === 'end'
            ? 'result'
            : quickToolField.split(':')[0]
          : '';
    const quickDedupToolCallId = quickToolCallId || quickCall;
    if (quickPhase && quickDedupToolCallId) {
      const dedupKey = quickPhase + ':' + quickDedupToolCallId;
      if (this.cb.processedToolEvents.has(dedupKey)) {
        return;
      }
      this.cb.processedToolEvents.add(dedupKey);
    }

    // Parse both gateway format and standard format
    const toolField = typeof data.tool === 'string' ? data.tool.trim() : '';
    let phase: string;
    let toolName: string;
    let toolCallId: string;

    if (toolField && toolField.includes(':')) {
      const parts = toolField.split(':');
      phase = parts[0] === 'end' ? 'result' : parts[0];
      toolName = parts.slice(1).join(':') || 'Tool';
      toolCallId = typeof data.call === 'string' ? data.call.trim() : '';
    } else {
      const rawPhase = typeof data.phase === 'string' ? data.phase.trim() : '';
      phase = rawPhase === 'end' ? 'result' : rawPhase;
      toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId.trim() : '';
      const toolNameRaw = typeof data.name === 'string' ? data.name.trim() : '';
      toolName = toolNameRaw || 'Tool';
    }

    if (!toolCallId) return;
    if (phase !== 'start' && phase !== 'update' && phase !== 'result') return;

    // Parse meta field
    let metaLabel: string | null = null;
    const metaField = typeof data.meta === 'string' ? data.meta.trim() : '';
    if (metaField) {
      const labelMatch = metaField.match(/label\s+([^,]+)/);
      if (labelMatch && labelMatch[1]) {
        metaLabel = labelMatch[1].trim();
      }
    }

    // Debug: sessions_spawn tool calls
    if (
      toolName === 'sessions_spawn' ||
      toolName === 'sessions_resume' ||
      toolName === 'sessions_read'
    ) {
      const dataKeys = Object.keys(data);
      const hasResult = isRecord(data.result);
      const resultKeys = hasResult ? Object.keys(data.result as Record<string, unknown>) : [];
      const isErrorValue = Boolean(data.isError);
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
          '] isError=' +
          isErrorValue +
          ' meta=' +
          (metaField || '(none)'),
      );
      if (hasResult) {
        try {
          const resultJson = JSON.stringify(data.result).slice(0, 500);
          console.log('[OpenClawRuntime] sessions_spawn result: ' + resultJson);
        } catch {
          console.log('[OpenClawRuntime] sessions_spawn result: (failed to stringify)');
        }
      }
    }

    // sessions_spawn start
    if (toolName === 'sessions_spawn' && phase === 'start') {
      const args = isRecord(data.args) ? (data.args as Record<string, unknown>) : {};
      const argsKeys = Object.keys(args);
      console.log(
        '[OpenClawRuntime] sessions_spawn start: args keys=[' +
          argsKeys.join(',') +
          '] meta=' +
          (metaField || '(none)'),
      );

      // For announce subagents, data.args is empty and all info is in meta string:
      // "label skill-docx-example, task 请阅读 skills/docx/SKILL.md ..."
      // Extract label, task, runtime, mode from meta when args is empty.
      let enrichedArgs: Record<string, unknown> = { ...args };
      let enrichedMetaLabel = metaLabel;
      if (argsKeys.length === 0 && metaField) {
        // Extract label: "label xxx, task ..."
        const labelMatch = metaField.match(/^label\s+([^,]+)/);
        if (labelMatch && labelMatch[1]) {
          enrichedArgs.label = labelMatch[1].trim();
          enrichedMetaLabel = labelMatch[1].trim();
        }
        // Extract task: ", task yyy"
        const taskMatch = metaField.match(/,\s*task\s+(.+)$/i);
        if (taskMatch && taskMatch[1]) {
          enrichedArgs.task = taskMatch[1].trim();
        }
        // Extract runtime and mode if present
        const runtimeMatch = metaField.match(/runtime\s+(\w+)/);
        if (runtimeMatch && runtimeMatch[1]) {
          enrichedArgs.runtime = runtimeMatch[1];
        }
        const modeMatch = metaField.match(/mode\s+(\w+)/);
        if (modeMatch && modeMatch[1]) {
          enrichedArgs.mode = modeMatch[1];
        }
      }

      let promptText = '';
      if (typeof enrichedArgs.task === 'string' && enrichedArgs.task) {
        promptText = enrichedArgs.task as string;
      } else if (typeof enrichedArgs.prompt === 'string' && enrichedArgs.prompt) {
        promptText = enrichedArgs.prompt as string;
      }

      const savedInfo = {
        ...enrichedArgs,
        _metaLabel: enrichedMetaLabel,
        _extractedPrompt: promptText,
      };
      this.cb.toolCallArgs.set(toolCallId, savedInfo);

      // Fallback chain: label → metaLabel → promptText.slice(0,30)
      // NOTE: Never fallback to toolCallId - use task description instead
      const displayLabel =
        typeof enrichedArgs.label === 'string' && enrichedArgs.label
          ? (enrichedArgs.label as string)
          : enrichedMetaLabel || (promptText ? promptText.slice(0, 30) : '');

      this.cb.subagentStatus.set(toolCallId, 'pending');
      this.cb.pendingToolCallIds.add(toolCallId);
      this.cb.pendingEntryTimestamps.set(toolCallId, Date.now());

      const currentSessionKey = turn.sessionKey;
      if (currentSessionKey) {
        this.cb.toolCallIdToSessionKey.set(toolCallId, currentSessionKey);
        console.log(
          '[OpenClawRuntime] sessions_spawn start: established temporary mapping toolCallId=' +
            toolCallId +
            ' -> sessionKey=' +
            currentSessionKey +
            ' (will be updated when result arrives)',
        );
      }

      console.log(
        '[OpenClawRuntime] sessions_spawn start: TRACKING toolCallId=' +
          toolCallId +
          ' sessionId=' +
          sessionId +
          ' orchestrationParentSessionId=' +
          (this.cb.orchestrationParentSessionId || '(none)') +
          ' sessionKey=' +
          (turn.sessionKey || '(none)'),
      );
      this.cb.toolCallIdToParentSessionId.set(toolCallId, sessionId);

      if (displayLabel) {
        this.cb.toolCallIdToLabel.set(toolCallId, displayLabel);
      }

      // Persist to database for restart recovery
      this.cb.store.upsertSubagent(toolCallId, sessionId, displayLabel || '(unknown)', 'pending', {
        toolInput: savedInfo,
      });

      if (!this.cb.subagentMessages.has(toolCallId)) {
        this.cb.subagentMessages.set(toolCallId, []);
      }
      console.log(
        '[OpenClawRuntime] sessions_spawn start: toolCallId=' +
          toolCallId +
          ' displayLabel=' +
          (displayLabel || '(none)') +
          ' promptText (len=' +
          promptText.length +
          '): ' +
          (promptText.length > 100 ? promptText.slice(0, 100) + '...' : promptText || '(empty)'),
      );
      if (promptText) {
        const msgs = this.cb.subagentMessages.get(toolCallId)!;
        const contextMsg = {
          role: 'user',
          content: `[Subagent Context]\n\n${promptText}`,
          metadata: {
            isSubagentContext: true,
            label: displayLabel,
          },
        };
        msgs.push(contextMsg);
        console.log(
          '[OpenClawRuntime] sessions_spawn start: added subagent context message to msgs (len=' +
            msgs.length +
            ')',
        );
        const contextParentSessionId = this.cb.resolveSubagentParentSessionId(toolCallId);
        if (contextParentSessionId) {
          this.cb.emit('subagentMessage', contextParentSessionId, toolCallId, {
            id: `subagent-context-${Date.now()}`,
            type: 'user',
            content: contextMsg.content,
            timestamp: Date.now(),
            metadata: contextMsg.metadata,
          });
        }
        console.log(
          '[OpenClawRuntime] sessions_spawn start: added subagent context message (len=' +
            promptText.length +
            ')',
        );
      }
      console.log(
        '[OpenClawRuntime] sessions_spawn start: toolCallId=' +
          toolCallId +
          ' displayLabel=' +
          (displayLabel || '(none)') +
          ' (established early mapping, pending sessionKey)',
      );
    }

    // sessions_spawn result (success)
    if (toolName === 'sessions_spawn' && phase === 'result' && !data.isError && !data.err) {
      if (toolCallId) {
        this.cb.successfulSpawnToolCallIds.add(toolCallId);
      }

      let childSessionKey: string | null = null;
      const result = data.result;
      if (isRecord(result)) {
        childSessionKey =
          typeof result.childSessionKey === 'string' ? result.childSessionKey : null;
      }
      if (!childSessionKey) {
        childSessionKey =
          typeof data.sessionKey === 'string'
            ? data.sessionKey
            : typeof data.childSessionKey === 'string'
              ? data.childSessionKey
              : null;
      }

      const savedInfo = this.cb.toolCallArgs.get(toolCallId);
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
      if (childSessionKey && toolCallId) {
        console.log(
          '[OpenClawRuntime] sessions_spawn mapping: toolCallId=' +
            toolCallId +
            ' label=' +
            (mappingKey || '(none)') +
            ' childSessionKey=' +
            childSessionKey,
        );

        const wrongToolCallId = this.cb.sessionKeyToToolCallId.get(childSessionKey);
        if (wrongToolCallId && wrongToolCallId !== toolCallId) {
          console.log(
            '[OpenClawRuntime] sessions_spawn: correcting wrong lifecycle fallback mapping. childSessionKey=' +
              childSessionKey +
              ' wrongToolCallId=' +
              wrongToolCallId +
              ' correctToolCallId=' +
              toolCallId,
          );
          const wrongStatus = this.cb.subagentStatus.get(wrongToolCallId);
          if (wrongStatus) {
            this.cb.subagentStatus.set(toolCallId, wrongStatus);
            this.cb.subagentStatus.delete(wrongToolCallId);
          }
          this.cb.toolCallIdToSessionKey.delete(wrongToolCallId);
          this.cb.sessionKeyToToolCallId.delete(childSessionKey);
        }

        const existingSessionKey = this.cb.toolCallIdToSessionKey.get(toolCallId);
        if (existingSessionKey && existingSessionKey !== childSessionKey) {
          console.log(
            '[OpenClawRuntime] sessions_spawn: correcting wrong toolCallId mapping. toolCallId=' +
              toolCallId +
              ' existingSessionKey=' +
              existingSessionKey +
              ' correctSessionKey=' +
              childSessionKey,
          );
          this.cb.sessionKeyToToolCallId.delete(existingSessionKey);
        }

        this.cb.toolCallIdToSessionKey.set(toolCallId, childSessionKey);
        this.cb.sessionKeyToToolCallId.set(childSessionKey, toolCallId);
        if (mappingKey) {
          this.cb.sessionKeyToLabel.set(childSessionKey, mappingKey);
          this.cb.toolCallIdToLabel.set(toolCallId, mappingKey);
          const uuidMatch = childSessionKey.match(/subagent[:\-]([a-f0-9-]{36})$/i);
          if (uuidMatch && uuidMatch[1]) {
            this.cb.subagentUuidToLabel.set(uuidMatch[1], mappingKey);
          }
        }

        this.cb.pendingToolCallIds.delete(toolCallId);
        this.cb.pendingEntryTimestamps.delete(toolCallId);
        const pendingMsgs = this.cb.subagentMessages.get(toolCallId);
        if (pendingMsgs && pendingMsgs.length > 0) {
          if (!this.cb.subagentMessages.has(childSessionKey)) {
            this.cb.subagentMessages.set(childSessionKey, [...pendingMsgs]);
          } else {
            const existingMsgs = this.cb.subagentMessages.get(childSessionKey)!;
            for (const msg of pendingMsgs) {
              const isDuplicate = existingMsgs.some(
                existing =>
                  existing.role === msg.role &&
                  (existing.content === msg.content ||
                    existing.content.startsWith(msg.content) ||
                    msg.content.startsWith(existing.content)),
              );
              if (!isDuplicate) {
                existingMsgs.push(msg);
              }
            }
          }
          console.log(
            '[OpenClawRuntime] sessions_spawn: copied ' +
              pendingMsgs.length +
              ' messages from toolCallId to sessionKey storage',
          );
        }
      } else {
        console.log(
          '[OpenClawRuntime] sessions_spawn result: childSessionKey not in gateway event (expected), toolCallId=' +
            (toolCallId || '(none)') +
            ' label=' +
            (mappingKey || '(none)'),
        );
        if (toolCallId && mappingKey) {
          this.cb.toolCallIdToLabel.set(toolCallId, mappingKey);
        }
        if (toolCallId) {
          const foundSessionKey =
            this.cb.subagentManager.findChildSessionKeyByToolCallId(toolCallId);
          if (foundSessionKey) {
            childSessionKey = foundSessionKey;
            if (mappingKey) {
              this.cb.sessionKeyToLabel.set(childSessionKey, mappingKey);
              this.cb.toolCallIdToLabel.set(toolCallId, mappingKey);
            }
            this.cb.toolCallIdToSessionKey.set(toolCallId, childSessionKey);
            this.cb.sessionKeyToToolCallId.set(childSessionKey, toolCallId);
            this.cb.pendingToolCallIds.delete(toolCallId);
            this.cb.pendingEntryTimestamps.delete(toolCallId);
            console.log(
              '[OpenClawRuntime] sessions_spawn: established mapping via CoworkStore toolCallId=' +
                toolCallId +
                ' childSessionKey=' +
                childSessionKey,
            );
          }
          if (toolCallId && mappingKey) {
            const parentSessionKey = this.cb.toolCallIdToSessionKey.get(toolCallId);
            if (parentSessionKey) {
              this.cb.subagentManager
                .querySubagentSessionKey(mappingKey, parentSessionKey, toolCallId)
                .catch(err => {
                  console.warn(
                    '[OpenClawRuntime] sessions_spawn: querySubagentSessionKey background call failed:',
                    err,
                  );
                });
            }
          }
        }
      }
      this.cb.toolCallArgs.delete(toolCallId);
    }

    // sessions_spawn result with error
    if (toolName === 'sessions_spawn' && phase === 'result' && (data.isError || data.err)) {
      const errorReason = typeof data.err === 'string' ? data.err : String(data.result || 'Unknown error');
      const label = this.cb.toolCallIdToLabel.get(toolCallId) || '(unknown)';
      const parentSessionId = this.cb.toolCallIdToParentSessionId.get(toolCallId) || this.cb.orchestrationParentSessionId || sessionId;

      console.log(
        '[OpenClawRuntime] sessions_spawn failed: toolCallId=' +
          toolCallId +
          ' isError=' +
          Boolean(data.isError) +
          ' err=' +
          (data.err || '(none)') +
          ' - marking as failed in subagent tracking',
      );
      this.cb.failedSubagentIds.add(toolCallId);
      this.cb.subagentStatus.set(toolCallId, 'failed');
      // Persist to database for restart recovery
      this.cb.store.upsertSubagent(toolCallId, parentSessionId, label, 'failed', { errorReason });
      this.cb.pendingToolCallIds.delete(toolCallId);
      this.cb.pendingEntryTimestamps.delete(toolCallId);
      this.cb.toolCallIdToSessionKey.delete(toolCallId);
      this.cb.toolCallIdToParentSessionId.delete(toolCallId);
      this.cb.toolCallIdToLabel.delete(toolCallId);
      this.cb.subagentMessages.delete(toolCallId);
      this.cb.toolCallArgs.delete(toolCallId);
    }

    // Browser tool events
    if (toolName.toLowerCase() === 'browser') {
      const isError = Boolean(data.isError);
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
      this.probeBrowserControlService(toolCallId, phase);
    }

    // Create tool_use message if not already tracked
    if (!turn.toolUseMessageIdByToolCallId.has(toolCallId)) {
      this.cb.splitAssistantSegmentBeforeTool(sessionId, turn);

      let effectiveArgs = toToolInputRecord(data.args);
      if (
        (Object.keys(effectiveArgs).length === 0 || !isRecord(data.args)) &&
        this.cb.toolCallArgs.has(toolCallId)
      ) {
        const savedArgs = this.cb.toolCallArgs.get(toolCallId);
        if (savedArgs) {
          const { _metaLabel, _extractedPrompt, ...actualArgs } = savedArgs;
          effectiveArgs = actualArgs as Record<string, unknown>;
          console.log(
            '[OpenClawRuntime] tool_use message using saved args for toolCallId=' +
              toolCallId +
              ' toolName=' +
              toolName +
              ' argsKeys=[' +
              Object.keys(effectiveArgs).join(',') +
              ']',
          );
        }
      }
      // For sessions_spawn, show detailed content with label and task
      let toolContent = `Using tool: ${toolName}`;
      if (toolName === 'sessions_spawn' && Object.keys(effectiveArgs).length > 0) {
        const label = typeof effectiveArgs.label === 'string' ? effectiveArgs.label : '';
        const task = typeof effectiveArgs.task === 'string' ? effectiveArgs.task : '';
        const agentId = typeof effectiveArgs.agentId === 'string' ? effectiveArgs.agentId : '';
        if (label) {
          toolContent = `Spawning subagent: ${label}`;
        } else if (agentId) {
          toolContent = `Spawning agent: ${agentId}`;
        }
        if (task) {
          toolContent += `\nTask: ${task.length > 100 ? task.slice(0, 100) + '...' : task}`;
        }
      }

      const toolUseMessage = this.cb.store.addMessage(sessionId, {
        type: 'tool_use',
        content: toolContent,
        metadata: {
          toolName,
          toolInput: effectiveArgs,
          toolUseId: toolCallId,
        },
      });
      turn.toolUseMessageIdByToolCallId.set(toolCallId, toolUseMessage.id);
      this.cb.emit('message', sessionId, toolUseMessage);
    }

    // Phase: update
    if (phase === 'update') {
      const incoming = extractToolText(data.partialResult);
      if (!incoming.trim()) return;

      const previous = turn.toolResultTextByToolCallId.get(toolCallId) ?? '';
      const merged = mergeStreamingText(previous, incoming, 'unknown').text;

      let toolInputForResult: Record<string, unknown> = {};
      if (this.cb.toolCallArgs.has(toolCallId)) {
        const savedArgs = this.cb.toolCallArgs.get(toolCallId);
        if (savedArgs) {
          const { _metaLabel, _extractedPrompt, ...actualArgs } = savedArgs;
          toolInputForResult = actualArgs as Record<string, unknown>;
        }
      }

      const existingResultMessageId = turn.toolResultMessageIdByToolCallId.get(toolCallId);
      if (!existingResultMessageId) {
        const resultMessage = this.cb.store.addMessage(sessionId, {
          type: 'tool_result',
          content: merged,
          metadata: {
            toolResult: merged,
            toolUseId: toolCallId,
            toolName,
            toolInput: toolInputForResult,
            isError: false,
            isStreaming: true,
            isFinal: false,
          },
        });
        turn.toolResultMessageIdByToolCallId.set(toolCallId, resultMessage.id);
        turn.toolResultTextByToolCallId.set(toolCallId, merged);
        this.cb.emit('message', sessionId, resultMessage);
        return;
      }

      if (merged !== previous) {
        this.cb.store.updateMessage(sessionId, existingResultMessageId, {
          content: merged,
          metadata: {
            toolResult: merged,
            toolUseId: toolCallId,
            toolName,
            toolInput: toolInputForResult,
            isError: false,
            isStreaming: true,
            isFinal: false,
          },
        });
        turn.toolResultTextByToolCallId.set(toolCallId, merged);
        this.cb.emit('messageUpdate', sessionId, existingResultMessageId, merged);
      }
      return;
    }

    // Phase: result
    if (phase === 'result') {
      const isError = Boolean(data.isError);
      let finalContent: string;
      let finalToolResult: unknown = undefined; // Keep original structured result for error parsing

      // For sessions_spawn, prefer structured result over extractToolText
      if (toolName === 'sessions_spawn' && isRecord(data.result)) {
        const childSessionKey =
          typeof data.result.childSessionKey === 'string'
            ? data.result.childSessionKey
            : typeof data.result.sessionKey === 'string'
              ? data.result.sessionKey
              : '';
        const sessionIdFromResult =
          typeof data.result.sessionId === 'string' ? data.result.sessionId : '';

        // Keep original structured result for error parsing
        finalToolResult = data.result;

        if (!isError && childSessionKey) {
          finalContent = `Subagent spawned successfully.\nSession Key: ${childSessionKey}`;
          if (sessionIdFromResult) {
            finalContent += `\nSession ID: ${sessionIdFromResult}`;
          }
        } else if (isError) {
          // Extract error message from structured result
          const errorStatus = typeof data.result.status === 'string' ? data.result.status : '';
          const errorMessage = typeof data.result.error === 'string' ? data.result.error : '';
          if (errorStatus && errorMessage) {
            finalContent = `Subagent spawn failed (${errorStatus}): ${errorMessage}`;
          } else {
            finalContent = `Subagent spawn failed: ${extractToolText(data.result) || 'Unknown error'}`;
          }
        } else {
          finalContent = extractToolText(data.result);
        }
      } else {
        const incoming = extractToolText(data.result);
        const previous = turn.toolResultTextByToolCallId.get(toolCallId) ?? '';
        finalContent = incoming.trim() ? incoming : previous;
        // For other tools, keep result as-is if it's a string or object
        finalToolResult = data.result;
      }
      const finalError = isError ? finalContent || 'Tool execution failed' : undefined;
      const existingResultMessageId = turn.toolResultMessageIdByToolCallId.get(toolCallId);

      let toolInputForResult: Record<string, unknown> = {};
      if (this.cb.toolCallArgs.has(toolCallId)) {
        const savedArgs = this.cb.toolCallArgs.get(toolCallId);
        if (savedArgs) {
          const { _metaLabel, _extractedPrompt, ...actualArgs } = savedArgs;
          toolInputForResult = actualArgs as Record<string, unknown>;
        }
      }

      if (existingResultMessageId) {
        this.cb.store.updateMessage(sessionId, existingResultMessageId, {
          content: finalContent,
          metadata: {
            toolResult: (finalToolResult ?? finalContent) as string | Record<string, unknown>,
            toolUseId: toolCallId,
            toolName,
            toolInput: toolInputForResult,
            error: finalError,
            isError,
            isStreaming: false,
            isFinal: true,
          },
        });
        this.cb.emit('messageUpdate', sessionId, existingResultMessageId, finalContent);
      } else {
        const resultMessage = this.cb.store.addMessage(sessionId, {
          type: 'tool_result',
          content: finalContent,
          metadata: {
            toolResult: (finalToolResult ?? finalContent) as string | Record<string, unknown>,
            toolUseId: toolCallId,
            toolName,
            toolInput: toolInputForResult,
            error: finalError,
            isError,
            isStreaming: false,
            isFinal: true,
          },
        });
        turn.toolResultMessageIdByToolCallId.set(toolCallId, resultMessage.id);
        this.cb.emit('message', sessionId, resultMessage);
      }
      turn.toolResultTextByToolCallId.set(toolCallId, finalContent);
    }
  }

  private probeBrowserControlService(toolCallId: string, phase: string): void {
    const connection = this.cb.getGatewayConnectionInfo();
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
}
