export async function runGuardedFilePreviewNavigation(
  requestTransition: () => Promise<boolean>,
  navigate: () => unknown | Promise<unknown>,
): Promise<boolean> {
  if (!(await requestTransition())) return false;
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
