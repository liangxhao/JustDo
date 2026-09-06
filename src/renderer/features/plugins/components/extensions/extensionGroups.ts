import type { InstalledOpenClawExtension } from '@shared/openclaw/extensions';

export const ExtensionGroupId = {
  SYSTEM: 'system',
  USER: 'user',
} as const;

export type ExtensionGroupId = (typeof ExtensionGroupId)[keyof typeof ExtensionGroupId];

export interface ExtensionGroup {
  id: ExtensionGroupId;
  extensions: InstalledOpenClawExtension[];
}

const groupOrder: ExtensionGroupId[] = [ExtensionGroupId.SYSTEM, ExtensionGroupId.USER];

const resolveExtensionGroup = (extension: InstalledOpenClawExtension): ExtensionGroupId => {
  return extension.managed || extension.origin === 'bundled'
    ? ExtensionGroupId.SYSTEM
    : ExtensionGroupId.USER;
};

/** Separates system-owned plugins from extensions installed by the user. */
export const groupExtensionsByOwnership = (
  extensions: InstalledOpenClawExtension[],
): ExtensionGroup[] => {
  const groups = new Map<ExtensionGroupId, InstalledOpenClawExtension[]>();

  for (const extension of extensions) {
    const groupId = resolveExtensionGroup(extension);
    groups.set(groupId, [...(groups.get(groupId) ?? []), extension]);
  }

  return groupOrder.flatMap(id => {
    const groupedExtensions = groups.get(id);
    return groupedExtensions ? [{ id, extensions: groupedExtensions }] : [];
  });
};
