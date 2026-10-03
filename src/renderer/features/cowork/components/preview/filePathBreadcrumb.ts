export function getFilePathBreadcrumb(filePath: string, workspacePath?: string): string[] {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const workspaceRoot = workspacePath?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (workspaceRoot) {
    const isWindowsPath = /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith('//');
    const comparablePath = isWindowsPath ? normalizedPath.toLowerCase() : normalizedPath;
    const comparableRoot = isWindowsPath ? workspaceRoot.toLowerCase() : workspaceRoot;
    if (comparablePath.startsWith(`${comparableRoot}/`)) {
      const workspaceName = workspaceRoot.split('/').filter(Boolean).pop()!;
      return [
        workspaceName,
        ...normalizedPath
          .slice(workspaceRoot.length + 1)
          .split('/')
          .filter(Boolean),
      ];
    }
  }
  const root = normalizedPath.match(/^\/+/)?.[0];
  return [...(root ? [root] : []), ...normalizedPath.split('/').filter(Boolean)];
}

const PATH_SEPARATOR_WIDTH = 20;
const PATH_ELLIPSIS_WIDTH = 24;

export interface FilePathBreadcrumbLayout {
  tailStart: number;
  truncate: boolean;
}

export function fitFilePathBreadcrumb(
  segmentWidths: number[],
  availableWidth: number,
): FilePathBreadcrumbLayout {
  const lastIndex = segmentWidths.length - 1;
  const fullWidth =
    segmentWidths.reduce((total, width) => total + width, 0) +
    Math.max(0, lastIndex) * PATH_SEPARATOR_WIDTH;
  if (fullWidth <= availableWidth) return { tailStart: 1, truncate: false };

  for (let tailStart = 2; tailStart <= lastIndex; tailStart += 1) {
    const foldedWidth =
      segmentWidths[0] +
      PATH_ELLIPSIS_WIDTH +
      segmentWidths.slice(tailStart).reduce((total, width) => total + width, 0) +
      (segmentWidths.length - tailStart + 1) * PATH_SEPARATOR_WIDTH;
    if (foldedWidth <= availableWidth) return { tailStart, truncate: false };
  }
  return { tailStart: Math.max(1, lastIndex), truncate: true };
}
