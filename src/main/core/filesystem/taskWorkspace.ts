import fs from 'fs';
import path from 'path';

export const resolveExistingTaskWorkingDirectory = async (workspaceRoot: string): Promise<string> => {
  if (!path.isAbsolute(workspaceRoot) || workspaceRoot.includes('\0')) {
    throw new Error('Select an existing task folder.');
  }
  const canonical = await fs.promises.realpath(workspaceRoot);
  if (
    (process.platform === 'win32' && path.parse(canonical).root === canonical) ||
    !(await fs.promises.stat(canonical)).isDirectory()
  ) {
    throw new Error('Select an existing task folder.');
  }
  return canonical;
};

export const resolveTaskWorkingDirectory = (workspaceRoot: string): string => {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  if (process.platform === 'win32' && /^[a-zA-Z]:\\?$/.test(resolvedWorkspaceRoot)) {
    throw new Error(
      `Cannot use a drive root as the working directory (${resolvedWorkspaceRoot}). Please select a subfolder instead, for example: ${resolvedWorkspaceRoot}Projects`,
    );
  }
  if (!fs.existsSync(resolvedWorkspaceRoot)) {
    fs.mkdirSync(resolvedWorkspaceRoot, { recursive: true });
  }
  if (!fs.statSync(resolvedWorkspaceRoot).isDirectory()) {
    throw new Error(`Selected workspace is not a directory: ${resolvedWorkspaceRoot}`);
  }
  return resolvedWorkspaceRoot;
};
