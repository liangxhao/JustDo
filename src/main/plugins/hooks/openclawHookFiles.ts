import extractZip from 'extract-zip';
import fs from 'fs';
import yaml from 'js-yaml';
import os from 'os';
import path from 'path';
import * as tar from 'tar';

import { cpRecursiveSync } from '../../core/fsCompat';

const HOOK_FILE_NAME = 'HOOK.md';
const HANDLER_FILE_NAME = 'handler.js';
const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'];

export type LocalHookFileResult = {
  success: boolean;
  hookId?: string;
  error?: string;
};

const normalizeHookId = (name: string): string | null => {
  const normalized = name.trim();
  return /^[a-z0-9][a-z0-9_-]*$/.test(normalized) && !normalized.startsWith('import-')
    ? normalized
    : null;
};

const readHookId = (hookDir: string): string | null => {
  try {
    const content = fs.readFileSync(path.join(hookDir, HOOK_FILE_NAME), 'utf8');
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
    if (!match) return null;
    const frontmatter = yaml.load(match[1]) as Record<string, unknown> | undefined;
    return typeof frontmatter?.name === 'string' ? normalizeHookId(frontmatter.name) : null;
  } catch {
    return null;
  }
};

const isSupportedArchive = (filePath: string): boolean => {
  const lowerPath = filePath.toLowerCase();
  return SUPPORTED_ARCHIVE_EXTENSIONS.some(extension => lowerPath.endsWith(extension));
};

const assertNoSymbolicLinks = (directory: string): void => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('Hook packages cannot contain symbolic links.');
    }
    if (entry.isDirectory()) assertNoSymbolicLinks(entryPath);
  }
};

const resolveExtractedHookDirectory = (extractDir: string): string => {
  if (fs.existsSync(path.join(extractDir, HOOK_FILE_NAME))) return extractDir;

  const entries = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter(entry => entry.name !== '__MACOSX' && entry.name !== '.DS_Store');
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractDir, entries[0].name);
  }
  return extractDir;
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

export class OpenClawHookFiles {
  constructor(
    private readonly managedHooksDir: string,
    private readonly bundledHookIds: ReadonlySet<string> = new Set(),
  ) {}

  async importPath(sourcePath: string): Promise<LocalHookFileResult> {
    try {
      if (fs.lstatSync(sourcePath).isSymbolicLink()) {
        return { success: false, error: 'Hook packages cannot be symbolic links.' };
      }
      const stats = fs.statSync(sourcePath);
      if (stats.isDirectory()) return this.importDirectory(sourcePath);
      if (!stats.isFile() || !isSupportedArchive(sourcePath)) {
        return {
          success: false,
          error: 'Select a Hook folder or a supported archive (.zip, .tar, .tar.gz, .tgz).',
        };
      }
      return await this.importArchive(sourcePath);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to import Hook',
      };
    }
  }

  importDirectory(folderPath: string): LocalHookFileResult {
    try {
      if (!fs.statSync(folderPath).isDirectory()) {
        return { success: false, error: 'Selected path is not a folder' };
      }
      if (!fs.existsSync(path.join(folderPath, HOOK_FILE_NAME))) {
        return { success: false, error: 'A Hook package must contain a HOOK.md file.' };
      }
      if (!fs.existsSync(path.join(folderPath, HANDLER_FILE_NAME))) {
        return { success: false, error: 'A Hook package must contain a handler.js file.' };
      }

      const hookId = readHookId(folderPath);
      if (!hookId) {
        return {
          success: false,
          error: 'HOOK.md must have a valid "name" field in YAML frontmatter.',
        };
      }
      if (this.bundledHookIds.has(hookId)) {
        return { success: false, error: `Hook "${hookId}" conflicts with a built-in Hook.` };
      }

      assertNoSymbolicLinks(folderPath);
      fs.mkdirSync(this.managedHooksDir, { recursive: true });
      const sourceDir = path.resolve(folderPath);
      const targetDir = path.resolve(this.managedHooksDir, hookId);
      const sourceRelativeToTarget = path.relative(targetDir, sourceDir);
      if (
        !sourceRelativeToTarget ||
        (!sourceRelativeToTarget.startsWith('..') && !path.isAbsolute(sourceRelativeToTarget))
      ) {
        return {
          success: false,
          error: 'The selected Hook is already in the managed Hook folder.',
        };
      }
      replaceDirectory(sourceDir, targetDir);
      return { success: true, hookId };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to import Hook folder',
      };
    }
  }

  deleteDirectory(hookDirectory: string): void {
    const managedRoot = path.resolve(this.managedHooksDir);
    const targetDir = path.resolve(hookDirectory);
    const relative = path.relative(managedRoot, targetDir);
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      path.dirname(relative) !== '.'
    ) {
      throw new Error('Invalid Hook directory');
    }
    if (!fs.existsSync(path.join(targetDir, HOOK_FILE_NAME))) {
      throw new Error('Only custom Hooks can be deleted');
    }
    fs.rmSync(targetDir, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 5 : 0,
      retryDelay: process.platform === 'win32' ? 200 : 0,
    });
  }

  private async importArchive(archivePath: string): Promise<LocalHookFileResult> {
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-hook-import-'));
    try {
      if (archivePath.toLowerCase().endsWith('.zip')) {
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
      return this.importDirectory(resolveExtractedHookDirectory(extractDir));
    } finally {
      try {
        fs.rmSync(extractDir, {
          recursive: true,
          force: true,
          maxRetries: process.platform === 'win32' ? 5 : 0,
          retryDelay: process.platform === 'win32' ? 200 : 0,
        });
      } catch (error) {
        console.warn(
          '[OpenClawHookFiles] Failed to clean temporary import directory:',
          error instanceof Error ? error.message : 'unknown error',
        );
      }
    }
  }
}

export const __openClawHookFilesTestUtils = {
  isSupportedArchive,
  normalizeHookId,
  readHookId,
  resolveExtractedHookDirectory,
};
