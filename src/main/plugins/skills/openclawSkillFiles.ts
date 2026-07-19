import extractZip from 'extract-zip';
import fs from 'fs';
import yaml from 'js-yaml';
import os from 'os';
import path from 'path';
import * as tar from 'tar';

import { cpRecursiveSync } from '../../core/fsCompat';

const SKILL_FILE_NAME = 'SKILL.md';
const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'];

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

const replaceDirectory = (sourceDir: string, targetDir: string): void => {
  fs.rmSync(targetDir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: process.platform === 'win32' ? 200 : 0,
  });
  cpRecursiveSync(sourceDir, targetDir, { force: true });
};

const isSupportedArchive = (filePath: string): boolean => {
  const lowerPath = filePath.toLowerCase();
  return SUPPORTED_ARCHIVE_EXTENSIONS.some(extension => lowerPath.endsWith(extension));
};

const assertNoSymbolicLinks = (directory: string): void => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('Skill archives cannot contain symbolic links.');
    }
    if (entry.isDirectory()) {
      assertNoSymbolicLinks(entryPath);
    }
  }
};

const resolveExtractedSkillDirectory = (extractDir: string): string => {
  if (fs.existsSync(path.join(extractDir, SKILL_FILE_NAME))) {
    return extractDir;
  }

  const entries = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter(entry => entry.name !== '__MACOSX' && entry.name !== '.DS_Store');
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractDir, entries[0].name);
  }
  return extractDir;
};

export class OpenClawSkillFiles {
  constructor(private readonly managedSkillsDir: string) {}

  async importPath(sourcePath: string): Promise<LocalSkillFileResult> {
    try {
      const stats = fs.statSync(sourcePath);
      if (stats.isDirectory()) {
        return this.importDirectory(sourcePath);
      }
      if (!stats.isFile() || !isSupportedArchive(sourcePath)) {
        return {
          success: false,
          error: 'Select a skill folder or a supported archive (.zip, .tar, .tar.gz, .tgz).',
        };
      }
      return await this.importArchive(sourcePath);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to import skill',
      };
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

  private async importArchive(archivePath: string): Promise<LocalSkillFileResult> {
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-skill-import-'));
    try {
      const lowerPath = archivePath.toLowerCase();
      if (lowerPath.endsWith('.zip')) {
        await extractZip(archivePath, { dir: extractDir });
      } else {
        await tar.extract({
          file: archivePath,
          cwd: extractDir,
          preservePaths: false,
          strict: true,
        });
      }
      assertNoSymbolicLinks(extractDir);
      return this.importDirectory(resolveExtractedSkillDirectory(extractDir));
    } finally {
      try {
        fs.rmSync(extractDir, {
          recursive: true,
          force: true,
          maxRetries: process.platform === 'win32' ? 5 : 0,
          retryDelay: process.platform === 'win32' ? 200 : 0,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'unknown error';
        console.warn(
          '[OpenClawSkillFiles] Failed to clean temporary import directory:',
          errorMessage,
        );
      }
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
    this.deleteDirectory(targetDir);
  }

  deleteDirectory(skillDirectory: string): void {
    const targetDir = path.resolve(skillDirectory);
    const parentDir = path.dirname(targetDir);
    const relativeToManaged = path.relative(path.resolve(this.managedSkillsDir), targetDir);
    const isDirectManagedChild =
      Boolean(relativeToManaged) &&
      !relativeToManaged.startsWith('..') &&
      !path.isAbsolute(relativeToManaged) &&
      path.dirname(relativeToManaged) === '.';
    const isUserSkillsChild = path.basename(parentDir).toLowerCase() === 'skills';
    const hasSkillManifest = fs.existsSync(path.join(targetDir, SKILL_FILE_NAME));
    if (
      targetDir === path.parse(targetDir).root ||
      (!isDirectManagedChild && (!isUserSkillsChild || !hasSkillManifest))
    ) {
      throw new Error('Only user-owned skill directories can be deleted');
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

export const __openClawSkillFilesTestUtils = {
  isSupportedArchive,
  normalizeSkillId,
  readSkillId,
  resolveExtractedSkillDirectory,
};
