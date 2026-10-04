import type { DiagnosticReport } from '../../../shared/cowork/sessionDiagnostics';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Stability deliberately omits session/run identities. Never merge it into run findings. */
export function projectDiagnosticEnvironment(
  value: unknown,
  collectedAt: number,
): DiagnosticReport['environment'] {
  const snapshot = object(value);
  if (!count(snapshot.count) || !count(snapshot.dropped))
    return { status: 'unavailable', collectedAt };
  const signals: NonNullable<DiagnosticReport['environment']['signals']> = {};
  let firstAt: number | undefined;
  let lastAt: number | undefined;
  for (const raw of Array.isArray(snapshot.events) ? snapshot.events.slice(0, 1000) : []) {
    const event = object(raw);
    if (count(event.ts)) {
      firstAt = Math.min(firstAt ?? event.ts, event.ts);
      lastAt = Math.max(lastAt ?? event.ts, event.ts);
    }
    const type = event.type;
    const category =
      type === 'model.call.error'
        ? 'model'
        : type === 'tool.execution.error'
          ? 'tool'
          : type === 'tool.execution.blocked'
            ? 'blocked'
            : type === 'exec.process.completed' &&
                (event.timedOut === true ||
                  event.outcome === 'failed' ||
                  (typeof event.exitCode === 'number' &&
                    Number.isInteger(event.exitCode) &&
                    event.exitCode !== 0))
              ? 'command'
              : type === 'session.stuck'
                ? 'stuck'
                : type === 'diagnostic.liveness.warning' && event.level === 'warning'
                  ? 'liveness'
                  : undefined;
    if (category) signals[category] = (signals[category] ?? 0) + 1;
  }
  return {
    status: 'available',
    collectedAt,
    stabilityCount: snapshot.count,
    stabilityDropped: snapshot.dropped,
    signals,
    ...(firstAt !== undefined ? { firstAt, lastAt } : {}),
  };
}
