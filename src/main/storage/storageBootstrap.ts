import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { USER_DATA_DIRECTORY_NAME } from '../../shared/productMetadata';
import {
  parseAgentBridgeArgv,
  resolveAgentBridgeProfile,
} from '../clients/cli/transport/agentBridgeProtocol';
import { resolveDevelopmentDataDirectory } from '../core/development/developmentDataDirectory';
import {
  assertCanonicalDirectory,
  readRelocationJournal,
  readStorageLocator,
  readStorageLocatorMetadata,
  readStorageRootIdentity,
  recoverInitialStorageBinding,
  RelocationStage,
  setStorageBootstrapContext,
  StorageRelocationFile,
} from './relocationState';
import { atStorageLocation, describeStorageStartupFailure, StorageStartupFailure } from './storageStartupFailure';

function independentStorageProfile(bootstrapRoot: string, bridgeProfile?: string): boolean {
  if (!bridgeProfile || path.resolve(bridgeProfile).toLowerCase() === bootstrapRoot.toLowerCase())
    return false;
  const identity = rootIdentityIfPresent(bridgeProfile);
  let locator: ReturnType<typeof readStorageLocatorMetadata> = null;
  try {
    locator = readStorageLocatorMetadata(bootstrapRoot);
  } catch {
    // Explicit isolated profiles may still prove independence through their root markers.
  }
  if (locator && path.relative(path.resolve(bridgeProfile), locator.activeRoot) === '')
    return false;
  if (!identity) return true;
  if (locator) return identity.profileId !== locator.profileId;
  const original = rootIdentityIfPresent(bootstrapRoot);
  if (original) return identity.profileId !== original.profileId;
  return !hasStorageControlArtifacts(bootstrapRoot);
}

function rootIdentityIfPresent(root: string): ReturnType<typeof readStorageRootIdentity> {
  return fs.lstatSync(path.join(root, StorageRelocationFile.RootIdentity), { throwIfNoEntry: false })
    ? readStorageRootIdentity(root)
    : null;
}

/** Presence only: never canonicalize an unmigrated legacy profile to decide absence. */
function hasStorageControlArtifacts(bootstrapRoot: string): boolean {
  // lstat also detects dangling links, without treating permission errors as absence.
  return [
    StorageRelocationFile.Locator,
    StorageRelocationFile.InitialBinding,
    StorageRelocationFile.RootIdentity,
    StorageRelocationFile.ControlDirectory,
  ].some(name => fs.lstatSync(path.join(bootstrapRoot, name), { throwIfNoEntry: false }));
}

function journalPending(journal: ReturnType<typeof readRelocationJournal>): boolean {
  if (!journal) return false;
  return journal.stage !== RelocationStage.Cancelled && journal.stage !== RelocationStage.Activated;
}

/** Never recurse through an unverified control directory when preparing the isolated profile. */
function maintenanceDirectory(bootstrapRoot: string): string {
  const bootstrap = atStorageLocation('recovery', bootstrapRoot, () => assertCanonicalDirectory(bootstrapRoot));
  const ensure = (directory: string) => atStorageLocation('recovery', directory, () => {
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
    return assertCanonicalDirectory(directory);
  });
  const control = ensure(path.join(bootstrap, StorageRelocationFile.ControlDirectory));
  return ensure(path.join(control, 'maintenance-profile'));
}

function resolveStorageRoot(bootstrapRoot: string): string {
  const locator = readStorageLocator(bootstrapRoot);
  if (!locator)
    throw new StorageStartupFailure('missingLocator', path.join(bootstrapRoot, StorageRelocationFile.Locator));
  return locator.activeRoot;
}

