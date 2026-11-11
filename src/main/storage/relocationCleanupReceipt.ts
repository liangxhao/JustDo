import { randomUUID } from 'node:crypto';
import fs, { type BigIntStats } from 'node:fs';
import path from 'node:path';

import {
  restrictCredentialDirectory,
  restrictCredentialFile,
} from '../openclaw/config/models/providerSecretFile';
import {
  normalizeRelocationRelativePath,
  type RelocationManifestEntry,
  type RelocationPhysicalIdentity,
  relocationPhysicalIdentity,
} from './relocationFiles';
import { RELOCATION_ROOT_SCOPE } from './relocationScope';
import { isCopiedSourceCleanupCandidate } from './relocationSourceCleanupSelection';
import {
  assertCanonicalDirectory,
  readStorageRootIdentity,
  type RelocationJournal,
  StorageRelocationFile,
} from './relocationState';

export type RelocationCleanupKind = 'copied' | 'openclaw';
export type RelocationCleanupEntry = Pick<RelocationManifestEntry, 'relativePath' | 'kind' | 'physical'>;

type CleanupReceipt = Pick<RelocationJournal, 'transactionId' | 'profileId' | 'sourceRoot' |
  'targetRoot' | 'sourceRootId' | 'targetRootId' | 'sourceRevision'> & {
  version: 1;
  kind: RelocationCleanupKind;
  sourcePhysical: RelocationPhysicalIdentity;
  entries: RelocationCleanupEntry[];
};

type LoadedCleanupReceipt = Pick<CleanupReceipt, 'entries' | 'sourcePhysical' | 'kind'> & {
  filename: string;
  physical: RelocationPhysicalIdentity;
};

const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 1_000_000;
const invalid = () => new Error('The relocation cleanup receipt is invalid or unavailable.');
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export const relocationCleanupPathKey = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value;

const fixedRoots = new Set(RELOCATION_ROOT_SCOPE.protectFromCleanup.map(relocationCleanupPathKey));

