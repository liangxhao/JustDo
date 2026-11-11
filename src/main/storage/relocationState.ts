import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  restrictCredentialDirectory,
  restrictCredentialFile,
} from '../openclaw/config/models/providerSecretFile';
import { atStorageLocation, StorageStartupFailure } from './storageStartupFailure';

export const StorageRelocationFile = {
  Locator: 'storage-location.json',
  InitialBinding: 'storage-location.initializing.json',
  RootIdentity: 'storage-root.json',
  ControlDirectory: 'storage-relocation',
  Journal: 'active.json',
} as const;

export const RelocationStage = {
  Requested: 'requested',
  SourceRetired: 'source-retired',
  Committed: 'committed',
  Activated: 'activated',
  // Legacy records still identify pending and cancelled requests.
  Cancelled: 'cancelled',
  Failed: 'failed',
  Copying: 'copying',
  Copied: 'copied',
  TargetPreparing: 'target-preparing',
  TargetReady: 'target-ready',
} as const;
export type RelocationStage = (typeof RelocationStage)[keyof typeof RelocationStage];

export type StorageLocator = {
  version: 1;
  profileId: string;
  revision: number;
  activeRoot: string;
  activeRootId: string;
};
export type StorageRootIdentity = { version: 1; profileId: string; rootId: string };
type InitialStorageBinding = StorageRootIdentity & { directoryIdentity: string };
type RelocationShutdownReceipt = {
  pid: number;
  transactionId: string;
  completedAt: number;
  processes?: Array<{ pid: number; creationTime: number }>;
};
export type RelocationJournal = {
  version: 1;
  transactionId: string;
  profileId: string;
  sourceRoot: string;
  targetRoot: string;
  sourceRootId: string;
  targetRootId: string;
  sourceRevision: number;
  stage: RelocationStage;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
  maintenanceProcesses?: Array<{ pid: number; creationTime: number }>;
  sourceProcesses?: Array<{ pid: number; creationTime: number }>;
  cleanShutdown?: RelocationShutdownReceipt;
  forcedShutdown?: RelocationShutdownReceipt;
};

export type StorageBootstrapContext = {
  bootstrapRoot: string;
  activeRoot: string;
  singletonOwned: boolean;
};
let bootstrapContext: StorageBootstrapContext | undefined;
export function setStorageBootstrapContext(value: StorageBootstrapContext): void {
  bootstrapContext = value;
}
export function getStorageBootstrapContext(): StorageBootstrapContext | undefined {
  return bootstrapContext;
}

const MAX_CONTROL_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const knownKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) =>
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const unavailable = (cause?: unknown) => new Error('Storage relocation state is invalid or unavailable.', { cause });
const samePath = (left: string, right: string) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

/** Require a canonical non-root absolute path; no control characters, ADS or relative aliases. */
export function isRelocationRootPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    /[\u0000-\u001f]/u.test(value) ||
    !path.isAbsolute(value)
  )
    return false;
  const resolved = path.resolve(value);
  if (!samePath(value, resolved) || resolved === path.parse(resolved).root) return false;
  if (
    process.platform === 'win32' &&
    (!/^[a-z]:\\/iu.test(resolved) || resolved.slice(2).includes(':'))
  )
    return false;
  return true;
}

/** Reject directory links along the path and non-canonical Windows spellings. */
export function assertCanonicalDirectory(directory: string): string {
  if (!isRelocationRootPath(directory)) throw unavailable();
  const root = path.parse(directory).root;
  let current = root;
  for (const segment of path.relative(root, directory).split(path.sep)) {
    current = path.join(current, segment);
    const metadata = fs.lstatSync(current);
    if (metadata.isSymbolicLink()) throw new StorageStartupFailure('folderAlias', current);
    if (!metadata.isDirectory()) throw new StorageStartupFailure('notFolder', current);
  }
  const real = fs.realpathSync.native(directory);
  if (!samePath(real, directory)) throw new StorageStartupFailure('folderAlias', directory);
  return real;
}

/** File operations may use a drive root as an ancestor, never as a data or control root. */
export function assertCanonicalParentDirectory(directory: string): string {
  if (isRelocationRootPath(directory)) return assertCanonicalDirectory(directory);
  if (
    process.platform !== 'win32' ||
    !/^[a-z]:\\$/iu.test(directory) ||
    !samePath(path.resolve(directory), directory)
  )
    throw unavailable();
  const metadata = fs.lstatSync(directory);
  const real = fs.realpathSync.native(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(real, directory))
    throw unavailable();
  return real;
}

