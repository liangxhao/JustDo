import childProcess from 'child_process';
import extractZip from 'extract-zip';
import fs from 'fs';
import yaml from 'js-yaml';
import os from 'os';
import path from 'path';
import * as tar from 'tar';

import { cpRecursiveSync } from '../../core/fsCompat';
import { t } from '../../core/i18n';

const SKILL_FILE_NAME = 'SKILL.md';
const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'];
const FILE_SYSTEM_RETRY_COUNT = 5;
const FILE_SYSTEM_RETRY_DELAY_MS = 200;
const SKILL_TRASH_DIRECTORY_NAME = '.justdo-skill-trash';
const MAX_SKILL_NAME_LENGTH = 64;
const SKILL_NAME_PATTERN = /^(?=.*[a-z0-9])[a-z0-9_()-](?:[a-z0-9_(). -]*[a-z0-9_()-])?$/i;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type LocalSkillFileResult = {
  success: boolean;
  skillId?: string;
  error?: string;
};

type SkillIdResult = { skillId: string; error?: never } | { skillId?: never; error: string };

const validateSkillName = (name: unknown): SkillIdResult => {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_SKILL_NAME_LENGTH ||
    !SKILL_NAME_PATTERN.test(name)
  ) {
    return { error: t('skillInvalidName') };
  }
  if (WINDOWS_RESERVED_NAME_PATTERN.test(name)) {
    return {
      error: t('skillWindowsReservedName', { name }),
    };
  }
  return { skillId: name };
};

const readSkillId = (skillDir: string): SkillIdResult => {
  try {
    const content = fs.readFileSync(path.join(skillDir, SKILL_FILE_NAME), 'utf8');
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
    if (!match) return { error: t('skillInvalidFrontmatter') };
    const frontmatter = yaml.load(match[1]) as Record<string, unknown> | undefined;
    return validateSkillName(frontmatter?.name);
  } catch {
    return { error: t('skillInvalidFrontmatterName') };
  }
};

const getFileSystemErrorCode = (error: unknown): string =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';

const resetWindowsDirectoryAcl = (directory: string): void => {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const executable = systemRoot ? path.join(systemRoot, 'System32', 'icacls.exe') : 'icacls.exe';
  childProcess.spawnSync(executable, [directory, '/reset', '/T', '/C', '/Q', '/L'], {
    windowsHide: true,
    stdio: 'ignore',
  });

  const username = process.env.USERNAME;
  if (!username) return;
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
  childProcess.spawnSync(
    executable,
    [directory, '/grant:r', `${account}:(OI)(CI)F`, '/T', '/C', '/Q', '/L'],
    {
      windowsHide: true,
      stdio: 'ignore',
    },
  );
};

const removeDirectory = (directory: string): void => {
  const options: fs.RmOptions = {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? FILE_SYSTEM_RETRY_COUNT : 0,
    retryDelay: process.platform === 'win32' ? FILE_SYSTEM_RETRY_DELAY_MS : 0,
  };
  try {
    fs.rmSync(directory, options);
  } catch (error) {
    const code = getFileSystemErrorCode(error);
    if (process.platform !== 'win32' || (code !== 'EACCES' && code !== 'EPERM')) {
      throw error;
    }

    // Imported directories can contain child ACLs that no longer grant the
    // current Windows user traversal rights. rmSync retries cannot repair that
    // state, so restore inherited ACLs and make one final removal attempt.
    resetWindowsDirectoryAcl(directory);
    fs.rmSync(directory, options);
  }
};

const formatFileSystemError = (error: unknown, targetDir: string): string => {
  if (!(error instanceof Error)) return 'Failed to update skill files';
  const code = getFileSystemErrorCode(error);
  if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EEXIST') return error.message;
  return `Cannot access the skill directory "${targetDir}". Check its Windows owner and permissions, close processes using it, and try again. (${error.message})`;
};

const pathExists = (targetPath: string): boolean => {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false;
    }
    throw error;
  }
};

const waitForFileSystemRetry = (): void => {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    FILE_SYSTEM_RETRY_DELAY_MS,
  );
};

const renameDirectory = (sourceDir: string, targetDir: string): void => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(sourceDir, targetDir);
      return;
    } catch (error) {
      const code = getFileSystemErrorCode(error);
      const canRetry =
        attempt < FILE_SYSTEM_RETRY_COUNT &&
        (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY');
      if (!canRetry) throw error;
      waitForFileSystemRetry();
    }
  }
};

