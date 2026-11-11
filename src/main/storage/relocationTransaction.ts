import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import JSON5 from 'json5';

import { StorageMaintenancePhase } from '../../shared/storage/storageRelocation';
import { restrictCredentialDirectory } from '../openclaw/config/models/providerSecretFile';
import { writeStartupJson } from '../startup/routing/startupState';
import { NativeDatabaseUpgradeRuntime } from '../startup/upgrade/nativeDatabaseUpgradeRuntime';
import { cleanRelocationSource, type RelocationCleanupProtectedPaths } from './relocationCleanup';
import { writeRelocationCleanupReceipt } from './relocationCleanupReceipt';
import { checkRelocationTargetContents, copyRelocationFiles, verifySourceManifest } from './relocationFiles';
import { type NativeRelocationPluginPlan, NativeRelocationSource } from './relocationNativeRuntime';
import { prepareRelocatedOpenClawConfig } from './relocationPaths';
import { readStorageProcessIdentity } from './relocationProcessRetirement';
import {
  captureExcludedBrowserCaches,
  retainedSourceConfigPaths,
  selectCopiedSourceCleanupEntries,
  type SourceCleanupEntry,
} from './relocationSourceCleanupSelection';
import {
  assertCanonicalDirectory,
  assertCanonicalParentDirectory,
  readRelocationJournal,
  readStorageLocator,
  type RelocationJournal,
  RelocationStage,
  writeRelocationJournal,
  writeStorageLocator,
} from './relocationState';

const configFor = (root: string) => path.join(root, 'openclaw', 'state', 'openclaw.json');
const generatedSkillDirectory = 'openclaw/state/plugin-skills';

function generatedSkillLinks(root: string): string[] {
  const directory = path.join(root, generatedSkillDirectory);
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isSymbolicLink())
    .map(entry => path.join(generatedSkillDirectory, entry.name));
}

function preserveFilesInGeneratedSkillDirectory(journal: RelocationJournal): void {
  const directory = path.join(journal.targetRoot, generatedSkillDirectory);
  if (!fs.existsSync(directory) || !fs.readdirSync(directory).length) return;
  // Native publication may remove ordinary subdirectories from this reserved cache on Windows.
  const retained = path.join(journal.targetRoot, 'openclaw', 'retained-plugin-skills');
  fs.mkdirSync(retained, { recursive: true });
  fs.renameSync(directory, path.join(retained, journal.transactionId));
}

