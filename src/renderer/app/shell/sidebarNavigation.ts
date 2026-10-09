export const SidebarView = {
  Home: 'cowork',
  ScheduledTasks: 'scheduledTasks',
  Plugins: 'plugins',
  Memory: 'memory',
  Workboard: 'workboard',
} as const;

export type SidebarView = (typeof SidebarView)[keyof typeof SidebarView];
export type SidebarFeatureId = typeof SidebarView.Memory | typeof SidebarView.Workboard;

export const normalizeSidebarPins = (value: unknown): SidebarFeatureId[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value)].filter(
    (id): id is SidebarFeatureId => id === SidebarView.Memory || id === SidebarView.Workboard,
  );
};
