import { admitHistoricalRuntime, historicalRuntimePath } from '../historical-runtime';

export const historicalRuntime = (requested: string | undefined): string | undefined =>
  admitHistoricalRuntime(requested, '2026.10.6');

export const historicalRuntimeOrUnavailable = (requested: string): string =>
  historicalRuntimePath(requested, '2026.10.6');
