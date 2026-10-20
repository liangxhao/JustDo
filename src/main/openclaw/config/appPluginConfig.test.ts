import { expect, test } from 'vitest';

import { buildDefaultOpenClawPluginEntries, isUserToggleableBundledPlugin,mergeOpenClawPluginConfig } from './openclawConfigBuilders';

test.each([false, true])('preserves declared desktop user settings while replacing managed roster (enabled=%s)', enabled => {
  const id = 'example-desktop-owner';
  const existing = { entries: { [id]: { enabled, config: { limit: 7, availableAgentIds: ['retired'] } } } };
  const projected = { [id]: { config: { availableAgentIds: ['current'] } } };
  expect(mergeOpenClawPluginConfig(existing, projected, [], null, [id]).entries).toEqual({ [id]: { enabled, config: { limit: 7, availableAgentIds: ['current'] } } });
  const policies = { [id]: { defaultEnabled: true, userToggleable: true } };
  expect(buildDefaultOpenClawPluginEntries(() => true, policies)[id]).toEqual({ enabled: true });
  expect(isUserToggleableBundledPlugin(id, policies)).toBe(true);
  expect(isUserToggleableBundledPlugin(id)).toBe(false);
});
