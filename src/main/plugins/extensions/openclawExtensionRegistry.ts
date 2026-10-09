import { OpenClawExtensionId } from '../../../shared/plugins/nativeIds';

export type OpenClawExtensionDescriptor = {
  id: string;
  buildEntry: (
    automationApprovalTimeoutMinutes: number,
    windowsSandboxEnabled: boolean,
    sandboxNetworkEnabled: boolean,
  ) => Record<string, unknown>;
};

export const bundledOpenClawExtensions: readonly OpenClawExtensionDescriptor[] = [
  {
    id: OpenClawExtensionId.STT_LOCAL_CLI,
    buildEntry: () => ({ enabled: true }),
  },
  {
    id: OpenClawExtensionId.ACPX,
    buildEntry: () => ({ enabled: true }),
  },
  {
    id: OpenClawExtensionId.ASK_USER_QUESTION,
    buildEntry: () => ({ enabled: true }),
  },
  {
    id: OpenClawExtensionId.AUTOMATION_PERMISSION,
    buildEntry: approvalTimeoutMinutes => ({
      enabled: true,
      config: {
        approvalTimeoutMinutes,
      },
    }),
  },
  {
    id: OpenClawExtensionId.RUNTIME_SERVICES,
    buildEntry: () => ({ enabled: true }),
  },
  {
    id: OpenClawExtensionId.PLAN_MODE,
    buildEntry: () => ({ enabled: true }),
  },
  {
    id: OpenClawExtensionId.EMBEDDED_BROWSER,
    // Fail closed. Config sync enables this provider only for embedded mode,
    // where the native Browser plugin is explicitly disabled.
    buildEntry: () => ({ enabled: false }),
  },
  {
    id: OpenClawExtensionId.WINDOWS_NATIVE_SANDBOX,
    buildEntry: (_approvalTimeoutMinutes, windowsSandboxEnabled, sandboxNetworkEnabled) => ({
      enabled: windowsSandboxEnabled,
      ...(windowsSandboxEnabled
        ? {
            config: {
              containment: 'processcontainer',
              network: sandboxNetworkEnabled ? 'default' : 'none',
            },
          }
        : {}),
    }),
  },
] as const;

export const buildBundledExtensionEntries = (
  isAvailable: (id: string) => boolean,
  automationApprovalTimeoutMinutes: number,
  windowsSandboxEnabled = false,
  sandboxNetworkEnabled = false,
): Record<string, Record<string, unknown>> => {
  return Object.fromEntries(
    bundledOpenClawExtensions
      .filter(extension => isAvailable(extension.id))
      .map(extension => [
        extension.id,
        extension.buildEntry(
          automationApprovalTimeoutMinutes,
          windowsSandboxEnabled,
          sandboxNetworkEnabled,
        ),
      ]),
  );
};
