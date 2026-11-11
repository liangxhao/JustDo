import fs, { type BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { restrictCredentialDirectory } from '../openclaw/config/models/providerSecretFile';
import { RELOCATION_ROOT_SCOPE } from './relocationScope';
import {
  assertCanonicalDirectory,
  assertCanonicalParentDirectory,
  isRelocationRootPath,
  pathsOverlap,
  readStorageRootIdentity,
  StorageRelocationFile,
  type StorageRootIdentity,
} from './relocationState';

export type RelocationPhysicalIdentity = {
  dev: string;
  ino: string;
  birthtimeNs: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
};
export type RelocationManifestEntry = {
  relativePath: string;
  kind: 'directory' | 'file';
  size: number;
  physical: RelocationPhysicalIdentity;
  /** Exact native-owned snapshot substituted for this explicit source file. */
  provenance?: { snapshotPath: string };
};
export type RelocationManifest = {
  sourceRoot: string;
  targetRoot: string;
  sourcePhysical: RelocationPhysicalIdentity;
  targetPhysical: RelocationPhysicalIdentity;
  entries: RelocationManifestEntry[];
  excludeRelativePaths: string[];
};
export type RelocationCopyOptions = {
  sourceRoot: string;
  targetRoot: string;
  targetIdentity?: Pick<StorageRootIdentity, 'profileId' | 'rootId'>;
  excludeRelativePaths?: readonly string[];
  replaceFiles?: ReadonlyMap<string, string>;
  signal?: AbortSignal;
};

const changed = () => new Error('Storage relocation files changed or are unsafe.');
const canonicalCase = (value: string) =>
  process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (left: string, right: string) => canonicalCase(left) === canonicalCase(right);
const isRegularFile = (stat: BigIntStats, allowHardlinks: boolean) =>
  stat.isFile() && (allowHardlinks || stat.nlink === 1n);
const excludedRoots = new Set(RELOCATION_ROOT_SCOPE.skipCopy.map(canonicalCase));
const excludesRoot = (name: string) => excludedRoots.has(name.split('/', 1)[0]);

/** The manifest uses portable forward-slash relative paths; traversal, ADS and aliases fail. */
export function normalizeRelocationRelativePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized
      .split('/')
      .some(
        segment =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          /[<>:"|?*\u0000-\u001f]/u.test(segment) ||
          /[ .]$/u.test(segment),
      )
  )
    throw changed();
  return normalized;
}
export function relocationPhysicalIdentity(stat: BigIntStats): RelocationPhysicalIdentity {
  if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw changed();
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}
function samePhysical(
  left: RelocationPhysicalIdentity,
  right: RelocationPhysicalIdentity,
  content: boolean,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    (!content ||
      (left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs))
  );
}
async function metadata(
  filename: string,
  kind: 'directory' | 'file',
): Promise<RelocationPhysicalIdentity> {
  const stat = await fsp.lstat(filename, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    (kind === 'file' ? !isRegularFile(stat, false) : !stat.isDirectory())
  )
    throw changed();
  return relocationPhysicalIdentity(stat);
}
function canonicalFile(filename: string): string {
  if (!isRelocationRootPath(filename)) throw changed();
  assertCanonicalParentDirectory(path.dirname(filename));
  if (!samePath(fs.realpathSync.native(filename), filename)) throw changed();
  return filename;
}

function sourceExclusions(relative: readonly string[]) {
  const nested = [...new Set(relative.map(value => canonicalCase(normalizeRelocationRelativePath(value))))];
  const excluded = (name: string) => {
    const normalized = canonicalCase(name);
    return (
      excludesRoot(normalized) ||
      nested.some(value => normalized === value || normalized.startsWith(`${value}/`))
    );
  };
  return { nested, excluded };
}