const quarantineDirectory = (directory: string): string | null => {
  const skillsRoot = path.dirname(directory);
  const trashRoot = path.join(path.dirname(skillsRoot), SKILL_TRASH_DIRECTORY_NAME);
  let transactionDir = '';
  try {
    fs.mkdirSync(trashRoot, { recursive: true });
    transactionDir = fs.mkdtempSync(path.join(trashRoot, 'delete-'));
    const quarantinedDirectory = path.join(transactionDir, path.basename(directory));
    try {
      renameDirectory(directory, quarantinedDirectory);
    } catch (error) {
      const code = getFileSystemErrorCode(error);
      if (process.platform !== 'win32' || (code !== 'EACCES' && code !== 'EPERM')) {
        throw error;
      }
      resetWindowsDirectoryAcl(directory);
      renameDirectory(directory, quarantinedDirectory);
    }
    return quarantinedDirectory;
  } catch (error) {
    if (transactionDir) {
      try {
        removeDirectory(transactionDir);
      } catch {
        // Best effort cleanup; the original error determines the fallback.
      }
    }
    const code = getFileSystemErrorCode(error);
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' || code === 'EXDEV') {
      return null;
    }
    throw error;
  }
};

const removeSkillDirectory = (directory: string): void => {
  const quarantinedDirectory = quarantineDirectory(directory);
  if (!quarantinedDirectory) {
    removeDirectory(directory);
  } else {
    try {
      removeDirectory(path.dirname(quarantinedDirectory));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'unknown error';
      console.warn(
        '[OpenClawSkillFiles] Skill was removed but its quarantined files could not be cleaned:',
        errorMessage,
      );
    }
  }

  if (pathExists(directory)) {
    throw new Error(`Skill directory still exists after deletion: ${directory}`);
  }
};

const replaceDirectory = (sourceDir: string, targetDir: string): void => {
  // On Windows, stage under the current user's temp directory so the completed
  // directory has a user-owned ACL before it is moved into the managed root.
  // On POSIX, keep staging beside the target to guarantee a same-device rename.
  const stagingParent = process.platform === 'win32' ? os.tmpdir() : path.dirname(targetDir);
  const transactionDir = fs.mkdtempSync(path.join(stagingParent, '.justdo-skill-stage-'));
  const stagedDir = path.join(transactionDir, 'skill');
  const backupDir = path.join(transactionDir, 'backup');
  let targetBackedUp = false;

  try {
    cpRecursiveSync(sourceDir, stagedDir, { force: true });
    fs.accessSync(stagedDir, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(path.join(stagedDir, SKILL_FILE_NAME), fs.constants.R_OK);

    if (pathExists(targetDir)) {
      renameDirectory(targetDir, backupDir);
      targetBackedUp = true;
    }

    try {
      renameDirectory(stagedDir, targetDir);
    } catch (error) {
      if (targetBackedUp) {
        try {
          renameDirectory(backupDir, targetDir);
          targetBackedUp = false;
        } catch (restoreError) {
          const restoreMessage =
            restoreError instanceof Error ? restoreError.message : 'unknown restore error';
          throw new Error(
            `Failed to install the skill and restore the previous version. The backup was preserved at "${backupDir}". (${restoreMessage})`,
            { cause: error },
          );
        }
      }
      throw error;
    }

    if (targetBackedUp) {
      targetBackedUp = false;
      try {
        removeDirectory(backupDir);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'unknown error';
        console.warn('[OpenClawSkillFiles] Failed to clean replaced skill backup:', errorMessage);
      }
    }
  } catch (error) {
    throw new Error(formatFileSystemError(error, targetDir), { cause: error });
  } finally {
    if (!targetBackedUp) {
      try {
        removeDirectory(transactionDir);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'unknown error';
        console.warn('[OpenClawSkillFiles] Failed to clean skill staging directory:', errorMessage);
      }
    }
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

      const skillIdResult = readSkillId(folderPath);
      if (skillIdResult.error) {
        return {
          success: false,
          error: skillIdResult.error,
        };
      }
      const { skillId } = skillIdResult;

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
        removeDirectory(extractDir);
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
    try {
      removeSkillDirectory(targetDir);
    } catch (error) {
      throw new Error(formatFileSystemError(error, targetDir), { cause: error });
    }
  }
}

export const __openClawSkillFilesTestUtils = {
  isSupportedArchive,
  readSkillId,
  resolveExtractedSkillDirectory,
  validateSkillName,
};
