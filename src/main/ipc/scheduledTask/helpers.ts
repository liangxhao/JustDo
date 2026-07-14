import type { ScheduledTaskChannelOption } from '../../../scheduledTask/types';

export interface ScheduledTaskHelperDeps {
  getIMGatewayManager: () => {
    getConfig: () => Record<string, unknown> | null;
  } | null;
}

let deps: ScheduledTaskHelperDeps | null = null;

export function initScheduledTaskHelpers(d: ScheduledTaskHelperDeps): void {
  deps = d;
}

const SCHEDULED_TASK_CHANNEL_OPTIONS: readonly ScheduledTaskChannelOption[] = [
  {
    value: 'welink',
    label: 'WeLink',
    disabled: true,
  },
];

export function listScheduledTaskChannels(): ScheduledTaskChannelOption[] {
  void deps;
  return SCHEDULED_TASK_CHANNEL_OPTIONS.map((option) => ({ ...option }));
}
