export const PermissionMode = {
  Ask: 'ask',
  Auto: 'auto',
  Full: 'full',
} as const;

export type PermissionMode = (typeof PermissionMode)[keyof typeof PermissionMode];

export const DEFAULT_PERMISSION_MODE: PermissionMode = PermissionMode.Full;

export const OpenClawSessionPermissionMode = {
  Guarded: 'guarded',
  Workspace: 'workspace',
  Full: 'full',
} as const;

export type OpenClawSessionPermissionMode =
  (typeof OpenClawSessionPermissionMode)[keyof typeof OpenClawSessionPermissionMode];

export const toOpenClawSessionPermissionMode = (
  mode: PermissionMode,
): OpenClawSessionPermissionMode => {
  switch (mode) {
    case PermissionMode.Ask:
      return OpenClawSessionPermissionMode.Guarded;
    case PermissionMode.Auto:
      return OpenClawSessionPermissionMode.Workspace;
    case PermissionMode.Full:
      return OpenClawSessionPermissionMode.Full;
  }
};
