import { RESULT_PAGE_TRANSPORT_BUDGET, RESULT_TRANSPORT_BYTES } from '../contracts/batch.js';

const MAX_TRACKED_RUNS = 512;
type BudgetTrace = { traceId?: string; spanId?: string; parentSpanId?: string };
export type ResultBudgetAttempt = { traceId: string; spanId: string };
const scope = (sessionKey: string, runId: string) => JSON.stringify([sessionKey, runId]) + '\n';
const key = (sessionKey: string, runId: string, attempt: ResultBudgetAttempt) =>
  scope(sessionKey, runId) + JSON.stringify([attempt.traceId, attempt.spanId]);

/** Snapshot only the native attempt identity, never a diagnostic payload. */
export function resultBudgetAttempt(
  trace: BudgetTrace | undefined,
): ResultBudgetAttempt | undefined {
  const { traceId, spanId } = trace ?? {};
  if (
    typeof traceId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(traceId) ||
    /^0+$/.test(traceId) ||
    typeof spanId !== 'string' ||
    !/^[0-9a-f]{16}$/.test(spanId) ||
    /^0+$/.test(spanId)
  )
    return;
  return { traceId, spanId };
}

/** Content-free native model-call observations, never execution authority. */
export function createResultBudgetTracker() {
  const budgets = new Map<string, number>();
  return {
    observe(
      event: { sessionKey?: string; runId?: string; contextTokenBudget?: number },
      trace?: BudgetTrace,
    ) {
      const { sessionKey, runId, contextTokenBudget } = event;
      // Model-call spans are children of the tool preparation's attempt span.
      const attempt = resultBudgetAttempt({ traceId: trace?.traceId, spanId: trace?.parentSpanId });
      if (
        !attempt ||
        !sessionKey ||
        !/^agent:[^:]+:subagent:swarm-workflow-/.test(sessionKey) ||
        sessionKey.length > 256 ||
        !runId ||
        runId.length > 256
      )
        return;
      const budget =
        typeof contextTokenBudget === 'number' &&
        Number.isFinite(contextTokenBudget) &&
        contextTokenBudget > 0
          ? Math.min(RESULT_TRANSPORT_BYTES, Math.floor(contextTokenBudget / 2))
          : RESULT_PAGE_TRANSPORT_BUDGET;
      const identity = key(sessionKey, runId, attempt);
      // Delayed/duplicate observations must not widen an already observed cap.
      budgets.set(identity, Math.min(budgets.get(identity) ?? budget, budget));
      if (budgets.size > MAX_TRACKED_RUNS) budgets.delete(budgets.keys().next().value!);
    },
    read(sessionKey: string, runId: string, attempt?: ResultBudgetAttempt) {
      return attempt
        ? (budgets.get(key(sessionKey, runId, attempt)) ?? RESULT_PAGE_TRANSPORT_BUDGET)
        : RESULT_PAGE_TRANSPORT_BUDGET;
    },
    release(sessionKey: string | undefined, runId: string | undefined) {
      if (sessionKey && runId) {
        const prefix = scope(sessionKey, runId);
        for (const identity of budgets.keys())
          if (identity.startsWith(prefix)) budgets.delete(identity);
      }
    },
    clear() {
      budgets.clear();
    },
  };
}
