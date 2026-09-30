export interface FilePreviewNavigationOptions {
  preserveTabs?: boolean;
}

export async function runGuardedFilePreviewNavigation(
  requestTransition: (options?: FilePreviewNavigationOptions) => Promise<boolean>,
  navigate: () => unknown | Promise<unknown>,
  options?: FilePreviewNavigationOptions,
  prepare?: () => Promise<boolean>,
): Promise<boolean> {
  if (!(await requestTransition(options))) return false;
  if (prepare && !(await prepare())) return false;
  await navigate();
  return true;
}

export function isCurrentFilePreviewRequest(
  requestId: number,
  latestRequestId: number,
  sourceSessionId: string | null,
  currentSessionId: string | null,
): boolean {
  return requestId === latestRequestId && sourceSessionId === currentSessionId;
}