function isLocator(value: unknown): value is StorageLocator {
  return (
    record(value) &&
    knownKeys(value, ['version', 'profileId', 'revision', 'activeRoot', 'activeRootId']) &&
    value.version === 1 &&
    uuid(value.profileId) &&
    positive(value.revision) &&
    isRelocationRootPath(value.activeRoot) &&
    uuid(value.activeRootId)
  );
}
function isRootIdentity(value: unknown): value is StorageRootIdentity {
  return (
    record(value) &&
    knownKeys(value, ['version', 'profileId', 'rootId']) &&
    value.version === 1 &&
    uuid(value.profileId) &&
    uuid(value.rootId)
  );
}
function isInitialStorageBinding(value: unknown): value is InitialStorageBinding {
  return record(value) &&
    knownKeys(value, ['version', 'profileId', 'rootId', 'directoryIdentity']) &&
    isRootIdentity({ version: value.version, profileId: value.profileId, rootId: value.rootId }) &&
    typeof value.directoryIdentity === 'string' &&
    /^\d{1,24}:\d{1,24}:-?\d{1,24}$/u.test(value.directoryIdentity);
}
function isProcessIdentities(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every(
      process =>
        record(process) &&
        knownKeys(process, ['pid', 'creationTime']) &&
        positive(process.pid) &&
        typeof process.creationTime === 'number' &&
        Number.isFinite(process.creationTime) &&
        process.creationTime > 0 &&
        process.creationTime <= Number.MAX_SAFE_INTEGER,
    )
  );
}
function isShutdownReceipt(value: unknown, transactionId: unknown): value is RelocationShutdownReceipt {
  return (
    record(value) &&
    knownKeys(
      value,
      ['pid', 'transactionId', 'completedAt'],
      // Previous builds expect the runtime fields, but retirement only needs process identities.
      ['processes', 'runtimeRoot', 'appVersion'],
    ) &&
    positive(value.pid) &&
    value.transactionId === transactionId &&
    positive(value.completedAt) &&
    (value.processes === undefined || isProcessIdentities(value.processes))
  );
}
function hasShutdownOwner(receipt: RelocationShutdownReceipt): boolean {
  return receipt.processes?.some(process => process.pid === receipt.pid) ?? false;
}
function isJournal(value: unknown): value is RelocationJournal {
  return (
    record(value) &&
    knownKeys(
      value,
      [
        'version',
        'transactionId',
        'profileId',
        'sourceRoot',
        'targetRoot',
        'sourceRootId',
        'targetRootId',
        'sourceRevision',
        'stage',
        'createdAt',
        'updatedAt',
      ],
      [
        'errorCode',
        'cleanShutdown',
        'forcedShutdown',
        'maintenanceProcesses',
        'sourceProcesses',
        // Ignore fields from older attempts that tracked copy progress or renamed targets.
        'lastStage',
        'targetRetainedPath',
      ],
    ) &&
    value.version === 1 &&
    uuid(value.transactionId) &&
    uuid(value.profileId) &&
    uuid(value.sourceRootId) &&
    uuid(value.targetRootId) &&
    positive(value.sourceRevision) &&
    isRelocationRootPath(value.sourceRoot) &&
    isRelocationRootPath(value.targetRoot) &&
    !pathsOverlap(value.sourceRoot, value.targetRoot) &&
    Object.values(RelocationStage).includes(value.stage as RelocationStage) &&
    positive(value.createdAt) &&
    positive(value.updatedAt) &&
    value.updatedAt >= value.createdAt &&
    (value.errorCode === undefined ||
      (typeof value.errorCode === 'string' && /^[a-z0-9_-]{1,128}$/u.test(value.errorCode))) &&
    (value.cleanShutdown === undefined ||
      isShutdownReceipt(value.cleanShutdown, value.transactionId)) &&
    (value.forcedShutdown === undefined ||
      (value.cleanShutdown === undefined &&
        isShutdownReceipt(value.forcedShutdown, value.transactionId) &&
        hasShutdownOwner(value.forcedShutdown))) &&
    (value.maintenanceProcesses === undefined || isProcessIdentities(value.maintenanceProcesses)) &&
    (value.sourceProcesses === undefined || isProcessIdentities(value.sourceProcesses))
  );
}

