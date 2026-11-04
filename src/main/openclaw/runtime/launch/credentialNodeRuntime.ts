import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { restrictCredentialDirectory, restrictCredentialFile } from '../../config/models/providerSecretFile';

export type CredentialNodeRuntimeSource = { executable: string; sha256: string };

type Identity = Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;
type DirectoryIdentity = Pick<fs.Stats, 'dev' | 'ino'>;
type PreparedRuntime = { executable: Identity; directories: DirectoryIdentity[] };
const preparedRuntimes = new Map<string, PreparedRuntime>();

function identity(stat: fs.Stats): Identity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function unchanged(stat: fs.Stats, previous: Identity): boolean {
  return Object.entries(previous).every(([key, value]) => stat[key as keyof Identity] === value);
}

function inspect(file: string, directory: boolean, singleLink = true): fs.Stats {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || (singleLink && stat.nlink !== 1))) {
    throw new Error('Credential runtime path must be an ordinary private directory or file.');
  }
  return stat;
}

function inspectExisting(file: string, directory: boolean): void {
  try { inspect(file, directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function restrictManagedPath(file: string, directory = false): void {
  // Only these app-managed paths are reset. Removing inherited ACEs alone would
  // retain unrelated explicit writers from an older or interrupted publication.
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [file, '/reset'], {
    windowsHide: true, timeout: 5_000, encoding: 'utf8',
  });
  if (directory) restrictCredentialDirectory(file);
  else restrictCredentialFile(file);
}

function ensureDirectory(directory: string): void {
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  inspect(directory, true);
  restrictManagedPath(directory, true);
}

function hashFile(file: string): string {
  const descriptor = fs.openSync(file, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let length: number;
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) {
      hash.update(buffer.subarray(0, length));
    }
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

function copyVerified(source: CredentialNodeRuntimeSource, temporary: string): void {
  const sourceStat = inspect(source.executable, false, false);
  const input = fs.openSync(source.executable, 'r');
  let output: number | undefined;
  try {
    if (!unchanged(fs.fstatSync(input), identity(sourceStat))) throw new Error('Credential runtime source changed.');
    output = fs.openSync(temporary, 'wx', 0o600);
    inspect(temporary, false);
    restrictManagedPath(temporary);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let length: number;
    while ((length = fs.readSync(input, buffer, 0, buffer.length, null)) !== 0) {
      hash.update(buffer.subarray(0, length));
      let written = 0;
      while (written < length) written += fs.writeSync(output, buffer, written, length - written);
    }
    if (hash.digest('hex') !== source.sha256) throw new Error('Credential runtime source checksum mismatch.');
    fs.fsyncSync(output);
  } finally {
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(input);
  }
}

/** Give the native exec validator an ordinary private executable without
 * changing the bundled runtime or the installation directory's permissions. */
export function prepareCredentialNodeRuntime(stateDir: string, source: CredentialNodeRuntimeSource): string {
  if (process.platform !== 'win32') return source.executable;
  if (!path.isAbsolute(source.executable) || !/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new Error('Credential runtime source identity is invalid.');
  }
  inspect(path.resolve(stateDir), true);
  const directories = [
    path.join(stateDir, 'credentials'),
    path.join(stateDir, 'credentials', 'runtime'),
    path.join(stateDir, 'credentials', 'runtime', source.sha256),
  ];
  const executable = path.join(directories[2], 'node.exe');
  // Do this before directory ACL updates: Windows can propagate an ACL change
  // into an existing child, including all names of a hard-linked child file.
  for (const directory of directories) inspectExisting(directory, true);
  inspectExisting(executable, false);
  const previous = preparedRuntimes.get(executable);
  if (previous) {
    const directoryStats = directories.map(directory => inspect(directory, true));
    const executableStat = inspect(executable, false);
    if (unchanged(executableStat, previous.executable) &&
        directoryStats.every((stat, index) => stat.dev === previous.directories[index].dev &&
          stat.ino === previous.directories[index].ino)) return executable;
  }
  preparedRuntimes.delete(executable);
  for (const directory of directories) ensureDirectory(directory);
  if (!fs.existsSync(executable)) {
    const temporary = path.join(directories[2], `node.tmp-${randomUUID()}.exe`);
    try {
      copyVerified(source, temporary);
      fs.renameSync(temporary, executable);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  inspect(executable, false);
  if (hashFile(executable) !== source.sha256) throw new Error('Credential runtime cached checksum mismatch.');
  restrictManagedPath(executable);
  preparedRuntimes.set(executable, {
    executable: identity(inspect(executable, false)),
    directories: directories.map(directory => {
      const { dev, ino } = inspect(directory, true);
      return { dev, ino };
    }),
  });
  return executable;
}
