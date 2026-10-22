import type { ToolItem } from '../chat-transcript-state';
import type { RunActivityOptions, RunProgressStage } from './run-activity';

export const RUN_STREAM_PROGRESS_ITEM_ID = 'run-stream-progress';

const startupStages: Readonly<Record<string, RunProgressStage>> = {
  waiting_for_state: 'preparing',
  preparing_workspace: 'preparing-workspace',
  naming_worktree: 'preparing-workspace',
  creating_worktree: 'preparing-workspace',
  running_setup: 'preparing-workspace',
  provisioning_environment: 'preparing-workspace',
  preparing_context: 'preparing',
  memory_flushing: 'memory-flushing',
  starting_model: 'starting-model',
};
const lifecycleStages: Readonly<Record<string, RunProgressStage>> = {
  queued: 'queued',
  preparing: 'preparing',
  waiting_model: 'waiting-model',
  retrying: 'retrying',
};

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const name = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= 256 ? value : undefined;

export function readRunningToolActivity(
  tools: ReadonlyMap<string, ToolItem> | undefined,
  toolCallId?: string,
): {
  stage: RunProgressStage;
  progress?: RunActivityOptions['progress'];
  modelActivity: true;
} {
  const candidate =
    toolCallId === undefined
      ? [...(tools?.values() ?? [])].reverse().find(item => item.status === 'running')
      : tools?.get(toolCallId);
  const tool = candidate?.status === 'running' ? candidate : undefined;
  return {
    stage: tool ? 'running-tool' : 'waiting-model',
    modelActivity: true,
    ...(tool
      ? {
          progress: {
            kind: 'tool',
            toolCallId: tool.toolCallId,
            name: tool.name,
            outputChars: tool.output?.length,
            summary: tool.progressText,
          } as const,
        }
      : {}),
  };
}

export function readCommandOutputActivity(
  tools: ReadonlyMap<string, ToolItem> | undefined,
  data: Record<string, unknown>,
): ({ stage: RunProgressStage } & RunActivityOptions) | null {
  const tool = typeof data.toolCallId === 'string' ? tools?.get(data.toolCallId) : undefined;
  if (tool?.status !== 'running' || typeof data.output !== 'string' || !data.output.length)
    return null;
  return {
    stage: 'running-tool',
    modelActivity: true,
    progress: {
      kind: 'tool',
      toolCallId: tool.toolCallId,
      name: tool.name,
      outputChars: data.output.length,
    },
  };
}

/** Read bounded native metadata; argument fragments and private model text stay in the runtime. */
export function readRunProgress(
  stream: string,
  data: Record<string, unknown>,
): ({ stage: RunProgressStage } & RunActivityOptions) | null {
  const phase = typeof data.phase === 'string' ? data.phase : '';
  if (stream === 'lifecycle' && phase === 'progress') {
    const stage =
      typeof data.stage === 'string' &&
      Object.prototype.hasOwnProperty.call(lifecycleStages, data.stage)
        ? lifecycleStages[data.stage]
        : undefined;
    return stage
      ? {
          stage,
          provider: typeof data.provider === 'string' ? data.provider : undefined,
          model: typeof data.model === 'string' ? data.model : undefined,
          retryReason: stage === 'retrying' ? data.reason : undefined,
          retryAttempt: stage === 'retrying' ? data.retryAttempt : undefined,
          maxRetries: stage === 'retrying' ? data.maxRetries : undefined,
          at: count(data.at),
        }
      : null;
  }
  if (
    stream === 'lifecycle' &&
    phase === 'fallback_step' &&
    data.fallbackStepFinalOutcome === 'next_fallback'
  ) {
    return { stage: 'retrying', retryReason: data.fallbackStepFromFailureReason };
  }
  if (stream === 'run_status' && phase === 'retrying') {
    return {
      stage: 'retrying',
      retryReason: data.reason,
      retryAttempt: data.retryAttempt,
      maxRetries: data.maxRetries,
      retryDelayMs: count(data.delayMs),
    };
  }
  if (
    stream === 'item' &&
    data.itemId === RUN_STREAM_PROGRESS_ITEM_ID &&
    data.kind === 'status' &&
    phase === 'update' &&
    data.status === 'running'
  ) {
    if (!data.progress || typeof data.progress !== 'object' || Array.isArray(data.progress))
      return null;
    const progress = data.progress as Record<string, unknown>;
    const receivedChars = count(progress.receivedChars);
    if (receivedChars === undefined) return null;
    if (progress.kind === 'tool-input') {
      const toolCallId = name(progress.toolCallId);
      const toolName = name(progress.name);
      if (!toolCallId || !toolName) return null;
      const complete = progress.complete === true;
      return {
        stage: complete ? 'preparing-tool' : 'generating-tool-input',
        modelActivity: true,
        progress: { kind: 'tool-input', toolCallId, name: toolName, receivedChars, complete },
      };
    }
    if (progress.kind === 'model') {
      return {
        stage: 'receiving-model',
        modelActivity: true,
        progress: { kind: 'model-stream', receivedChars },
      };
    }
    return null;
  }
  const stage =
    stream === 'run_status' && Object.prototype.hasOwnProperty.call(startupStages, phase)
      ? startupStages[phase]
      : undefined;
  return stage ? { stage } : null;
}
