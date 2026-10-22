import { expect, it } from 'vitest';

import { buildManagedSwarmWorkflowPluginEntries } from '../../../../plugins/extensions/swarm-workflow/host/config';

it('projects only enabled, retained product assistants, deduplicating main', () => {
  const result = buildManagedSwarmWorkflowPluginEntries(
    [
      { id: 'main', enabled: true },
      { id: 'worker', enabled: true },
      { id: 'disabled', enabled: false },
      { id: 'deleted', enabled: true, deletedAt: 1 },
      { id: 'worker', enabled: true },
    ],
    () => true,
  );
  expect(result).toEqual({
    'swarm-workflow': { config: { availableAgentIds: ['main', 'worker'] } },
  });
});

it('does not project a plugin absent from the installed application resources', () => {
  expect(
    buildManagedSwarmWorkflowPluginEntries([{ id: 'worker', enabled: true }], () => false),
  ).toEqual({});
});
