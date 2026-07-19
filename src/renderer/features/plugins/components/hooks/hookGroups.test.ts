import { expect, test } from 'vitest';

import { HookEntry } from '../../types/hook';
import { groupHooksBySource, HookGroupId } from './hookGroups';

const createHook = (id: string, source: string, managedByPlugin = false): HookEntry => ({
  id,
  name: id,
  description: '',
  enabled: false,
  eligible: false,
  requirementsSatisfied: true,
  loadable: false,
  source,
  events: [],
  missing: { bins: [], env: [], config: [], os: [] },
  managedByPlugin,
});

test('groups custom Hooks before bundled and plugin-managed Hooks', () => {
  const groups = groupHooksBySource([
    createHook('bundled', 'openclaw-bundled'),
    createHook('plugin', 'openclaw-extra', true),
    createHook('custom', 'openclaw-managed'),
  ]);

  expect(groups.map(group => group.id)).toEqual([
    HookGroupId.CUSTOM,
    HookGroupId.BUNDLED,
    HookGroupId.PLUGIN,
  ]);
});
