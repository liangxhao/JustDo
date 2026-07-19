import { HookEntry } from '@/features/plugins/types/hook';

export const HookGroupId = {
  CUSTOM: 'custom',
  BUNDLED: 'bundled',
  PLUGIN: 'plugin',
  OTHER: 'other',
} as const;

export type HookGroupId = (typeof HookGroupId)[keyof typeof HookGroupId];

export interface HookGroup {
  id: HookGroupId;
  hooks: HookEntry[];
}

const groupOrder: HookGroupId[] = [
  HookGroupId.CUSTOM,
  HookGroupId.BUNDLED,
  HookGroupId.PLUGIN,
  HookGroupId.OTHER,
];

const getGroupId = (hook: HookEntry): HookGroupId => {
  if (hook.managedByPlugin) return HookGroupId.PLUGIN;
  if (hook.source === 'openclaw-managed') return HookGroupId.CUSTOM;
  if (hook.source === 'openclaw-bundled') return HookGroupId.BUNDLED;
  return HookGroupId.OTHER;
};

export const groupHooksBySource = (hooks: HookEntry[]): HookGroup[] => {
  const groups = new Map<HookGroupId, HookEntry[]>();
  for (const hook of hooks) {
    const groupId = getGroupId(hook);
    groups.set(groupId, [...(groups.get(groupId) ?? []), hook]);
  }
  return groupOrder.flatMap(id => {
    const groupedHooks = groups.get(id);
    return groupedHooks ? [{ id, hooks: groupedHooks }] : [];
  });
};