async function inventory(
  root: string,
  exclude: (name: string) => boolean,
  signal?: AbortSignal,
  source = false,
): Promise<RelocationManifestEntry[]> {
  const entries: RelocationManifestEntry[] = [];
  const pending = [''];
  const names = new Set<string>();
  while (pending.length) {
    signal?.throwIfAborted();
    const parent = pending.pop()!;
    const directory = path.join(root, parent);
    assertCanonicalDirectory(directory);
    const before = await metadata(directory, 'directory');
    const stream = await fsp.opendir(directory);
    for await (const entry of stream) {
      signal?.throwIfAborted();
      const relative = normalizeRelocationRelativePath(parent ? `${parent}/${entry.name}` : entry.name);
      if (exclude(relative)) continue;
      const name = canonicalCase(relative);
      if (names.has(name)) throw changed();
      names.add(name);
      const filename = path.join(root, relative);
      const stat = await fsp.lstat(filename, { bigint: true });
      if (stat.isSymbolicLink() ||
          (!stat.isDirectory() && !isRegularFile(stat, source)))
        throw changed();
      if (stat.isDirectory()) {
        entries.push({
          relativePath: relative,
          kind: 'directory',
          size: 0,
          physical: relocationPhysicalIdentity(stat),
        });
        pending.push(relative);
      } else {
        const physical = relocationPhysicalIdentity(stat);
        entries.push({ relativePath: relative, kind: 'file', size: physical.size, physical });
      }
    }
    assertCanonicalDirectory(directory);
    if (!samePhysical(before, await metadata(directory, 'directory'), false)) throw changed();
  }
  return entries.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
}

/** Bounded chunk I/O avoids holding whole files or unretired stream owners in memory. */
async function copyFileBytes(
  source: Awaited<ReturnType<typeof fsp.open>>,
  destination: Awaited<ReturnType<typeof fsp.open>>,
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<number> {
  let position = 0;
  while (true) {
    signal?.throwIfAborted();
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    let offset = 0;
    while (offset < bytesRead) {
      signal?.throwIfAborted();
      const { bytesWritten } = await destination.write(
        buffer,
        offset,
        bytesRead - offset,
        position + offset,
      );
      if (!bytesWritten) throw changed();
      offset += bytesWritten;
    }
    position += bytesRead;
  }
  return position;
}

export function checkRelocationTargetContents(targetRoot: string): boolean {
  const entries = fs.readdirSync(targetRoot);
  if (entries.some(name => name !== StorageRelocationFile.RootIdentity))
    throw Object.assign(new Error('The migration target is not empty.'), { code: 'target-not-empty' });
  return entries.length > 0;
}

/** Copies under offline custody and verifies the destination. The caller verifies the source before activation. */
export async function copyRelocationFiles(
  options: RelocationCopyOptions,
): Promise<RelocationManifest> {
  const sourceRoot = assertCanonicalDirectory(options.sourceRoot);
  const targetRoot = assertCanonicalDirectory(options.targetRoot);
  if (pathsOverlap(sourceRoot, targetRoot)) throw changed();
  const hasMarker = checkRelocationTargetContents(targetRoot);
  const expectedTarget = options.targetIdentity;
  if (expectedTarget || hasMarker) {
    const actual = readStorageRootIdentity(targetRoot);
    if (!actual || (expectedTarget &&
        (actual.rootId !== expectedTarget.rootId || actual.profileId !== expectedTarget.profileId)))
      throw new Error('Target ownership changed.');
  }
  restrictCredentialDirectory(targetRoot, { replaceWindowsAccess: true });
  const sourcePhysical = await metadata(sourceRoot, 'directory');
  const targetPhysical = await metadata(targetRoot, 'directory');
  const replacements = new Map<string, string>();
  for (const [relative, snapshotPath] of options.replaceFiles ?? []) {
    const normalized = canonicalCase(normalizeRelocationRelativePath(relative));
    if (excludesRoot(normalized)) continue;
    if (replacements.has(normalized)) throw changed();
    replacements.set(normalized, canonicalFile(snapshotPath));
  }
  const excluded = sourceExclusions([
    ...(options.excludeRelativePaths ?? []),
    ...replacements.keys(),
  ]);
  const entries = await inventory(sourceRoot, excluded.excluded, options.signal, true);
  for (const [relative, snapshotPath] of replacements) {
    options.signal?.throwIfAborted();
    const destination = path.join(sourceRoot, relative);
    canonicalFile(destination);
    await metadata(destination, 'file');
    if (pathsOverlap(targetRoot, snapshotPath)) throw changed();
    const physical = await metadata(snapshotPath, 'file');
    entries.push({
      relativePath: relative,
      kind: 'file',
      size: physical.size,
      physical,
      provenance: { snapshotPath },
    });
  }
  // Parents are created before children regardless of filename sorting.
  for (const entry of entries
    .filter(entry => entry.kind === 'directory')
    .sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length)) {
    options.signal?.throwIfAborted();
    const destination = path.join(targetRoot, entry.relativePath);
    assertCanonicalParentDirectory(path.dirname(destination));
    await fsp.mkdir(destination, { mode: 0o700 });
  }
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (const entry of entries.filter(entry => entry.kind === 'file')) {
    options.signal?.throwIfAborted();
    const source = entry.provenance?.snapshotPath ?? path.join(sourceRoot, entry.relativePath);
    // A static source hardlink is materialized as its own target file. Snapshots
    // and target files still require a single link.
    const allowHardlinks = !entry.provenance;
    const destination = path.join(targetRoot, entry.relativePath);
    canonicalFile(source);
    const sourceHandle = await fsp.open(
      source,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await sourceHandle.stat({ bigint: true });
      if (
        !isRegularFile(before, allowHardlinks) ||
        !samePhysical(entry.physical, relocationPhysicalIdentity(before), true)
      )
        throw changed();
      options.signal?.throwIfAborted();
      assertCanonicalParentDirectory(path.dirname(destination));
      // The target remains inactive until the locator commits. Exclusive creation
      // preserves any unexpected existing file, and children inherit the root ACL.
      const targetHandle = await fsp.open(destination, 'wx', 0o600);
      try {
        canonicalFile(destination);
        const copied = await copyFileBytes(sourceHandle, targetHandle, buffer, options.signal);
        if (copied !== entry.size) throw changed();
        await targetHandle.sync();
      } finally {
        await targetHandle.close();
      }
      if (entry.provenance &&
          !samePhysical(entry.physical, relocationPhysicalIdentity(await sourceHandle.stat({ bigint: true })), true))
        throw changed();
    } finally {
      await sourceHandle.close();
    }
  }
  const manifest: RelocationManifest = {
    sourceRoot,
    targetRoot,
    sourcePhysical,
    targetPhysical,
    entries: entries.sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    ),
    excludeRelativePaths: excluded.nested,
  };
  await verifyTargetManifest(manifest, options.signal);
  return manifest;
}

