import { i18nService } from '@/services/i18n';

import type { RunActivity, RunProgressStage } from '../../model/turn/run-activity';
import { resolveToolDisplay } from '../tools/tool-display';

export const runProgressLabelKeys = {
  starting: 'coworkWorkingStarting',
  queued: 'coworkWorkingQueued',
  preparing: 'coworkWorkingPreparing',
  'preparing-workspace': 'coworkWorkingWorkspace',
  'starting-model': 'coworkWorkingModelStart',
  'memory-flushing': 'coworkWorkingMemory',
  'receiving-model': 'coworkWorkingModelStream',
  'generating-tool-input': 'coworkWorkingToolInput',
  'preparing-tool': 'coworkWorkingToolReady',
  compacting: 'coworkWorkingCompacting',
  'waiting-model': 'coworkWorkingWaiting',
  thinking: 'coworkWorkingThinking',
  responding: 'coworkWorkingResponding',
  'running-tool': 'coworkWorkingTool',
  retrying: 'coworkWorkingRetrying',
} as const satisfies Record<RunProgressStage, string>;

const format = (key: string, value: number, field = 'count') =>
  i18nService.t(key).replace(`{${field}}`, value.toLocaleString(i18nService.getLanguage()));

/** Counters use the existing UI clock and stay outside the live region announcing stages. */
export function runProgressDetail(
  activity: Readonly<RunActivity> | undefined,
  now: number,
): string | undefined {
  if (!activity) return undefined;
  const parts: string[] = [];
  const progress = activity.progress;
  if (progress?.kind === 'tool-input' || progress?.kind === 'tool') {
    parts.push(resolveToolDisplay(progress.name).title);
    if (progress.kind === 'tool-input' && progress.receivedChars > 0)
      parts.push(format('coworkProgressReceivedChars', progress.receivedChars));
    if (progress.kind === 'tool') {
      if (progress.summary) parts.push(progress.summary.slice(0, 240));
      else if (progress.outputChars)
        parts.push(format('coworkProgressOutputChars', progress.outputChars));
    }
  } else if (progress?.kind === 'model-stream' && progress.receivedChars > 0) {
    parts.push(format('coworkProgressReceivedChars', progress.receivedChars));
  }
  if (activity.stage === 'retrying' && activity.retryReason !== 'tool_call_format') {
    if (activity.retryAttempt !== undefined && activity.maxRetries !== undefined) {
      parts.push(
        i18nService
          .t('coworkProgressRetryCount')
          .replace('{attempt}', String(activity.retryAttempt))
          .replace('{max}', String(activity.maxRetries)),
      );
    }
    if (activity.retryAt !== undefined && now < activity.retryAt)
      parts.push(
        format('coworkProgressRetryIn', Math.ceil((activity.retryAt - now) / 1_000), 'seconds'),
      );
  } else if (activity.lastModelActivityAt !== null && progress) {
    const seconds = Math.max(0, Math.floor((now - activity.lastModelActivityAt) / 1_000));
    parts.push(
      seconds < 1
        ? i18nService.t('coworkProgressUpdatedNow')
        : format('coworkProgressUpdatedAgo', seconds, 'seconds'),
    );
  }
  return parts.length ? parts.join(' · ') : undefined;
}