async function withResourceRetirement(
  operation: () => Promise<void>,
  retire: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } finally {
    // A retirement failure must fence recovery even when the operation also failed.
    await retire();
  }
}
export async function prepareRelocationNativeTarget(
  runtimeRoot: string,
  targetRoot: string,
  signal?: AbortSignal,
  trackedSpawn?: typeof spawn,
  relocationPlugins?: NativeRelocationPluginPlan,
): Promise<void> {
  signal?.throwIfAborted();
  const runtime = new NativeDatabaseUpgradeRuntime({
    getRuntimeRoot: () => runtimeRoot,
    stateDir: path.join(targetRoot, 'openclaw', 'state'),
    configPath: configFor(targetRoot),
    gatewayStopped: () => true,
    spawn: trackedSpawn,
    relocationPlugins,
    relocationFailureRoot: targetRoot,
  });
  const abort = () => {
    void runtime.stop().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  await withResourceRetirement(
    async () => {
      signal?.throwIfAborted();
      // The prepare worker inspects the target and refuses pending schema upgrades.
      await runtime.prepareCanonical();
      signal?.throwIfAborted();
    },
    async () => {
      signal?.removeEventListener('abort', abort);
      let stopFailed = false;
      let failure: unknown;
      try {
        await runtime.stop();
      } catch (error) {
        stopFailed = true;
        failure = error;
      }
      if (!runtime.retirementConfirmed)
        throw Object.assign(new Error('Target process retirement is unconfirmed.'), {
          code: 'retirement-unconfirmed',
        });
      if (stopFailed) throw failure;
    },
  );
}

/** Caller owns the fixed bootstrap singleton and has confirmed the old process tree retired. */
export async function executeStorageRelocation(options: {
  bootstrapRoot: string;
  runtimeRoot: string;
  signal: AbortSignal;
  getProtectedPaths: (targetRoot: string) => RelocationCleanupProtectedPaths;
  projectProfilePaths?: (sourceRoot: string, targetRoot: string) => void;
  onPhase?: (phase: StorageMaintenancePhase) => void;
  onTemporaryDirectory?: (directory: string) => void;
  createSource?: (
    options: ConstructorParameters<typeof NativeRelocationSource>[0],
  ) => NativeRelocationSource;
  prepareTarget?: typeof prepareRelocationNativeTarget;
}): Promise<void> {
  options.signal.throwIfAborted();
  let journal = readRelocationJournal(options.bootstrapRoot);
  const locator = readStorageLocator(options.bootstrapRoot);
  if (!journal || !locator || journal.profileId !== locator.profileId)
    throw new Error('No migration is available.');
  const finish = async () => {
    const activeRoot = journal!.targetRoot;
    const cleanup = await cleanRelocationSource({
      bootstrapRoot: options.bootstrapRoot,
      activeRoot,
      signal: options.signal,
      getProtectedPaths: options.getProtectedPaths,
    });
    if (cleanup.pending) throw cleanup.failure ?? new Error('Old data cleanup could not finish.');
    writeRelocationJournal(options.bootstrapRoot, {
      ...journal!,
      stage: RelocationStage.Activated,
      updatedAt: Math.max(Date.now(), journal!.updatedAt),
      errorCode: undefined,
    });
  };
  // The locator only switches after the target is prepared. Maintenance has
  // already verified any prior child processes retired before calling here.
  if (
    locator.activeRoot === journal.targetRoot &&
    locator.activeRootId === journal.targetRootId &&
    locator.revision === journal.sourceRevision + 1
  ) {
    options.onPhase?.(StorageMaintenancePhase.SwitchingLocation);
    await finish();
    return;
  }
  const shutdown = journal.cleanShutdown ?? journal.forcedShutdown;
  if (
    locator.activeRoot !== journal.sourceRoot ||
    locator.activeRootId !== journal.sourceRootId ||
    locator.revision !== journal.sourceRevision ||
    !shutdown
  )
    throw new Error('Source retirement handoff is not confirmed.');

  // A partial destination cannot be reused. Avoid building snapshots in that case.
  checkRelocationTargetContents(journal.targetRoot);

  let nativeScratch: string | undefined;
  const trackedSpawn = ((...args: Parameters<typeof spawn>) => {
    const [command, parameters, settings] = args;
    if (
      !Array.isArray(parameters) ||
      parameters[0] !== '--input-type=module' ||
      parameters[1] !== '-e' ||
      typeof parameters[2] !== 'string' ||
      typeof parameters[3] !== 'string'
    )
      throw new Error('Unsupported native launch.');
    // A new child cannot open state until its actual OS identity has been durably recorded.
    // IPC also avoids the Windows command-line limit for the worker and its file inventory.
    const waitForAdmission = `
      process.on('message', message => {
        if (message?.type === 'abort') globalThis.storageOwnerAbortedBeforeStart = true;
      });
      const start = await new Promise((resolve, reject) => {
        process.once('disconnect', () => reject(new Error('Storage owner disconnected before admission.')));
        process.once('message', message => message?.type === 'storage-owner-start'
          ? resolve(message) : reject(new Error('Storage owner was not admitted.')));
      });
      if (!process.connected || globalThis.storageOwnerAbortedBeforeStart)
        throw new Error('Storage owner was interrupted before admission.');
      process.argv[1] = start.input;
      await import('data:text/javascript;base64,' + Buffer.from(start.source).toString('base64'));
    `;
    if (!nativeScratch) {
      assertCanonicalParentDirectory(path.dirname(journal!.targetRoot));
      nativeScratch = path.join(
        path.dirname(journal!.targetRoot),
        `storage-native-${randomUUID()}`,
      );
      fs.mkdirSync(nativeScratch, { mode: 0o700 });
      options.onTemporaryDirectory?.(nativeScratch);
      restrictCredentialDirectory(nativeScratch);
    }
    const child = spawn(
      command,
      [...parameters.slice(0, 2), waitForAdmission],
      { ...settings, env: { ...(settings?.env ?? process.env), XDG_CACHE_HOME: nativeScratch } },
    );
    try {
      if (!child.pid) throw new Error('Native process identity is unavailable.');
      const identity = readStorageProcessIdentity(child.pid);
      journal = {
        ...journal!,
        updatedAt: Date.now(),
        maintenanceProcesses: [...(journal!.maintenanceProcesses ?? []), identity],
      };
      writeRelocationJournal(options.bootstrapRoot, journal);
      child.send({ type: 'storage-owner-start', source: parameters[2], input: parameters[3] }, () => {});
    } catch {
      // Do not throw and lose custody: the native owner must observe this child's real close.
      if (child.connected) child.disconnect();
    }
    return child;
  }) as typeof spawn;
  options.signal.throwIfAborted();
  const sourceState = path.join(journal.sourceRoot, 'openclaw', 'state');
  for (const directory of [path.dirname(sourceState), sourceState]) {
    if (fs.lstatSync(directory, { throwIfNoEntry: false })) assertCanonicalDirectory(directory);
  }
  const sourceConfig = configFor(journal.sourceRoot);
  const configStat = fs.lstatSync(sourceConfig, { throwIfNoEntry: false });
  if (configStat && !configStat.isFile())
    throw new Error('The source configuration must be an ordinary file.');
  options.signal.throwIfAborted();
  // Large temporary snapshots use the destination drive, leaving only small control records on C:.
  const snapshotDir = path.join(
    path.dirname(journal.targetRoot),
    `storage-snapshot-${randomUUID()}`,
  );
  assertCanonicalParentDirectory(path.dirname(snapshotDir));
  fs.mkdirSync(snapshotDir, { mode: 0o700 });
  options.onTemporaryDirectory?.(snapshotDir);
  restrictCredentialDirectory(snapshotDir);
  const source = (options.createSource ?? (settings => new NativeRelocationSource(settings)))({
    runtimeRoot: options.runtimeRoot,
    profileRoot: journal.sourceRoot,
    stateDir: sourceState,
    configPath: sourceConfig,
    snapshotDir,
    spawn: trackedSpawn,
  });
  let released = false;
  const abort = () => {
    void source.abort().catch(() => {});
  };
  options.signal.addEventListener('abort', abort, { once: true });
  await withResourceRetirement(
    async () => {
      options.signal.throwIfAborted();
      options.onPhase?.(StorageMaintenancePhase.PreparingData);
      const native = await source.acquire();
      options.signal.throwIfAborted();
      const managedPlugins = native.managedPlugins;
      options.onPhase?.(StorageMaintenancePhase.CopyingData);
      const manifest = await copyRelocationFiles({
        sourceRoot: journal.sourceRoot,
        targetRoot: journal.targetRoot,
        targetIdentity: { profileId: journal.profileId, rootId: journal.targetRootId },
        excludeRelativePaths: [
          ...native.excludeRelativePaths,
          ...(managedPlugins?.peers ?? []).map(relative => path.join('openclaw', 'state', relative)),
          ...generatedSkillLinks(journal.sourceRoot),
        ],
        replaceFiles: new Map(Object.entries(native.replaceFiles)),
        signal: options.signal,
      });
      options.signal.throwIfAborted();
      options.onPhase?.(StorageMaintenancePhase.PreparingDestination);
      preserveFilesInGeneratedSkillDirectory(journal);
      options.projectProfilePaths?.(journal.sourceRoot, journal.targetRoot);
      const targetConfig = configFor(journal.targetRoot);
      let protectedPaths: string[] = [];
      if (fs.existsSync(targetConfig)) {
        const configBytes = await fsp.readFile(targetConfig, 'utf8');
        options.signal.throwIfAborted();
        const config = prepareRelocatedOpenClawConfig(
          JSON5.parse(configBytes, (_key, value: unknown) => {
            if (typeof value === 'number' && !Number.isFinite(value))
              throw new Error('The configuration contains a number that cannot be preserved as JSON.');
            return value;
          }),
          journal.sourceRoot,
          journal.targetRoot,
        );
        writeStartupJson(targetConfig, config);
        protectedPaths = retainedSourceConfigPaths(config, journal.sourceRoot);
      }
      options.signal.throwIfAborted();
      await (options.prepareTarget ?? prepareRelocationNativeTarget)(
        options.runtimeRoot,
        journal.targetRoot,
        options.signal,
        trackedSpawn,
        managedPlugins ? { ...managedPlugins, sourceStateDir: sourceState } : undefined,
      );
      options.signal.throwIfAborted();
      await verifySourceManifest(manifest, options.signal);
      options.signal.throwIfAborted();
      let excludedCaches: SourceCleanupEntry[] = [];
      try {
        excludedCaches = await captureExcludedBrowserCaches(journal.sourceRoot, protectedPaths, options.signal);
      } catch {
        console.warn('[StorageRelocation] Old browser cache cleanup inventory is unavailable.');
      }
      options.signal.throwIfAborted();
      try {
        const copied = selectCopiedSourceCleanupEntries(manifest, protectedPaths);
        writeRelocationCleanupReceipt(journal, manifest.sourcePhysical, [...copied, ...excludedCaches], 'copied');
      } catch {
        console.warn('[StorageRelocation] Old copied data cleanup receipt is unavailable.');
      }
      const openclaw = manifest.entries.find(entry =>
        entry.kind === 'directory' && entry.relativePath.toLowerCase() === 'openclaw',
      );
      if (openclaw)
        writeRelocationCleanupReceipt(journal, manifest.sourcePhysical, [openclaw], 'openclaw');
      options.signal.throwIfAborted();
      await source.assertHeld();
      options.signal.throwIfAborted();
      options.onPhase?.(StorageMaintenancePhase.SwitchingLocation);
      // Synchronous revision-checked replacement is the only activation commit point.
      writeStorageLocator(
        options.bootstrapRoot,
        {
          ...locator,
          revision: locator.revision + 1,
          activeRoot: journal.targetRoot,
          activeRootId: journal.targetRootId,
        },
        locator.revision,
      );
      await source.release();
      released = true;
      // These are transfer intermediates, not the retained source or user backups.
      for (const filename of new Set(Object.values(native.replaceFiles))) {
        if (path.dirname(filename) === snapshotDir) await fsp.unlink(filename).catch(() => {});
      }
      await fsp.rmdir(snapshotDir).catch(() => {});
      if (nativeScratch) {
        await fsp.rmdir(path.join(nativeScratch, 'openclaw')).catch(() => {});
        await fsp.rmdir(nativeScratch).catch(() => {});
      }
      await finish();
    },
    async () => {
      options.signal.removeEventListener('abort', abort);
      if (!released) {
        await source.abort().catch(() => {});
        if (!source.retirementConfirmed)
          throw Object.assign(new Error('Source process retirement is unconfirmed.'), {
            code: 'retirement-unconfirmed',
          });
      }
    },
  );
}
