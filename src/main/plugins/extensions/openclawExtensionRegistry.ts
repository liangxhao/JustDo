import type { PermissionMode } from '../../../shared/openclaw/approvals';
import { OpenClawExtensionId } from '../../../shared/openclaw/extensions';
import type { AskUserExtensionConfig } from '../../openclaw/config/openclawConfigSync';

export type OpenClawExtensionContext = {
  askUser: AskUserExtensionConfig | null;
  permissionMode: PermissionMode;
};

export type OpenClawExtensionDescriptor = {
  id: string;
  buildEntry: (context: OpenClawExtensionContext) => Record<string, unknown>;
  buildToolContracts?: (context: OpenClawExtensionContext) => string[];
};

const SECRET_PLACEHOLDER = '${JUSTDO_ASK_USER_SECRET}';

export const bundledOpenClawExtensions: readonly OpenClawExtensionDescriptor[] = [
  {
    id: OpenClawExtensionId.ASK_USER_QUESTION,
    buildEntry: ({ askUser }) => ({
      enabled: true,
      ...(askUser
        ? {
            config: {
              callbackUrl: askUser.askUserCallbackUrl,
              secret: SECRET_PLACEHOLDER,
            },
          }
        : {}),
    }),
  },
  {
    id: OpenClawExtensionId.PERMISSION_POLICY,
    buildEntry: ({ permissionMode }) => ({
      enabled: true,
      config: { mode: permissionMode },
    }),
  },
] as const;

export const buildBundledExtensionEntries = (
  context: OpenClawExtensionContext,
  isAvailable: (id: string) => boolean,
): Record<string, Record<string, unknown>> => {
  return Object.fromEntries(
    bundledOpenClawExtensions
      .filter(extension => isAvailable(extension.id))
      .map(extension => [extension.id, extension.buildEntry(context)]),
  );
};

export const buildBundledExtensionToolContracts = (
  context: OpenClawExtensionContext,
  isAvailable: (id: string) => boolean,
): Array<{ id: string; tools: string[] }> => {
  return bundledOpenClawExtensions
    .filter(extension => isAvailable(extension.id) && extension.buildToolContracts)
    .map(extension => ({
      id: extension.id,
      tools: extension.buildToolContracts?.(context) ?? [],
    }));
};
