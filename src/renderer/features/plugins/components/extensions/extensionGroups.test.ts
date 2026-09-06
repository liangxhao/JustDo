import type { InstalledOpenClawExtension } from '@shared/openclaw/extensions';
import { expect, test } from 'vitest';

import {
  ExtensionGroupId,
  groupExtensionsByOwnership,
} from '@/features/plugins/components/extensions/extensionGroups';

const createExtension = (
  id: string,
  overrides: Partial<InstalledOpenClawExtension> = {},
): InstalledOpenClawExtension => ({
  id,
  name: id,
  description: '',
  enabled: true,
  missingRequirements: [],
  configurationFields: [],
  ...overrides,
});

test('groups managed and bundled OpenClaw plugins separately from user installs', () => {
  const groups = groupExtensionsByOwnership([
    createExtension('user-local', { origin: 'local' }),
    createExtension('bundled', { origin: 'bundled' }),
    createExtension('managed', { managed: true, origin: 'local' }),
    createExtension('user-package', { origin: 'npm' }),
  ]);

  expect(groups.map(group => group.id)).toEqual([ExtensionGroupId.SYSTEM, ExtensionGroupId.USER]);
  expect(groups[0].extensions.map(extension => extension.id)).toEqual(['bundled', 'managed']);
  expect(groups[1].extensions.map(extension => extension.id)).toEqual([
    'user-local',
    'user-package',
  ]);
});

test('keeps unknown origins visible as user-owned extensions', () => {
  const groups = groupExtensionsByOwnership([createExtension('future')]);

  expect(groups).toEqual([
    expect.objectContaining({
      id: ExtensionGroupId.USER,
      extensions: [expect.objectContaining({ id: 'future' })],
    }),
  ]);
});
