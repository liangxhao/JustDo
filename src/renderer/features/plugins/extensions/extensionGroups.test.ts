import type { InstalledOpenClawExtension } from '@shared/plugins/extensions';
import { expect, test } from 'vitest';

import {
  ExtensionGroupId,
  groupExtensionsByOwnership,
} from '@/features/plugins/extensions/extensionGroups';

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

  expect(groups.map(group => group.id)).toEqual([ExtensionGroupId.USER, ExtensionGroupId.SYSTEM]);
  expect(groups[0].extensions.map(extension => extension.id)).toEqual([
    'user-local',
    'user-package',
  ]);
  expect(groups[1].extensions.map(extension => extension.id)).toEqual(['bundled', 'managed']);
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

test('keeps both ownership lists fixed when discovery order changes', () => {
  const extensions = [
    createExtension('user-10', { name: 'Plugin 10', origin: 'local' }),
    createExtension('system-10', { name: 'Plugin 10', origin: 'bundled', canToggle: true }),
    createExtension('user-shared-b', { name: 'Shared', origin: 'npm' }),
    createExtension('system-shared-b', { name: 'Shared', origin: 'bundled', canToggle: true }),
    createExtension('user-2', { name: 'plugin 2', origin: 'local', enabled: false }),
    createExtension('system-2', { name: 'plugin 2', origin: 'bundled', canToggle: true }),
    createExtension('user-shared-a', { name: 'shared', origin: 'npm' }),
    createExtension('system-shared-a', { name: 'shared', origin: 'bundled', canToggle: true }),
  ];
  const initialOrder = extensions.map(extension => extension.id);
  const expected = [
    ['user-2', 'user-10', 'user-shared-a', 'user-shared-b'],
    ['system-2', 'system-10', 'system-shared-a', 'system-shared-b'],
  ];

  for (const inventory of [
    extensions,
    [...extensions].reverse(),
    [...extensions.slice(3), ...extensions.slice(0, 3)],
  ]) {
    const groups = groupExtensionsByOwnership(inventory);

    expect(groups.map(group => group.extensions.map(extension => extension.id))).toEqual(expected);
  }
  expect(extensions.map(extension => extension.id)).toEqual(initialOrder);
});

test('keeps toggleable system extensions before locked ones with a fixed order inside each class', () => {
  const extensions = [
    createExtension('locked-b', { name: 'B Locked', managed: true }),
    createExtension('toggle-z', { name: 'Z Toggle', origin: 'bundled', canToggle: true }),
    createExtension('locked-a', { name: 'A Locked', managed: true }),
    createExtension('toggle-c', { name: 'C Toggle', origin: 'bundled', canToggle: true }),
  ];

  for (const inventory of [extensions, [...extensions].reverse()]) {
    const groups = groupExtensionsByOwnership(inventory);

    expect(groups[0].extensions.map(extension => extension.id)).toEqual([
      'toggle-c',
      'toggle-z',
      'locked-a',
      'locked-b',
    ]);
  }
});
