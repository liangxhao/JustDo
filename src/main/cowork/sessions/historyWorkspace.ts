import fs from 'node:fs/promises';
import path from 'node:path';

export async function isHistoryWorkspaceAvailable(cwd: string): Promise<boolean> {
  if (!path.isAbsolute(cwd)) return false;
  try {
    return (await fs.stat(cwd)).isDirectory();
  } catch {
    return false;
  }
}