function normalizeRelative(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 32_767) return undefined;
  try {
    const normalized = normalizeRelocationRelativePath(value);
    const key = relocationCleanupPathKey(normalized);
    if (fixedRoots.has(key.split('/')[0])) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

export function sameCleanupPhysical(
  left: RelocationPhysicalIdentity,
  right: RelocationPhysicalIdentity,
  file: boolean,
): boolean {
  // Windows may update ctime when the fixed bootstrap ACL changes.
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs &&
    (!file || (left.size === right.size && left.mtimeNs === right.mtimeNs));
}

function isPhysical(value: unknown): value is RelocationPhysicalIdentity {
  return record(value) && exactKeys(value, ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs']) &&
    [value.dev, value.ino, value.birthtimeNs, value.mtimeNs, value.ctimeNs]
      .every(part => typeof part === 'string' && /^-?\d{1,24}$/u.test(part)) &&
    typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0;
}

function isEntry(value: unknown): value is RelocationCleanupEntry {
  return record(value) && exactKeys(value, ['relativePath', 'kind', 'physical']) &&
    typeof value.relativePath === 'string' && normalizeRelative(value.relativePath) === value.relativePath &&
    (value.kind === 'file' || value.kind === 'directory') && isPhysical(value.physical);
}

function validEntries(value: unknown, kind: RelocationCleanupKind): value is RelocationCleanupEntry[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ENTRIES || !value.every(isEntry)) return false;
  if (kind === 'openclaw') return value.length === 1 && value[0].kind === 'directory' &&
    relocationCleanupPathKey(value[0].relativePath) === 'openclaw';
  const seen = new Set<string>();
  const parents = new Set<string>();
  for (const entry of value) {
    const key = relocationCleanupPathKey(entry.relativePath);
    if (seen.has(key)) return false;
    seen.add(key);
    if (entry.kind !== 'file') continue;
    if (!isCopiedSourceCleanupCandidate(entry.relativePath)) return false;
    let parent = path.posix.dirname(key);
    while (parent !== '.' && !parents.has(parent)) {
      parents.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return value.every(entry => entry.kind === 'file' || isCopiedSourceCleanupCandidate(entry.relativePath) ||
    parents.has(relocationCleanupPathKey(entry.relativePath)));
}

function receiptBinding(journal: RelocationJournal, kind: RelocationCleanupKind) {
  return {
    version: 1 as const,
    kind,
    transactionId: journal.transactionId,
    profileId: journal.profileId,
    sourceRoot: journal.sourceRoot,
    targetRoot: journal.targetRoot,
    sourceRootId: journal.sourceRootId,
    targetRootId: journal.targetRootId,
    sourceRevision: journal.sourceRevision,
  };
}

function readReceiptStat(filename: string): BigIntStats | undefined {
  const stat = fs.lstatSync(filename, { bigint: true, throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
    stat.size < 1n || stat.size > BigInt(MAX_RECEIPT_BYTES))) throw invalid();
  return stat;
}

/** Publish an immutable deletion list on the destination drive before cleanup can begin. */
export function writeRelocationCleanupReceipt(
  journal: RelocationJournal,
  sourcePhysical: RelocationPhysicalIdentity,
  entries: readonly RelocationCleanupEntry[],
  kind: RelocationCleanupKind,
): void {
  if (!entries.length) return;
  if (entries.length > MAX_ENTRIES) throw invalid();
  const target = readStorageRootIdentity(journal.targetRoot);
  if (target?.profileId !== journal.profileId || target.rootId !== journal.targetRootId) throw invalid();
  const normalized = entries.map(({ relativePath, kind, physical }) => ({
    relativePath: normalizeRelative(relativePath), kind, physical,
  }));
  if (!isPhysical(sourcePhysical) || !validEntries(normalized, kind)) throw invalid();
  const receipt: CleanupReceipt = { ...receiptBinding(journal, kind), sourcePhysical, entries: normalized };
  const serialized = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES) throw invalid();
  const directory = path.join(journal.targetRoot, StorageRelocationFile.ControlDirectory);
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
  assertCanonicalDirectory(directory);
  restrictCredentialDirectory(directory);
  const filename = path.join(directory, `cleanup-${kind}.json`);
  if (fs.lstatSync(filename, { throwIfNoEntry: false })) throw invalid();
  const temporary = path.join(directory, `.cleanup-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let ownsTemporary = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    ownsTemporary = true;
    restrictCredentialFile(temporary);
    fs.writeFileSync(fd, serialized);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertCanonicalDirectory(directory);
    if (fs.lstatSync(filename, { throwIfNoEntry: false })) throw invalid();
    fs.renameSync(temporary, filename);
    ownsTemporary = false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (ownsTemporary) {
      try { fs.unlinkSync(temporary); }
      catch { /* Keep any unpublished temporary that is unavailable. */ }
    }
  }
}

export function readRelocationCleanupReceipt(
  journal: RelocationJournal,
  kind: RelocationCleanupKind,
): LoadedCleanupReceipt | null {
  const directory = path.join(journal.targetRoot, StorageRelocationFile.ControlDirectory);
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) return null;
  assertCanonicalDirectory(directory);
  const filename = path.join(directory, `cleanup-${kind}.json`);
  const stat = readReceiptStat(filename);
  if (!stat) return null;
  const physical = relocationPhysicalIdentity(stat);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n ||
      !sameCleanupPhysical(physical, relocationPhysicalIdentity(before), true)) throw invalid();
    const bytes = Buffer.allocUnsafe(physical.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length !== physical.size || !sameCleanupPhysical(
      physical, relocationPhysicalIdentity(fs.fstatSync(fd, { bigint: true })), true,
    )) throw invalid();
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    const expected = Object.entries(receiptBinding(journal, kind));
    if (!record(value) || !exactKeys(value, [...expected.map(([key]) => key), 'sourcePhysical', 'entries']) ||
      !expected.every(([key, field]) => value[key] === field) ||
      !isPhysical(value.sourcePhysical) || !validEntries(value.entries, kind)) throw invalid();
    return { filename, physical, kind, sourcePhysical: value.sourcePhysical, entries: value.entries };
  } finally {
    fs.closeSync(fd);
  }
}

export function retireRelocationCleanupReceipt(receipt: LoadedCleanupReceipt): void {
  assertCanonicalDirectory(path.dirname(receipt.filename));
  const stat = readReceiptStat(receipt.filename);
  if (!stat) return;
  if (!sameCleanupPhysical(receipt.physical, relocationPhysicalIdentity(stat), true)) throw invalid();
  fs.unlinkSync(receipt.filename);
}
