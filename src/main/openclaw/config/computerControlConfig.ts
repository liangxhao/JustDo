import { OpenClawExtensionId, OpenClawToolName } from '../../../shared/openclaw/extensions';

export const asComputerConfigRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Couple desktop admission to the provider choice without changing other tool policies. */
export function withComputerControlPolicy(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const entries = asComputerConfigRecord(asComputerConfigRecord(config.plugins).entries);
  const enabled = asComputerConfigRecord(entries[OpenClawExtensionId.CUA_COMPUTER]).enabled;
  if (typeof enabled !== 'boolean') return config;
  const tools = asComputerConfigRecord(config.tools);
  const computer = OpenClawToolName.COMPUTER;
  const deny = strings(tools.deny).filter(value => value.trim().toLowerCase() !== computer);
  if (!enabled) {
    // Keep explicit allowlists intact: an emptied native allowlist is unrestricted.
    return { ...config, tools: { ...tools, deny: [...deny, computer] } };
  }
  const usesAllow = strings(tools.allow).length > 0;
  const key = usesAllow ? 'allow' : 'alsoAllow';
  return {
    ...config,
    tools: { ...tools, deny, [key]: [...new Set([...strings(tools[key]), computer])] },
  };
}

export function buildComputerControlPatch(config: Record<string, unknown>, enabled: boolean) {
  const plugins = asComputerConfigRecord(config.plugins);
  const entries = asComputerConfigRecord(plugins.entries);
  const id = OpenClawExtensionId.CUA_COMPUTER;
  const next = withComputerControlPolicy({
    ...config,
    plugins: {
      ...plugins,
      entries: { ...entries, [id]: { ...asComputerConfigRecord(entries[id]), enabled } },
    },
  });
  const tools = asComputerConfigRecord(next.tools);
  const usesAllow = strings(asComputerConfigRecord(config.tools).allow).length > 0;
  const admissionKey = usesAllow ? 'allow' : 'alsoAllow';
  const pluginPatch: Record<string, unknown> = { entries: { [id]: { enabled } } };
  const replacePaths = ['tools.deny'];
  if (enabled && strings(plugins.allow).length) {
    pluginPatch.allow = [...new Set([...strings(plugins.allow), id])];
    replacePaths.push('plugins.allow');
  }
  if (enabled && strings(plugins.deny).includes(id)) {
    pluginPatch.deny = strings(plugins.deny).filter(value => value !== id);
    replacePaths.push('plugins.deny');
  }
  if (enabled) replacePaths.push(`tools.${admissionKey}`);
  return {
    raw: JSON.stringify({
      plugins: pluginPatch,
      tools: { deny: tools.deny, ...(enabled ? { [admissionKey]: tools[admissionKey] } : {}) },
    }),
    replacePaths,
  };
}
