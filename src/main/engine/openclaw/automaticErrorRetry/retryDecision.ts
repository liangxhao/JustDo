import { setTimeout as delay } from 'node:timers/promises';

import { type AutomaticErrorRetryRule, createAutomaticErrorRetryRuleIndex } from './rules';

const AUTOMATIC_ERROR_RETRY_INITIAL_DELAY_MS = 10_000;
const AUTOMATIC_ERROR_RETRY_DELAY_STEP_MS = 5_000;
const defaultRules = createAutomaticErrorRetryRuleIndex();

/** The transport owner supplies exact failure evidence and checks that it still owns the request. */
export async function waitForAutomaticErrorRetry({
  readFailureCode, isCurrent, attempt, signal, retryDelayMs, rules = defaultRules,
}: {
  readFailureCode: () => Promise<string | null>;
  isCurrent: () => boolean;
  attempt: number;
  signal: AbortSignal;
  retryDelayMs?: number;
  rules?: ReadonlyMap<string, AutomaticErrorRetryRule>;
}): Promise<AutomaticErrorRetryRule | undefined> {
  if (signal.aborted || !isCurrent()) return;
  const code = await readFailureCode();
  if (signal.aborted || !isCurrent() || !code) return;
  const rule = rules.get(code);
  if (!rule) return;
  const waitMs = retryDelayMs ?? AUTOMATIC_ERROR_RETRY_INITIAL_DELAY_MS + attempt * AUTOMATIC_ERROR_RETRY_DELAY_STEP_MS;
  if (waitMs > 0) await delay(waitMs, undefined, { signal });
  if (!signal.aborted && isCurrent()) return rule;
}
