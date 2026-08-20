import type { AskUserQuestion } from '@shared/openclaw/extensions';
import {
  AskUserTimeoutBehavior,
  AskUserWaitMode,
  parseAskUserWaitPolicy,
} from '@shared/openclaw/extensions';
import React, { useMemo } from 'react';

import { i18nService } from '@/services/i18n';

interface AskUserWaitPolicyNoticeProps {
  questions: AskUserQuestion[];
  toolInput: Record<string, unknown>;
}

const AskUserWaitPolicyNotice: React.FC<AskUserWaitPolicyNoticeProps> = ({
  questions,
  toolInput,
}) => {
  const waitPolicy = useMemo(
    () => parseAskUserWaitPolicy(toolInput.waitPolicy, questions),
    [questions, toolInput.waitPolicy],
  );

  if (!waitPolicy) return null;

  const message =
    waitPolicy.mode === AskUserWaitMode.REQUIRED
      ? i18nService.t('coworkQuestionWaitRequired')
      : i18nService
          .t(
            waitPolicy.onTimeout === AskUserTimeoutBehavior.USE_DEFAULTS
              ? 'coworkQuestionWaitDefaults'
              : 'coworkQuestionWaitModelDecides',
          )
          .replace('{minutes}', String(waitPolicy.timeoutMinutes));
  const expiresAt =
    typeof toolInput.expiresAt === 'number' && Number.isFinite(toolInput.expiresAt)
      ? toolInput.expiresAt
      : null;
  const deadline =
    waitPolicy.mode === AskUserWaitMode.TIMEOUT && expiresAt
      ? new Date(expiresAt).toLocaleTimeString(
          i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US',
          { hour: '2-digit', minute: '2-digit' },
        )
      : null;

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
      {message}
      {deadline && (
        <span className="ml-1">
          {i18nService.t('coworkQuestionTimeoutDeadline').replace('{deadline}', deadline)}
        </span>
      )}
    </div>
  );
};

export default AskUserWaitPolicyNotice;
