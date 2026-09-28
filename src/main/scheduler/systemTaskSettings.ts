import type { SystemTaskSettings, SystemTaskSettingsPatch } from '../../shared/scheduledTask/types';

type ConfigRecord = Record<string, unknown>;
const record = (value: unknown): ConfigRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ConfigRecord) : {};

export function readSystemTaskSettings(value: unknown): SystemTaskSettings {
  const config = record(value);
  const plugins = record(config.plugins);
  const memory = record(record(plugins.entries)['memory-core']);
  const slot = record(plugins.slots).memory;
  const mode = record(record(record(config.skills).workshop).autonomous).mode;
  return {
    memoryDreamingEnabled: record(record(memory.config).dreaming).enabled !== false,
    memoryAvailable:
      (slot === undefined || slot === 'memory-core') &&
      plugins.enabled !== false &&
      !(
        Array.isArray(plugins.allow) &&
        plugins.allow.length > 0 &&
        !plugins.allow.includes('memory-core')
      ) &&
      memory.enabled !== false &&
      !(Array.isArray(plugins.deny) && plugins.deny.includes('memory-core')),
    skillMode: mode === 'auto' || mode === 'propose' ? mode : 'off',
  };
}

export function buildSystemTaskSettingsPatch(
  input: SystemTaskSettingsPatch,
  config: unknown,
): ConfigRecord {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(key => !['memoryDreamingEnabled', 'skillMode'].includes(key))
  )
    throw new Error('Invalid system task settings');
  const patch: ConfigRecord = {};
  if (input.memoryDreamingEnabled !== undefined) {
    if (
      typeof input.memoryDreamingEnabled !== 'boolean' ||
      !readSystemTaskSettings(config).memoryAvailable
    )
      throw new Error('Memory dreaming settings are unavailable');
    patch.plugins = {
      entries: {
        'memory-core': { config: { dreaming: { enabled: input.memoryDreamingEnabled } } },
      },
    };
  }
  if (input.skillMode !== undefined) {
    if (!['off', 'propose', 'auto'].includes(input.skillMode))
      throw new Error('Invalid skill automation mode');
    patch.skills = { workshop: { autonomous: { mode: input.skillMode } } };
  }
  return patch;
}
