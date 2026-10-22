import fs from 'node:fs/promises';
import path from 'node:path';

export async function copySourceCodexAuth(params: {
  sourceCodexHome: string;
  isolatedCodexHome: string;
}): Promise<void> {
  const sourceAuthPath = path.join(params.sourceCodexHome, 'auth.json');
  const isolatedAuthPath = path.join(params.isolatedCodexHome, 'auth.json');
  if (path.resolve(sourceAuthPath) === path.resolve(isolatedAuthPath)) {
    return;
  }
  let sourceModifiedAt: number;
  let authContents: Buffer;
  try {
    sourceModifiedAt = (await fs.stat(sourceAuthPath)).mtimeMs;
    authContents = await fs.readFile(sourceAuthPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  try {
    const isolatedModifiedAt = (await fs.stat(isolatedAuthPath)).mtimeMs;
    if (isolatedModifiedAt >= sourceModifiedAt) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await fs.writeFile(isolatedAuthPath, authContents, { mode: 0o600 });
  try {
    await fs.chmod(isolatedAuthPath, 0o600);
  } catch {
    // Windows does not implement POSIX modes; the file remains inside the app-owned state dir.
  }
}