export async function runStorageBootstrap(): Promise<void> {
  if (process.platform !== 'win32') {
    await import('../application');
    return;
  }
  app.setName(USER_DATA_DIRECTORY_NAME);
  const bootstrapRoot = path.join(app.getPath('appData'), USER_DATA_DIRECTORY_NAME);
  const bridge = parseAgentBridgeArgv(process.argv);
  const bridgeProfile = bridge ? resolveAgentBridgeProfile(process.argv) : undefined;
  const developmentDirectory = bridgeProfile ? undefined : resolveDevelopmentDataDirectory({
    isPackaged: app.isPackaged,
    nodeEnv: process.env.NODE_ENV,
    directory: process.env.JUSTDO_DEV_USER_DATA_DIR,
  });
  if (!bridge && developmentDirectory && independentStorageProfile(bootstrapRoot, developmentDirectory)) {
    fs.mkdirSync(developmentDirectory, { recursive: true });
    app.setPath('userData', developmentDirectory);
    app.setPath('sessionData', developmentDirectory);
    await import('../application');
    return;
  }
  if (bridge) {
    try {
      const requestedProfile = bridgeProfile ?? developmentDirectory;
      if (independentStorageProfile(bootstrapRoot, requestedProfile)) {
        app.setPath('userData', requestedProfile!);
        app.setPath('sessionData', requestedProfile!);
        await import('../application');
        return;
      }
      if (!hasStorageControlArtifacts(bootstrapRoot)) {
        await import('../application');
        return;
      }
      const activeRoot = resolveStorageRoot(bootstrapRoot);
      if (journalPending(readRelocationJournal(bootstrapRoot)))
        throw new Error('Storage relocation is pending.');
      setStorageBootstrapContext({ bootstrapRoot, activeRoot, singletonOwned: false });
      app.setPath('userData', activeRoot);
      app.setPath('sessionData', activeRoot);
      await import('../application');
    } catch {
      app.exit(69);
    }
    return;
  }
  // Acquire Electron's singleton once at the fixed bootstrap root, before changing the profile.
  const locked = atStorageLocation('configuration', bootstrapRoot, () => {
    fs.mkdirSync(bootstrapRoot, { recursive: true });
    app.setPath('userData', bootstrapRoot);
    app.setPath('sessionData', bootstrapRoot);
    return app.requestSingleInstanceLock();
  });
  if (!locked) {
    app.exit(0);
    return;
  }
  // This repair belongs to the normal singleton owner. Keep the recovery UI
  // from creating a relocation directory until an initial binding is resolved.
  atStorageLocation('locator', path.join(bootstrapRoot, StorageRelocationFile.InitialBinding),
    () => recoverInitialStorageBinding(bootstrapRoot));
  // Inspect only after the previous owner released its lock: a request may have appeared meanwhile.
  let failure: unknown;
  let activeRoot: string | undefined;
  let pending = false;
  let legacy = false;
  try {
    legacy = !atStorageLocation('configuration', bootstrapRoot, () => hasStorageControlArtifacts(bootstrapRoot));
    if (!legacy) {
      activeRoot = resolveStorageRoot(bootstrapRoot);
      pending = journalPending(atStorageLocation('journal',
        path.join(bootstrapRoot, StorageRelocationFile.ControlDirectory, StorageRelocationFile.Journal),
        () => readRelocationJournal(bootstrapRoot)));
    }
  } catch (error) {
    failure = error;
    pending = true;
  }
  if (legacy) {
    // No context: later normal startup must retain its original alias/path behavior.
    await import('../application');
    return;
  }
  if (pending || !activeRoot) {
    if (!app.isPackaged) {
      app.exit(1);
      return;
    }
    try {
      const maintenanceRoot = maintenanceDirectory(bootstrapRoot);
      const installDirectory = path.dirname(app.getPath('exe'));
      atStorageLocation('recoveryWindow', installDirectory, () => process.chdir(installDirectory));
      atStorageLocation('recovery', maintenanceRoot, () => {
        app.setPath('userData', maintenanceRoot);
        app.setPath('sessionData', maintenanceRoot);
      });
      const { runStorageMaintenance } = await import('./storageMaintenance');
      await runStorageMaintenance({ bootstrapRoot, initialError: failure, dataPath: activeRoot });
    } catch (error) {
      const recoveryError = error instanceof StorageStartupFailure
        ? error
        : new StorageStartupFailure('recoveryWindow', undefined, error);
      const dataPath = activeRoot ?? describeStorageStartupFailure(failure, 'en').dataPath;
      throw dataPath ? new StorageStartupFailure('data', dataPath, recoveryError) : recoveryError;
    }
    return;
  }
  setStorageBootstrapContext({ bootstrapRoot, activeRoot, singletonOwned: true });
  atStorageLocation('data', activeRoot, () => {
    app.setPath('userData', activeRoot);
    app.setPath('sessionData', activeRoot);
  });
  await import('../application');
}
