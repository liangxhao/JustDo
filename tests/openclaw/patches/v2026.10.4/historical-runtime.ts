import { admitHistoricalRuntime, historicalRuntimePath } from '../historical-runtime';

/** Historical native probes must never execute the active version's owners. */
export function historicalRuntime(requested: string | undefined): string | undefined {
  return admitHistoricalRuntime(requested, '2026.10.4');
}

export function historicalRuntimeOrUnavailable(requested: string): string {
  return historicalRuntimePath(requested, '2026.10.4');
}
