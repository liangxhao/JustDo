import { execFileSync } from 'child_process';
import fs from 'fs';
import yaml from 'js-yaml';
import os from 'os';
import path from 'path';

import { cpRecursiveSync } from '../../core/fsCompat';

const SKILL_FILE_NAME = 'SKILL.md';

export type LocalSkillFileResult = {
  success: boolean;
  skillId?: string;
  error?: string;
};

const normalizeSkillId = (name: string): string | null => {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized && !normalized.startsWith('.') && !normalized.startsWith('import-')
    ? normalized
    : null;
};

const readSkillId = (skillDir: string): string | null => {
  try {
    const content = fs.readFileSync(path.join(skillDir, SKILL_FILE_NAME), 'utf8');
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
    if (!match) return null;
    const frontmatter = yaml.load(match[1]) as Record<string, unknown> | undefined;
    return typeof frontmatter?.name === 'string' ? normalizeSkillId(frontmatter.name) : null;
  } catch {
    return null;
  }
};

const findSkillDir = (root: string): string | null => {
  if (fs.existsSync(path.join(root, SKILL_FILE_NAME))) return root;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = findSkillDir(path.join(root, entry.name));
    if (nested) return nested;
  }
  return null;
};

const extractArchive = (archivePath: string, targetDir: string): void => {
  const lowerPath = archivePath.toLowerCase();
  if (lowerPath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
          archivePath,
          targetDir,
        ],
        { timeout: 60_000, windowsHide: true },
      );
      return;
    }
    execFileSync('unzip', ['-o', archivePath, '-d', targetDir], { timeout: 60_000 });
    return;
  }

  if (lowerPath.endsWith('.tgz') || lowerPath.endsWith('.tar.gz')) {
    execFileSync('tar', ['-xzf', archivePath, '-C', targetDir], { timeout: 60_000 });
    return;
  }

  throw new Error('Unsupported archive format. Only .zip and .tgz/.tar.gz are supported.');
};

const replaceDirectory = (sourceDir: string, targetDir: string): void => {
  fs.rmSync(targetDir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: process.platform === 'win32' ? 200 : 0,
  });
  cpRecursiveSync(sourceDir, targetDir, { force: true });
};

export class OpenClawSkillFiles {
  constructor(private readonly managedSkillsDir: string) {}

  importArchive(archivePath: string): LocalSkillFileResult {
    if (!fs.existsSync(archivePath)) {
      return { success: false, error: 'Archive file not found' };
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-skill-'));
    try {
      extractArchive(archivePath, tempDir);
      const skillDir = findSkillDir(tempDir);
      if (!skillDir) {
        return {
          success: false,
          error: 'No valid skill found in archive. A skill must contain a SKILL.md file.',
        };
      }
      return this.importDirectory(skillDir);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to import skill',
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  importDirectory(folderPath: string): LocalSkillFileResult {
    try {
      if (!fs.statSync(folderPath).isDirectory()) {
        return { success: false, error: 'Selected path is not a folder' };
      }
      if (!fs.existsSync(path.join(folderPath, SKILL_FILE_NAME))) {
        return {
          success: false,
          error: 'No valid skill found in folder. A skill must contain a SKILL.md file.',
        };
      }

      const skillId = readSkillId(folderPath);
      if (!skillId) {
        return {
          success: false,
          error: 'SKILL.md must have a valid "name" field in frontmatter.',
        };
      }

      fs.mkdirSync(this.managedSkillsDir, { recursive: true });
      replaceDirectory(folderPath, path.join(this.managedSkillsDir, skillId));
      return { success: true, skillId };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to import skill folder',
      };
    }
  }

  delete(skillId: string): void {
    if (skillId !== path.basename(skillId)) {
      throw new Error('Invalid skill id');
    }
    const targetDir = path.resolve(this.managedSkillsDir, skillId);
    const relative = path.relative(path.resolve(this.managedSkillsDir), targetDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Invalid skill id');
    }
    if (!fs.existsSync(targetDir)) {
      throw new Error('Only locally imported skills can be deleted');
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

export const __openClawSkillFilesTestUtils = { normalizeSkillId, readSkillId };
