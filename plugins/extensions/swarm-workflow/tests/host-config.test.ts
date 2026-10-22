import { describe, expect, test } from 'vitest';

import manifest from '../openclaw.plugin.json';
import { buildManagedSwarmWorkflowPluginEntries } from '../host/config';

describe('Swarm Workflow host configuration', () => {
  test('defaults the native plugin to disabled', () => {
    expect(manifest.enabledByDefault).toBe(false);
  });

  test('refreshes available agents without choosing plugin enablement', () => {
    const entries = buildManagedSwarmWorkflowPluginEntries([
      { id: 'main', enabled: true },
      { id: 'reviewer', enabled: true },
      { id: 'reviewer', enabled: true },
      { id: 'disabled', enabled: false },
      { id: 'deleted', enabled: true, deletedAt: 123 },
    ], () => true);

    expect(entries).toEqual({
      'swarm-workflow': { config: { availableAgentIds: ['main', 'reviewer'] } },
    });
  });

  test('omits the configuration when the plugin is unavailable', () => {
    expect(buildManagedSwarmWorkflowPluginEntries([], () => false)).toEqual({});
  });
});
