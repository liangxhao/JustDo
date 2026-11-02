import fs from 'fs';
import fsp, { type FileHandle } from 'fs/promises';
import os from 'os';
import path from 'path';

import { t } from '../../core/i18n';

/** A one-shot import copy; native installation still owns validation and publication. */
export type PreparedExtensionInstallSource = {
  directory: string;
  cleanup: () => Promise<void>;
};

const sourceChanged = () =>
  Object.assign(new Error(t('extensionImportSourceChanged')), { code: 'ESTALE' });
const matchesSource = (before: fs.Stats, current: fs.Stats) =>
  before.dev === current.dev &&
  before.ino === current.ino &&
  before.mode === current.mode &&
  before.nlink === current.nlink &&
  before.size === current.size &&
  before.mtimeMs === current.mtimeMs &&
  before.ctimeMs === current.ctimeMs;

/** Copy only the inspected inode, without following a replaced pathname. */
const copyVerifiedFile = async (from: string, to: string, before: fs.Stats): Promise<void> => {
  const input = await fsp.open(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let output: FileHandle | undefined;
  try {
    if (!matchesSource(before, await input.stat())) throw sourceChanged();
    output = await fsp.open(to, 'wx', before.mode);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count: number;
    while ((count = (await input.read(buffer, 0, buffer.length, null)).bytesRead) > 0) {
      let written = 0;
      while (written < count)
        written += (await output.write(buffer, written, count - written)).bytesWritten;
    }
    if (!matchesSource(before, await input.stat()) ||
        !matchesSource(before, await fsp.lstat(from))) throw sourceChanged();
  } finally {
    try { await input.close(); }
    finally { await output?.close(); }
  }
};

/** Keep archive installation semantics while binding inspection and install to one input. */
export const prepareExtensionInstallArchive = async (
  sourceArchive: string,
): Promise<{ file: string; cleanup: () => Promise<void> }> => {
  const source = path.resolve(sourceArchive);
  const before = await fsp.lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error(t('extensionImportSourceUnsafe'));
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'extension-install-archive-'));
  const file = path.join(temporary, path.basename(source));
  const cleanup = () => fsp.rm(temporary, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  });
  try {
    await copyVerifiedFile(source, file, before);
    return { file, cleanup };
  } catch (error) {
    try { await cleanup(); }
    catch { /* Preserve the original source failure. */ }
    throw error;
  }
};

export const prepareExtensionInstallSource = async (
  sourceDirectory: string,
  runtimeRoot: string,
  options?: { snapshot?: true; reuseOwnedDirectory?: true },
): Promise<PreparedExtensionInstallSource> => {
  const unchanged = { directory: sourceDirectory, cleanup: async () => {} };
  const snapshot = options?.snapshot === true;
  if (!snapshot && process.platform !== 'win32') return unchanged;
  const source = path.resolve(sourceDirectory);
  const hostLink = path.join(source, 'node_modules', 'openclaw');
  let host: string | undefined;
  let manifestText: string | undefined;
  let omitHostLink = false;
  try {
    if (
      process.platform === 'win32' &&
      !(await fsp.lstat(source)).isSymbolicLink() &&
      !(await fsp.lstat(path.join(source, 'node_modules'))).isSymbolicLink() &&
      (await fsp.lstat(hostLink)).isSymbolicLink() &&
      path.isAbsolute(await fsp.readlink(hostLink))
    ) {
      host = await fsp.realpath(runtimeRoot);
      if ((await fsp.realpath(hostLink)) === host && (await fsp.stat(hostLink)).isDirectory()) {
        const text = await fsp.readFile(path.join(source, 'package.json'), 'utf8');
        const manifest = JSON.parse(text);
        // The native package installer recreates this declared current host peer.
        omitHostLink = Array.isArray(manifest?.openclaw?.extensions) &&
          manifest.openclaw.extensions.length > 0 &&
          manifest.openclaw.extensions.every((entry: unknown) => typeof entry === 'string' && entry) &&
          ['peerDependencies', 'optionalDependencies', 'dependencies'].some(
            key => typeof manifest?.[key]?.openclaw === 'string' && manifest[key].openclaw,
          );
        if (omitHostLink) manifestText = text;
      }
    }
  } catch {
    // Ordinary packages need no host-peer normalization.
  }
  if (!snapshot && !omitHostLink) return unchanged;

  const entries = new Map<string, fs.Stats>();
  const children = new Map<string, string[]>();
  const inspect = async (entry: string): Promise<boolean> => {
    const stat = await fsp.lstat(entry);
    entries.set(entry, stat);
    if (omitHostLink && entry === hostLink)
      return stat.isSymbolicLink() && (await fsp.realpath(entry)) === host;
    if (stat.isSymbolicLink()) return false;
    if (stat.isDirectory()) {
      const names = (await fsp.readdir(entry)).sort();
      children.set(entry, names);
      for (const name of names) if (!(await inspect(path.join(entry, name)))) return false;
      return true;
    }
    // Do not turn links rejected by native admission into an accepted plain copy.
    return stat.isFile() && stat.nlink === 1;
  };
  if (!(await inspect(source))) {
    if (snapshot) throw new Error(t('extensionImportSourceUnsafe'));
    return unchanged;
  }

  // Archive inspection already belongs exclusively to this operation. Reuse
  // that tree for classification without creating another directory copy.
  if (snapshot && options?.reuseOwnedDirectory && !omitHostLink) return unchanged;

  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'extension-install-source-'));
  const directory = path.join(temporary, 'package');
  const cleanup = () =>
    fsp.rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  const verify = async (from: string, before: fs.Stats) => {
    if (!matchesSource(before, await fsp.lstat(from))) throw sourceChanged();
    if (omitHostLink && from === hostLink && (await fsp.realpath(from)) !== host) throw sourceChanged();
    const names = children.get(from);
    if (names && JSON.stringify(names) !== JSON.stringify((await fsp.readdir(from)).sort()))
      throw sourceChanged();
  };
  try {
    for (const [from, before] of entries) {
      await verify(from, before);
      if (omitHostLink && from === hostLink) continue;
      const to = path.join(directory, path.relative(source, from));
      if (before.isDirectory()) await fsp.mkdir(to, { mode: before.mode });
      else await copyVerifiedFile(from, to, before);
    }
    for (const [from, before] of entries) await verify(from, before);
    if (manifestText !== undefined &&
        (await fsp.readFile(path.join(directory, 'package.json'), 'utf8')) !== manifestText)
      throw sourceChanged();
    return { directory, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch {
      /* Preserve the preparation failure. */
    }
    throw error;
  }
};
