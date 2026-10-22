import type { BrowserExtensionStreamEvent } from '@shared/browser/browserExtensionStream';
import { readTerminalGuardObservation } from '@shared/openclaw/agentEvent';

import type { AssistantTurn } from '../chat-transcript-state';
import { advanceRunActivity, createRunActivity, type RunActivity } from '../turn/run-activity';
import {
  readCommandOutputActivity,
  readRunningToolActivity,
  readRunProgress,
} from '../turn/run-progress';

/** Called only after transcript identity and sequence admission. No execution outcomes. */
export function projectBrowserExtensionActivity(
  activity: RunActivity | null,
  value: BrowserExtensionStreamEvent,
  turn: AssistantTurn | null,
  previousHighWater: number,
): RunActivity | null {
  if (!turn) return activity;
  const tools = turn.toolById;
  const runningTool = [...tools.values()].some(tool => tool.status === 'running');
  if (value.kind === 'chat') {
    // A chat final closes a message/attempt, not the whole native execution.
    if (value.event.state !== 'delta') return activity;
    const content = [...turn.items]
      .reverse()
      .find(item => item.type === 'content' && item.text.trim());
    if (!content || content.type !== 'content' || content.assistantTextScopeSuppressed)
      return activity;
    const now = Date.now();
    return advanceRunActivity(
      activity?.runId === turn.runId ? activity : createRunActivity(turn.runId, turn.startedAt),
      'responding',
      { modelActivity: true, at: now },
      runningTool,
    );
  }
  const event = value.event;
  // A sparse snapshot may fill an old tool, without reverting the current stage.
  if (event.agentSeq <= previousHighWater) return activity;
  const phase = event.data.phase;
  let progress = readRunProgress(event.stream, event.data);
  if (event.stream === 'thinking') {
    if (turn.items.some(item => item.type === 'thinking' && item.text.trim()))
      progress = { stage: 'thinking', modelActivity: true };
  } else if (event.stream === 'assistant') {
    const content = [...turn.items].reverse().find(item => item.type === 'content');
    if (
      content?.type === 'content' &&
      content.text.trim() &&
      !content.assistantTextSourcePending &&
      !content.assistantTextScopeSuppressed &&
      !readTerminalDecision(event.data)
    ) {
      progress = { stage: 'responding', modelActivity: true };
    }
  } else if (event.stream === 'tool' && phase !== 'input_delta') {
    progress = readRunningToolActivity(tools);
  } else if (event.stream === 'item' && event.data.kind === 'tool') {
    const toolId = event.data.toolCallId;
    if (typeof toolId === 'string' && tools.get(toolId)?.status === 'running')
      progress = readRunningToolActivity(tools, toolId);
  } else if (event.stream === 'command_output') {
    progress = readCommandOutputActivity(tools, event.data);
  } else if (
    event.stream === 'compaction' &&
    ['start', 'update', 'end', 'error', 'failed'].includes(String(phase))
  ) {
    progress = {
      stage: phase === 'start' || phase === 'update' ? 'compacting' : 'waiting-model',
    };
  }
  if (!progress) return activity;
  const { stage, ...options } = progress;
  return advanceRunActivity(
    activity?.runId === event.runId ? activity : createRunActivity(event.runId, turn.startedAt),
    stage,
    { ...options, at: options.at ?? event.timestamp },
    runningTool,
  );
}

function readTerminalDecision(data: Record<string, unknown>): boolean {
  const action = readTerminalGuardObservation(data)?.action;
  return action === 'commit' || action === 'rollback';
}
