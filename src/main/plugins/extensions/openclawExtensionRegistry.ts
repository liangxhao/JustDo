import { OpenClawExtensionId } from '../../../shared/openclaw/extensions';
import { ScheduledTaskAgentId } from '../../../shared/scheduledTask/constants';

export type OpenClawExtensionDescriptor = {
  id: string;
  buildEntry: () => Record<string, unknown>;
};

export const bundledOpenClawExtensions: readonly OpenClawExtensionDescriptor[] = [
  {
    id: OpenClawExtensionId.ASK_USER_QUESTION,
    buildEntry: () => ({ enabled: true }),
  },
  {
    id: OpenClawExtensionId.AUTOMATION_PERMISSION,
    buildEntry: () => ({
      enabled: true,
      config: {
        unrestrictedAgentIds: [ScheduledTaskAgentId],
      },
    }),
  },
  {
    id: OpenClawExtensionId.JUSTDO_RUNTIME_BRIDGE,
    buildEntry: () => ({ enabled: true }),
  },
] as const;

export const buildBundledExtensionEntries = (
  isAvailable: (id: string) => boolean,
): Record<string, Record<string, unknown>> => {
  return Object.fromEntries(
    bundledOpenClawExtensions
      .filter(extension => isAvailable(extension.id))
      .map(extension => [extension.id, extension.buildEntry()]),
  );
};
