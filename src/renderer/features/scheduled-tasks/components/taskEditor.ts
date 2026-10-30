import type { AgentTurnPayload, ScheduledTask } from '@shared/scheduledTask/types';

export interface AdvancedTaskForm {
  timeoutSeconds: string;
  fallbackMode: 'inherit' | 'none' | 'custom';
  fallbackText: string;
  lightContext: boolean;
  keepOnce: boolean;
}

export function parseAdvancedTaskForm(
  job?: Pick<ScheduledTask, 'payload' | 'deleteAfterRun'>,
): AdvancedTaskForm {
  const payload = job?.payload.kind === 'agentTurn' ? job.payload : undefined;
  return {
    timeoutSeconds: payload?.timeoutSeconds === undefined ? '' : String(payload.timeoutSeconds),
    fallbackMode:
      payload?.fallbacks === undefined
        ? 'inherit'
        : payload.fallbacks.length === 0
          ? 'none'
          : 'custom',
    fallbackText: payload?.fallbacks?.join(', ') ?? '',
    lightContext: payload?.lightContext ?? false,
    keepOnce: job?.deleteAfterRun === false,
  };
}

export function parseFallbackModels(text: string): string[] {
  const models = text
    .split(/[,\n]/)
    .map(value => value.trim())
    .filter(Boolean);
  if (
    models.length === 0 ||
    models.length > 20 ||
    models.some(value => value.length > 512 || !/^[^\s/]+\/\S+$/.test(value))
  ) {
    throw new RangeError('Invalid fallback models');
  }
  return models;
}

/** Return only changed overrides; null is the native explicit reset sentinel. */
export function buildAdvancedPayloadPatch(form: AdvancedTaskForm, original?: AgentTurnPayload) {
  const initial = parseAdvancedTaskForm(original ? { payload: original } : undefined);
  const patch: {
    timeoutSeconds?: number | null;
    fallbacks?: string[] | null;
    lightContext?: boolean;
  } = {};
  if (form.timeoutSeconds !== initial.timeoutSeconds) {
    const timeout = form.timeoutSeconds.trim() ? Number(form.timeoutSeconds) : null;
    if (timeout !== null && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
      throw new RangeError('Invalid task timeout');
    }
    patch.timeoutSeconds = timeout;
  }
  if (
    form.fallbackMode !== initial.fallbackMode ||
    (form.fallbackMode === 'custom' && form.fallbackText !== initial.fallbackText)
  ) {
    patch.fallbacks =
      form.fallbackMode === 'inherit'
        ? null
        : form.fallbackMode === 'none'
          ? []
          : parseFallbackModels(form.fallbackText);
  }
  if (form.lightContext !== initial.lightContext) patch.lightContext = form.lightContext;
  return patch;
}
