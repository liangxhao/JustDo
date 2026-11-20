export const SESSION_DISPLAY_NAME_METHOD = 'runtimeServices.sessionDisplayName';
export const SESSION_DISPLAY_NAME_MAX_LENGTH = 500;

export interface SessionDisplayNameRequest {
  sessionKey: string;
  nativeSessionId: string;
  lifecycleRevision: string | null;
  displayName: string;
  expectedDisplayName?: string;
  confirmOnly?: true;
}

export function normalizeSessionDisplayName(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= SESSION_DISPLAY_NAME_MAX_LENGTH ? name : undefined;
}
