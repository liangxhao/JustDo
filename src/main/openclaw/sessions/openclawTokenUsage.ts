export interface OpenClawTokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const readUsageNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export const extractOpenClawTokenUsage = (usage: unknown): OpenClawTokenUsage | undefined => {
  if (!isRecord(usage)) return undefined;
  const input =
    readUsageNumber(usage.input) ??
    readUsageNumber(usage.inputTokens) ??
    readUsageNumber(usage.input_tokens) ??
    readUsageNumber(usage.promptTokens) ??
    readUsageNumber(usage.prompt_tokens);
  const output =
    readUsageNumber(usage.output) ??
    readUsageNumber(usage.outputTokens) ??
    readUsageNumber(usage.output_tokens) ??
    readUsageNumber(usage.completionTokens) ??
    readUsageNumber(usage.completion_tokens);
  const cacheRead =
    readUsageNumber(usage.cacheRead) ??
    readUsageNumber(usage.cache_read) ??
    readUsageNumber(usage.cache_read_input_tokens);
  const cacheWrite =
    readUsageNumber(usage.cacheWrite) ??
    readUsageNumber(usage.cache_write) ??
    readUsageNumber(usage.cache_creation_input_tokens);
  const total =
    readUsageNumber(usage.total) ??
    readUsageNumber(usage.totalTokens) ??
    readUsageNumber(usage.total_tokens);

  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
};
