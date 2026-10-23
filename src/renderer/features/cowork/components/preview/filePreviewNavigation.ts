export interface FilePreviewNavigationOptions {
  preserveTabs?: boolean;
}

export function isFilePreviewWithinPath(filePath: string, sourcePath: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
      ? normalized.toLowerCase()
      : normalized;
  };
  const file = normalize(filePath);
  const source = normalize(sourcePath);
  return file === source || file.startsWith(`${source}/`);
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
