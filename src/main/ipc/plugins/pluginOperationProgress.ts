import type { IpcMainInvokeEvent } from 'electron';

import type { PluginKind } from '../../../shared/plugins/marketplace';
import {
  type PluginOperationAction,
  type PluginOperationContext,
  type PluginOperationFeedback,
  PluginOperationIpc,
  type PluginOperationProgress,
  PluginOperationStage,
  toPluginOperationStage,
} from '../../../shared/plugins/pluginOperation';

export interface PluginOperationReporter {
  report: (stage: PluginOperationStage) => void;
  finish: () => void;
  captureFailure: () => void;
  result: <T extends { success: boolean }>(result: T) => T & PluginOperationFeedback;
}

export const withPluginOperationFailure = <T extends { success: boolean }>(
  reporter: PluginOperationReporter | undefined,
  result: T,
): T & PluginOperationFeedback => reporter?.result(result) ?? result;

export const createPluginOperationReporter = (
  event: IpcMainInvokeEvent | undefined,
  context: PluginOperationContext | undefined,
  kind: PluginKind,
  action: PluginOperationAction,
): PluginOperationReporter => {
  if (
    context !== undefined &&
    (!context ||
      typeof context !== 'object' ||
      Array.isArray(context) ||
      typeof context.requestId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(context.requestId))
  ) {
    throw new Error('Invalid plugin operation request id');
  }
  const startedAt = performance.now();
  let stageStartedAt = startedAt;
  let currentStage: PluginOperationStage | undefined;
  let failedStage: PluginOperationStage | undefined;
  let finished = false;
  const logDuration = (now: number) => {
    if (!context || !currentStage) return;
    // Closed metadata only: package paths, names, credentials and SDK output stay private.
    console.info('[PluginOperations] Stage finished', {
      requestId: context.requestId,
      kind,
      action,
      stage: currentStage,
      durationMs: Math.round(now - stageStartedAt),
      elapsedMs: Math.round(now - startedAt),
    });
  };
  return {
    report: stage => {
      if (finished || currentStage === stage) return;
      // Rollback is recovery after a failed business step. Retain that step;
      // a later explicit mutation result still owns the authoritative outcome.
      if (stage === PluginOperationStage.ROLLING_BACK) failedStage ??= currentStage;
      const now = performance.now();
      logDuration(now);
      stageStartedAt = now;
      currentStage = stage;
      if (!context || !event?.sender) return;
      const progress: PluginOperationProgress = {
        requestId: context.requestId,
        kind,
        action,
        stage,
        elapsedMs: Math.round(now - startedAt),
      };
      try {
        if (event.sender.isDestroyed()) return;
        event.sender.send(PluginOperationIpc.Progress, progress);
      } catch {
        // Closing a view cannot change the outcome of an already admitted mutation.
      }
    },
    finish: () => {
      if (finished) return;
      finished = true;
      logDuration(performance.now());
    },
    captureFailure: () => {
      failedStage ??= currentStage;
    },
    result: result => {
      const details = result as typeof result & {
        failedStage?: string;
        capabilityReview?: unknown;
      };
      if (result.success || details.capabilityReview) return result;
      const explicitStage = toPluginOperationStage(details.failedStage ?? '');
      failedStage = explicitStage ?? failedStage ?? currentStage;
      return failedStage ? { ...result, failedStage } : result;
    },
  };
};
