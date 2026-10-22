import type { AgentRuntimeSettings } from '../../../../shared/agents/agentRuntimeSettings';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Project the product App host choice while preserving unrelated native options. */
export function buildManagedMcpConfig(
  existing: unknown,
  servers: unknown,
  settings: AgentRuntimeSettings['mcp'],
): Record<string, unknown> {
  const previous = record(existing);
  return {
    ...previous,
    servers,
    apps: {
      ...record(previous.apps),
      enabled: settings.appsEnabled,
    },
  };
}
