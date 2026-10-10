import type { InstalledOpenClawExtension } from '@shared/plugins/extensions';

export const ExtensionGroupId = {
  SYSTEM: 'system',
  USER: 'user',
} as const;

export type ExtensionGroupId = (typeof ExtensionGroupId)[keyof typeof ExtensionGroupId];

export interface ExtensionGroup {
  id: ExtensionGroupId;
  extensions: InstalledOpenClawExtension[];
}

const groupOrder: ExtensionGroupId[] = [ExtensionGroupId.USER, ExtensionGroupId.SYSTEM];

export const canToggleExtension = (extension: InstalledOpenClawExtension): boolean =>
  extension.management
    ? (extension.enabled ? extension.management.disable : extension.management.enable).allowed
    : extension.canToggle === true;

const resolveExtensionGroup = (extension: InstalledOpenClawExtension): ExtensionGroupId => {
  return extension.managed || extension.origin === 'bundled'
    ? ExtensionGroupId.SYSTEM
    : ExtensionGroupId.USER;
};

/** Separates ownership groups and places locked system plugins after toggleable ones. */
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
    if (!groupedExtensions) return [];
    const orderedExtensions =
      id === ExtensionGroupId.SYSTEM
        ? [...groupedExtensions].sort(
            (a, b) => Number(canToggleExtension(b)) - Number(canToggleExtension(a)),
          )
        : groupedExtensions;
    return [{ id, extensions: orderedExtensions }];
  });
};
