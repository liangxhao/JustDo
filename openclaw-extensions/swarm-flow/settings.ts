export const SWARM_SETTING_FIELDS = {
  globalConcurrency: { default: 3, minimum: 1, maximum: 16 },
  maxBatchItems: { default: 1000, minimum: 1, maximum: 1000 },
  executionTimeoutSeconds: { default: 14400, minimum: 600, maximum: 86400 },
  maxAttempts: { default: 3, minimum: 1, maximum: 3 },
  snapshotBudgetMiB: { default: 1024, minimum: 16, maximum: 16384 },
} as const;
export type SwarmSettings = Record<keyof typeof SWARM_SETTING_FIELDS, number>;
export function swarmSettings(value: unknown): SwarmSettings {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(SWARM_SETTING_FIELDS).map(([key, rule]) => {
      const current = input[key] ?? rule.default;
      if (
        !Number.isSafeInteger(current) ||
        Number(current) < rule.minimum ||
        Number(current) > rule.maximum
      )
        throw new Error('Invalid Swarm setting: ' + key);
      return [key, current];
    }),
  ) as SwarmSettings;
}
/** All plugin runs stay in the main lane, retaining one slot for conversation. */
export function swarmCapacity(config: unknown, settings: SwarmSettings): number {
  const current = config as { agents?: { defaults?: { maxConcurrent?: number } } } | undefined;
  const native = current?.agents?.defaults?.maxConcurrent ?? 4;
  if (!Number.isSafeInteger(native) || native < 1) return 0;
  return Math.min(settings.globalConcurrency, Math.max(0, native - 1));
}
