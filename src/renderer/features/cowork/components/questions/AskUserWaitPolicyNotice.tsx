import type { AskUserQuestion } from '@shared/openclaw/extensions';
import {
  AskUserTimeoutBehavior,
  AskUserWaitMode,
  parseAskUserWaitPolicy,
} from '@shared/openclaw/extensions';
import React, { useEffect, useMemo, useState } from 'react';

import { i18nService } from '@/services/i18n';

interface AskUserWaitPolicyNoticeProps {
  questions: AskUserQuestion[];
  toolInput: Record<string, unknown>;
}

export const formatAskUserCountdown = (expiresAt: number, now: number): string => {
  const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const AskUserWaitPolicyNotice: React.FC<AskUserWaitPolicyNoticeProps> = ({
  questions,
  toolInput,
}) => {
  const [now, setNow] = useState(Date.now());
  const waitPolicy = useMemo(
    () => parseAskUserWaitPolicy(toolInput.waitPolicy, questions),
    [questions, toolInput.waitPolicy],
  );
  const expiresAt =
    typeof toolInput.expiresAt === 'number' && Number.isFinite(toolInput.expiresAt)
      ? toolInput.expiresAt
      : null;

  useEffect(() => {
    setNow(Date.now());
    if (waitPolicy?.mode !== AskUserWaitMode.TIMEOUT || expiresAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, waitPolicy?.mode]);

  if (!waitPolicy) return null;
  const message =
    waitPolicy.mode === AskUserWaitMode.REQUIRED
      ? i18nService.t('coworkQuestionWaitRequired')
      : i18nService.t(
          waitPolicy.onTimeout === AskUserTimeoutBehavior.USE_DEFAULTS
            ? 'coworkQuestionWaitDefaults'
            : 'coworkQuestionWaitModelDecides',
        );
  const countdown =
    waitPolicy.mode === AskUserWaitMode.TIMEOUT && expiresAt !== null
      ? formatAskUserCountdown(expiresAt, now)
      : null;
  const isRequired = waitPolicy.mode === AskUserWaitMode.REQUIRED;

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs ${
        isRequired
          ? 'bg-surface-raised text-secondary'
          : 'border border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300'
      }`}
    >
      <span>{message}</span>
      {countdown && (
        <span className="shrink-0 rounded-md bg-blue-100 px-2 py-1 font-mono font-semibold tabular-nums text-blue-900 dark:bg-blue-900/60 dark:text-blue-100">
          {i18nService.t('coworkQuestionTimeoutCountdown').replace('{countdown}', countdown)}
        </span>
      )}
    </div>
  );
};

export default AskUserWaitPolicyNotice;
