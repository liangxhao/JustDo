import fs from 'fs';
import path from 'path';

import { t } from '../../../core/i18n';

const LEGACY_WORKSPACE_SETUP_FILENAME = 'openclaw-workspace-state.json';

export class LegacyWorkspaceSetupCleanupError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(t('legacyWorkspaceSetupCleanupFailed', { path: filePath }), { cause });
    this.name = 'LegacyWorkspaceSetupCleanupError';
  }
}

/** Discard only the retired setup marker in the selected project directory. */
export function removeLegacyWorkspaceSetupFile(workspaceDir: string): void {
  if (!workspaceDir.trim()) return;
  const filePath = path.join(workspaceDir, LEGACY_WORKSPACE_SETUP_FILENAME);
  try {
    if (!path.isAbsolute(workspaceDir)) {
      throw new Error('Legacy workspace setup cleanup requires an absolute directory.');
    }
    const info = fs.lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Legacy workspace setup path is not a regular file.');
    }
    fs.unlinkSync(filePath);
    console.info(`[OpenClaw] Removed legacy workspace setup file: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new LegacyWorkspaceSetupCleanupError(filePath, error);
  }
}