export function pathsOverlap(left: string, right: string): boolean {
  const a = process.platform === 'win32' ? path.resolve(left).toLowerCase() : path.resolve(left);
  const b = process.platform === 'win32' ? path.resolve(right).toLowerCase() : path.resolve(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

function readControl<T>(
  directory: string, name: string, valid: (value: unknown) => value is T,
): T | null {
  const file = path.join(assertCanonicalDirectory(directory), name);
  let fd: number | undefined;
  try {
    const metadata = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!metadata) return null;
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > MAX_CONTROL_BYTES
    )
      throw unavailable();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.nlink !== 1 ||
      opened.size > MAX_CONTROL_BYTES
    )
      throw unavailable();
    // Bound reads even if another process grows the control file after fstat.
    const buffer = Buffer.allocUnsafe(MAX_CONTROL_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!count) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_CONTROL_BYTES || bytesRead !== opened.size) throw unavailable();
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    const after = fs.fstatSync(fd);
    assertCanonicalDirectory(path.dirname(file));
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || !valid(value))
      throw unavailable();
    return value;
  } catch (error) {
    throw unavailable(error);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The caller owns cross-process exclusion. Flush file bytes before atomic replacement. */
function writeControl<T>(file: string, value: T, valid: (value: unknown) => value is T): void {
  if (!valid(value)) throw unavailable();
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONTROL_BYTES) throw unavailable();
  const directory = assertCanonicalDirectory(path.dirname(file));
  restrictCredentialDirectory(directory);
  const temporary = path.join(directory, `.storage-control-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    restrictCredentialFile(temporary);
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertCanonicalDirectory(directory);
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* Renamed or inaccessible; do not hide the original failure. */
    }
  }
}

/** Classification only: this does not establish that the selected data root is usable. */
export function readStorageLocatorMetadata(bootstrapRoot: string): StorageLocator | null {
  return readControl(bootstrapRoot, StorageRelocationFile.Locator, isLocator);
}

export function readStorageLocator(bootstrapRoot: string): StorageLocator | null {
  const value = atStorageLocation('locator', path.join(bootstrapRoot, StorageRelocationFile.Locator),
    () => readStorageLocatorMetadata(bootstrapRoot));
  if (value) {
    const root = atStorageLocation('data', value.activeRoot, () => readStorageRootIdentity(value.activeRoot));
    if (!root || root.profileId !== value.profileId || root.rootId !== value.activeRootId)
      throw new StorageStartupFailure('identity', value.activeRoot);
  }
  return value;
}

export function writeStorageLocator(
  bootstrapRoot: string,
  value: StorageLocator,
  expectedRevision?: number | null,
): void {
  const current = readStorageLocator(bootstrapRoot);
  if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision)
    throw unavailable();
  if (current && (value.profileId !== current.profileId || value.revision !== current.revision + 1))
    throw unavailable();
  const root = readStorageRootIdentity(value.activeRoot);
  if (!root || root.profileId !== value.profileId || root.rootId !== value.activeRootId)
    throw unavailable();
  writeControl(path.join(bootstrapRoot, StorageRelocationFile.Locator), value, isLocator);
}

export function readStorageRootIdentity(root: string): StorageRootIdentity | null {
  return readControl(root, StorageRelocationFile.RootIdentity, isRootIdentity);
}

export function writeStorageRootIdentity(root: string, value: StorageRootIdentity): void {
  const current = readStorageRootIdentity(root);
  if (current && (current.rootId !== value.rootId || current.profileId !== value.profileId))
    throw unavailable();
  writeControl(path.join(root, StorageRelocationFile.RootIdentity), value, isRootIdentity);
}

export function readStorageDirectoryIdentity(root: string): string {
  const stat = fs.lstatSync(assertCanonicalDirectory(root), { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

/** The fixed singleton owns this recovery. A bare root marker cannot authorize reopening the source. */
export function recoverInitialStorageBinding(bootstrapRoot: string): void {
  const file = path.join(bootstrapRoot, StorageRelocationFile.InitialBinding);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return;
  const intent = readControl(bootstrapRoot, StorageRelocationFile.InitialBinding, isInitialStorageBinding);
  if (
    !intent || intent.directoryIdentity !== readStorageDirectoryIdentity(bootstrapRoot) ||
    fs.lstatSync(path.join(bootstrapRoot, StorageRelocationFile.ControlDirectory), { throwIfNoEntry: false })
  ) throw unavailable();
  const root = readStorageRootIdentity(bootstrapRoot);
  if (root && (root.profileId !== intent.profileId || root.rootId !== intent.rootId))
    throw unavailable();
  const locator = readStorageLocator(bootstrapRoot);
  if (locator) {
    if (locator.revision !== 1 || !samePath(locator.activeRoot, bootstrapRoot) ||
        locator.profileId !== intent.profileId || locator.activeRootId !== intent.rootId)
      throw unavailable();
  } else if (root) {
    // Roll back only the marker this intent was allowed to create. It is safe
    // to retry this cleanup after interruption, even on a full bootstrap drive.
    fs.unlinkSync(path.join(bootstrapRoot, StorageRelocationFile.RootIdentity));
  }
  fs.unlinkSync(file);
}

/** Establish the original root before publishing the first relocation request. */
export function bindInitialStorageRoot(
  bootstrapRoot: string,
  locator: StorageLocator,
  expectedDirectoryIdentity?: string,
): void {
  const file = path.join(bootstrapRoot, StorageRelocationFile.InitialBinding);
  const directoryIdentity = readStorageDirectoryIdentity(bootstrapRoot);
  if (
    (expectedDirectoryIdentity && expectedDirectoryIdentity !== directoryIdentity) ||
    locator.revision !== 1 || !samePath(locator.activeRoot, bootstrapRoot) ||
    readStorageLocator(bootstrapRoot) || readStorageRootIdentity(bootstrapRoot) ||
    fs.lstatSync(file, { throwIfNoEntry: false }) ||
    fs.lstatSync(path.join(bootstrapRoot, StorageRelocationFile.ControlDirectory), { throwIfNoEntry: false })
  ) throw unavailable();
  const root: StorageRootIdentity = { version: 1, profileId: locator.profileId, rootId: locator.activeRootId };
  writeControl(file, { ...root, directoryIdentity }, isInitialStorageBinding);
  try {
    writeStorageRootIdentity(bootstrapRoot, root);
    writeStorageLocator(bootstrapRoot, locator, null);
  } catch (error) {
    try { recoverInitialStorageBinding(bootstrapRoot); }
    catch { /* The durable intent still owns recovery after restart. */ }
    throw error;
  }
  fs.unlinkSync(file);
}

function journalDirectory(bootstrapRoot: string): string {
  return path.join(assertCanonicalDirectory(bootstrapRoot), StorageRelocationFile.ControlDirectory);
}

export function readRelocationJournal(bootstrapRoot: string): RelocationJournal | null {
  const directory = journalDirectory(bootstrapRoot);
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) return null;
  const value = readControl(directory, StorageRelocationFile.Journal, isJournal);
  if (value && pathsOverlap(value.targetRoot, bootstrapRoot)) throw unavailable();
  return value;
}

function isCurrentRelocationSource(locator: StorageLocator | null, journal: RelocationJournal): boolean {
  return locator?.profileId === journal.profileId &&
    locator.activeRoot === journal.sourceRoot &&
    locator.activeRootId === journal.sourceRootId &&
    locator.revision === journal.sourceRevision;
}

export function isTerminalRelocationStage(stage: RelocationStage): boolean {
  return stage === RelocationStage.Activated || stage === RelocationStage.Cancelled;
}

export function writeRelocationJournal(bootstrapRoot: string, value: RelocationJournal): void {
  if (pathsOverlap(value.targetRoot, bootstrapRoot)) throw unavailable();
  const current = readRelocationJournal(bootstrapRoot);
  const replacesTerminal = current && current.transactionId !== value.transactionId &&
    isTerminalRelocationStage(current.stage) && value.stage === RelocationStage.Requested;
  if (
    current && !replacesTerminal &&
    (current.transactionId !== value.transactionId ||
      current.profileId !== value.profileId ||
      current.sourceRoot !== value.sourceRoot ||
      current.targetRoot !== value.targetRoot ||
      current.sourceRootId !== value.sourceRootId ||
      current.targetRootId !== value.targetRootId ||
      current.sourceRevision !== value.sourceRevision ||
      current.createdAt !== value.createdAt ||
      value.updatedAt < current.updatedAt)
  )
    throw unavailable();
  const locator = readStorageLocator(bootstrapRoot);
  if (!locator || locator.profileId !== value.profileId) throw unavailable();
  const targetIsCurrent =
    locator.activeRoot === value.targetRoot &&
    locator.activeRootId === value.targetRootId &&
    locator.revision === value.sourceRevision + 1;
  if ((!targetIsCurrent || replacesTerminal) && !isCurrentRelocationSource(locator, value))
    throw unavailable();
  const directory = journalDirectory(bootstrapRoot);
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
  writeControl(path.join(directory, StorageRelocationFile.Journal), value, isJournal);
}

export function removeRelocationJournal(bootstrapRoot: string, transactionId: string): void {
  const current = readRelocationJournal(bootstrapRoot);
  if (!current || current.transactionId !== transactionId ||
      !isCurrentRelocationSource(readStorageLocator(bootstrapRoot), current))
    throw unavailable();
  const directory = assertCanonicalDirectory(journalDirectory(bootstrapRoot));
  fs.unlinkSync(path.join(directory, StorageRelocationFile.Journal));
}
