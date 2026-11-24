import fs from 'node:fs/promises';
import path from 'node:path';

import { t } from '../../../core/i18n';

const LEGACY_WORKSPACE_SETUP_FILENAME = 'openclaw-workspace-state.json';

export class LegacyWorkspaceSetupCleanupError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(t('legacyWorkspaceSetupCleanupFailed', { path: filePath }), { cause });
    this.name = 'LegacyWorkspaceSetupCleanupError';
  }
}

/** Discard only the retired setup marker in the selected project directory. */
export async function removeLegacyWorkspaceSetupFile(workspaceDir: string): Promise<void> {
  if (!workspaceDir.trim()) return;
  const filePath = path.join(workspaceDir, LEGACY_WORKSPACE_SETUP_FILENAME);
  try {
    if (!path.isAbsolute(workspaceDir)) {
      throw new Error('Legacy workspace setup cleanup requires an absolute directory.');
    }
    const info = await fs.lstat(filePath);
    if (!info.isFile()) {
      throw new Error('Legacy workspace setup path is not a regular file.');
    }
    await fs.unlink(filePath);
    console.info(`[OpenClaw] Removed legacy workspace setup file: ${JSON.stringify(filePath)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new LegacyWorkspaceSetupCleanupError(filePath, error);
  }
}
