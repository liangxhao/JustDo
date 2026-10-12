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

export const prepareExtensionInstallSource = async (
  sourceDirectory: string,
  runtimeRoot: string,
): Promise<PreparedExtensionInstallSource> => {
  const unchanged = { directory: sourceDirectory, cleanup: async () => {} };
  if (process.platform !== 'win32') return unchanged;
  const source = path.resolve(sourceDirectory);
  const hostLink = path.join(source, 'node_modules', 'openclaw');
  let host: string;
  let manifestText: string;
  try {
    if ((await fsp.lstat(source)).isSymbolicLink()) return unchanged;
    if ((await fsp.lstat(path.join(source, 'node_modules'))).isSymbolicLink()) return unchanged;
    if (!(await fsp.lstat(hostLink)).isSymbolicLink()) return unchanged;
    if (!path.isAbsolute(await fsp.readlink(hostLink))) return unchanged;
    host = await fsp.realpath(runtimeRoot);
    if ((await fsp.realpath(hostLink)) !== host || !(await fsp.stat(hostLink)).isDirectory())
      return unchanged;
    manifestText = await fsp.readFile(path.join(source, 'package.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    // The native package installer recreates the host peer link after its scan.
    // Bundles and undeclared links do not have that contract and stay untouched.
    if (
      !Array.isArray(manifest?.openclaw?.extensions) ||
      !manifest.openclaw.extensions.length ||
      !manifest.openclaw.extensions.every((entry: unknown) => typeof entry === 'string' && entry) ||
      !['peerDependencies', 'optionalDependencies', 'dependencies'].some(
        key => typeof manifest?.[key]?.openclaw === 'string' && manifest[key].openclaw,
      )
    )
      return unchanged;
  } catch {
    return unchanged;
  }

  const entries = new Map<string, fs.Stats>();
  const children = new Map<string, string[]>();
  const inspect = async (entry: string): Promise<boolean> => {
    const stat = await fsp.lstat(entry);
    entries.set(entry, stat);
    if (entry === hostLink) return stat.isSymbolicLink() && (await fsp.realpath(entry)) === host;
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
  if (!(await inspect(source))) return unchanged;

  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'extension-install-source-'));
  const directory = path.join(temporary, 'package');
  const cleanup = () =>
    fsp.rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  const changed = () =>
    Object.assign(new Error(t('extensionImportSourceChanged')), { code: 'ESTALE' });
  const matches = (before: fs.Stats, current: fs.Stats) =>
    before.dev === current.dev &&
    before.ino === current.ino &&
    before.mode === current.mode &&
    before.nlink === current.nlink &&
    before.size === current.size &&
    before.mtimeMs === current.mtimeMs &&
    before.ctimeMs === current.ctimeMs;
  const verify = async (from: string, before: fs.Stats) => {
    if (!matches(before, await fsp.lstat(from))) throw changed();
    if (from === hostLink && (await fsp.realpath(from)) !== host) throw changed();
    const names = children.get(from);
    if (names && JSON.stringify(names) !== JSON.stringify((await fsp.readdir(from)).sort()))
      throw changed();
  };
  try {
    for (const [from, before] of entries) {
      await verify(from, before);
      if (from === hostLink) continue;
      const to = path.join(directory, path.relative(source, from));
      if (before.isDirectory()) await fsp.mkdir(to, { mode: before.mode });
      else {
        // Bind the copied bytes to the inspected inode; never follow a swapped
        // pathname and then present the result as a clean ordinary file.
        const input = await fsp.open(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let output: FileHandle | undefined;
        try {
          if (!matches(before, await input.stat())) throw changed();
          output = await fsp.open(to, 'wx', before.mode);
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let count: number;
          while ((count = (await input.read(buffer, 0, buffer.length, null)).bytesRead) > 0) {
            let written = 0;
            while (written < count)
              written += (await output.write(buffer, written, count - written)).bytesWritten;
          }
          if (!matches(before, await input.stat())) throw changed();
        } finally {
          try {
            await input.close();
          } finally {
            await output?.close();
          }
        }
      }
    }
    for (const [from, before] of entries) await verify(from, before);
    if ((await fsp.readFile(path.join(directory, 'package.json'), 'utf8')) !== manifestText)
      throw changed();
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