/** Check that every expected file and directory was created before native preparation. */
async function verifyTargetManifest(
  manifest: RelocationManifest,
  signal?: AbortSignal,
): Promise<void> {
  assertCanonicalDirectory(manifest.targetRoot);
  if (
    !samePhysical(manifest.targetPhysical, await metadata(manifest.targetRoot, 'directory'), false)
  )
    throw changed();
  const current = await inventory(
    manifest.targetRoot,
    name => canonicalCase(name) === canonicalCase(StorageRelocationFile.RootIdentity),
    signal,
  );
  if (current.length !== manifest.entries.length) throw changed();
  for (let index = 0; index < current.length; index += 1) {
    signal?.throwIfAborted();
    const actual = current[index];
    const expected = manifest.entries[index];
    if (
      canonicalCase(actual.relativePath) !== canonicalCase(expected.relativePath) ||
      actual.kind !== expected.kind ||
      actual.size !== expected.size
    )
      throw changed();
  }
}

/** Check that the static source stayed in place before activation. */
export async function verifySourceManifest(
  manifest: RelocationManifest,
  signal?: AbortSignal,
): Promise<void> {
  assertCanonicalDirectory(manifest.sourceRoot);
  assertCanonicalDirectory(manifest.targetRoot);
  if (
    !samePhysical(
      manifest.sourcePhysical,
      await metadata(manifest.sourceRoot, 'directory'),
      false,
    ) ||
    !samePhysical(manifest.targetPhysical, await metadata(manifest.targetRoot, 'directory'), false)
  )
    throw changed();
  const excluded = sourceExclusions(manifest.excludeRelativePaths);
  const current = await inventory(manifest.sourceRoot, excluded.excluded, signal, true);
  const expected = manifest.entries.filter(entry => !entry.provenance);
  if (current.length !== expected.length) throw changed();
  for (let index = 0; index < current.length; index += 1) {
    signal?.throwIfAborted();
    const actual = current[index];
    const previous = expected[index];
    if (
      actual.relativePath !== previous.relativePath ||
      actual.kind !== previous.kind ||
      !samePhysical(actual.physical, previous.physical, actual.kind === 'file')
    )
      throw changed();
  }
}
