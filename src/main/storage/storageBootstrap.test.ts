import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { USER_DATA_DIRECTORY_NAME } from '../../shared/productMetadata';
import { runStorageBootstrap } from './storageBootstrap';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    setName: vi.fn(),
    getPath: vi.fn(),
    setPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(),
    exit: vi.fn(),
  },
  mkdir: vi.fn(),
  lstat: vi.fn(),
  readLocator: vi.fn(),
  readMetadata: vi.fn(),
  readJournal: vi.fn(),
  readIdentity: vi.fn(),
  recoverInitialBinding: vi.fn(),
  assertCanonical: vi.fn(),
  parseBridge: vi.fn(),
  prepareBrowserAuthenticationTransport: vi.fn(),
  bridgeProfile: vi.fn(),
  setContext: vi.fn(),
  maintenance: vi.fn(),
  application: vi.fn(),
}));
vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('node:fs', () => ({
  default: { mkdirSync: mocks.mkdir, lstatSync: mocks.lstat },
}));
vi.mock('./relocationState', () => ({
  assertCanonicalDirectory: mocks.assertCanonical,
  readStorageLocator: mocks.readLocator,
  readStorageLocatorMetadata: mocks.readMetadata,
  readRelocationJournal: mocks.readJournal,
  readStorageRootIdentity: mocks.readIdentity,
  recoverInitialStorageBinding: mocks.recoverInitialBinding,
  setStorageBootstrapContext: mocks.setContext,
  RelocationStage: { Cancelled: 'cancelled', Activated: 'activated', Committed: 'committed' },
  StorageRelocationFile: {
    Locator: 'storage-location.json',
    InitialBinding: 'storage-location.initializing.json',
    RootIdentity: 'storage-root.json',
    ControlDirectory: 'storage-relocation',
    Journal: 'active.json',
  },
}));
vi.mock('../clients/cli/transport/agentBridgeProtocol', () => ({
  parseAgentBridgeArgv: mocks.parseBridge,
  resolveAgentBridgeProfile: mocks.bridgeProfile,
}));
vi.mock('./storageMaintenance', () => ({ runStorageMaintenance: mocks.maintenance }));
vi.mock('../browser/authentication/browserAuthenticationTransport', () => ({
  prepareBrowserAuthenticationTransport: mocks.prepareBrowserAuthenticationTransport,
}));
vi.mock('../application', () => {
  mocks.application();
  return {};
});

const appData = path.resolve('storage-bootstrap-fixture');
const bootstrap = path.join(appData, USER_DATA_DIRECTORY_NAME);
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('JUSTDO_DEV_USER_DATA_DIR', '');
  vi.resetModules();
  vi.resetAllMocks();
  // Re-register the lazy entry so its side effect is observed independently per boot.
  vi.doMock('../application', () => {
    mocks.application();
    return {};
  });
  mocks.app.isPackaged = true;
  mocks.app.getPath.mockImplementation(name => (name === 'appData' ? appData : process.execPath));
  mocks.app.requestSingleInstanceLock.mockReturnValue(true);
  mocks.readLocator.mockReturnValue(null);
  mocks.readMetadata.mockReturnValue(null);
  mocks.readJournal.mockReturnValue(null);
  mocks.assertCanonical.mockImplementation(directory => directory);
  mocks.lstat.mockReturnValue(undefined);
  mocks.parseBridge.mockReturnValue(null);
  vi.spyOn(process, 'chdir').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test('re-reads migration intent after obtaining the fixed lock and never opens a stale source profile', async () => {
  let locked = false;
  mocks.app.requestSingleInstanceLock.mockImplementation(() => {
    locked = true;
    return true;
  });
  mocks.lstat.mockImplementation(() => {
    if (locked) return {};
    return undefined;
  });
  mocks.readLocator.mockImplementation(() =>
    locked ? { profileId: 'profile', activeRoot: bootstrap, activeRootId: 'source-id' } : null,
  );
  mocks.readIdentity.mockReturnValue({ profileId: 'profile', rootId: 'source-id' });
  mocks.readJournal.mockImplementation(() => (locked ? { stage: 'requested' } : null));

  await runStorageBootstrap();

  expect(mocks.maintenance).toHaveBeenCalledWith({
    bootstrapRoot: bootstrap,
    initialError: undefined,
    dataPath: bootstrap,
  });
  expect(mocks.application).not.toHaveBeenCalled();
  expect(mocks.prepareBrowserAuthenticationTransport).not.toHaveBeenCalled();
  expect(mocks.app.setPath).toHaveBeenCalledWith(
    'sessionData',
    path.join(bootstrap, 'storage-relocation', 'maintenance-profile'),
  );
  expect(mocks.readJournal).toHaveBeenCalledOnce();
  expect(mocks.readLocator).toHaveBeenCalledOnce();
});

test.each([true, false])('re-reads the active root after a locator commits during lock handoff (packaged=%s)', async isPackaged => {
  mocks.app.isPackaged = isPackaged;
  const target = path.resolve('relocated-storage-fixture');
  let locked = false;
  mocks.app.requestSingleInstanceLock.mockImplementation(() => {
    locked = true;
    return true;
  });
  mocks.lstat.mockImplementation(() => {
    if (locked) return {};
    return undefined;
  });
  mocks.readLocator.mockImplementation(() =>
    locked ? { profileId: 'profile', activeRoot: target, activeRootId: 'target-id' } : null,
  );
  mocks.readIdentity.mockReturnValue({ profileId: 'profile', rootId: 'target-id' });
  mocks.readJournal.mockImplementation(() => (locked ? { stage: 'activated' } : null));

  await runStorageBootstrap();

  expect(mocks.maintenance).not.toHaveBeenCalled();
  expect(mocks.app.setPath).toHaveBeenCalledWith('userData', target);
  expect(mocks.app.setPath).toHaveBeenCalledWith('sessionData', target);
  expect(mocks.prepareBrowserAuthenticationTransport).toHaveBeenCalledBefore(mocks.application);
  expect(mocks.application).toHaveBeenCalledOnce();
});

test('does not open either profile if another process retains the bootstrap lock', async () => {
  mocks.app.requestSingleInstanceLock.mockReturnValue(false);

  await runStorageBootstrap();

  expect(mocks.app.exit).toHaveBeenCalledWith(0);
  expect(mocks.prepareBrowserAuthenticationTransport).not.toHaveBeenCalled();
  expect(mocks.application).not.toHaveBeenCalled();
  expect(mocks.maintenance).not.toHaveBeenCalled();
});

test('blocks bridge entry during migration without loading the normal application', async () => {
  mocks.parseBridge.mockReturnValue(['status']);
  mocks.lstat.mockReturnValue({});
  mocks.readLocator.mockReturnValue({
    profileId: 'profile',
    activeRoot: bootstrap,
    activeRootId: 'source-id',
  });
  mocks.readIdentity.mockReturnValue({ profileId: 'profile', rootId: 'source-id' });
  mocks.readJournal.mockReturnValue({ stage: 'copying' });

  await runStorageBootstrap();

  expect(mocks.app.exit).toHaveBeenCalledWith(69);
  expect(mocks.application).not.toHaveBeenCalled();
  expect(mocks.app.requestSingleInstanceLock).not.toHaveBeenCalled();
});

test('passes the admitted data path to recovery when the migration record cannot be read', async () => {
  const target = path.resolve('relocated-profile-with-unreadable-journal');
  mocks.lstat.mockReturnValue({});
  mocks.readLocator.mockReturnValue({ activeRoot: target });
  mocks.readJournal.mockImplementation(() => { throw new SyntaxError('Invalid journal.'); });

  await runStorageBootstrap();

  expect(mocks.maintenance).toHaveBeenCalledWith({
    bootstrapRoot: bootstrap,
    dataPath: target,
    initialError: expect.objectContaining({ location: 'journal' }),
  });
  expect(mocks.application).not.toHaveBeenCalled();
});

test('the default development entry uses the same unmigrated Windows profile and fixed lock', async () => {
  mocks.app.isPackaged = false;

  await runStorageBootstrap();

  expect(mocks.application).toHaveBeenCalledOnce();
  expect(mocks.readLocator).not.toHaveBeenCalled();
  expect(mocks.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
  expect(mocks.app.setPath).toHaveBeenCalledWith('userData', bootstrap);
  expect(mocks.app.setPath).toHaveBeenCalledWith('sessionData', bootstrap);
});

function relocatedDevelopment(target = path.resolve('relocated-development-fixture')) {
  mocks.app.isPackaged = false;
  mocks.lstat.mockReturnValue({});
  mocks.readLocator.mockReturnValue({ profileId: 'production', activeRoot: target, activeRootId: 'target' });
  mocks.readMetadata.mockReturnValue({ profileId: 'production', activeRoot: target, activeRootId: 'target' });
  mocks.readIdentity.mockImplementation(root => ({ profileId: 'production', rootId: root === target ? 'target' : 'source' }));
  mocks.readJournal.mockReturnValue({ stage: 'activated' });
  return target;
}

test('development opens the relocated profile before loading application', async () => {
  const target = relocatedDevelopment();
  mocks.application.mockImplementation(() => {
    expect(mocks.app.setPath).toHaveBeenCalledWith('userData', target);
    expect(mocks.app.setPath).toHaveBeenCalledWith('sessionData', target);
  });

  await runStorageBootstrap();

  expect(mocks.setContext).toHaveBeenCalledWith({ bootstrapRoot: bootstrap, activeRoot: target, singletonOwned: true });
  expect(mocks.application).toHaveBeenCalledOnce();
  expect(mocks.maintenance).not.toHaveBeenCalled();
});

test('development waits for offline cleanup even when the locator already points to the target', async () => {
  relocatedDevelopment();
  mocks.readJournal.mockReturnValue({ stage: 'source-retired' });

  await runStorageBootstrap();

  expect(mocks.app.exit).toHaveBeenCalledWith(1);
  expect(mocks.application).not.toHaveBeenCalled();
  expect(mocks.maintenance).not.toHaveBeenCalled();
  expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith(bootstrap, { recursive: true });
  expect(process.chdir).not.toHaveBeenCalled();
});

test.each(['corrupt', 'unavailable-target'])('development never opens the retained source when location cannot be admitted (%s)', async reason => {
  const target = relocatedDevelopment();
  if (reason === 'corrupt') mocks.readLocator.mockImplementation(() => { throw new Error('Corrupt locator.'); });
  if (reason === 'missing') mocks.readLocator.mockReturnValue(null);
  if (reason === 'unavailable-target') mocks.readLocator.mockImplementation(() => {
    throw new Error(`Unavailable target: ${target}`);
  });

  await runStorageBootstrap();

  expect(mocks.app.exit).toHaveBeenCalledWith(1);
  expect(mocks.application).not.toHaveBeenCalled();
  expect(mocks.maintenance).not.toHaveBeenCalled();
  expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith(bootstrap, { recursive: true });
});

test.each(['empty', 'owned'])('an explicit independent development profile stays isolated from broken production storage (%s)', async kind => {
  const independent = path.resolve('isolated-development-fixture');
  mocks.app.isPackaged = false;
  vi.stubEnv('JUSTDO_DEV_USER_DATA_DIR', independent);
  mocks.readLocator.mockImplementation(() => { throw new Error('Broken production locator.'); });
  mocks.readMetadata.mockImplementation(() => { throw new Error('Broken production locator metadata.'); });
  if (kind === 'owned') {
    mocks.lstat.mockReturnValue({});
    mocks.readIdentity.mockImplementation(root => ({ profileId: root === independent ? 'independent' : 'production', rootId: 'root' }));
  }

  await runStorageBootstrap();

  expect(mocks.app.setPath).toHaveBeenCalledWith('userData', independent);
  expect(mocks.app.setPath).toHaveBeenCalledWith('sessionData', independent);
  expect(mocks.readLocator).not.toHaveBeenCalled();
  expect(mocks.readJournal).not.toHaveBeenCalled();
  expect(mocks.app.requestSingleInstanceLock).not.toHaveBeenCalled();
  expect(mocks.application).toHaveBeenCalledOnce();
});

test.each(['bootstrap', 'retained-source', 'target'])('an explicit development path in the production profile follows the locator (%s)', async selected => {
  const target = relocatedDevelopment();
  const requested = selected === 'bootstrap' ? bootstrap : selected === 'target' ? target : path.resolve('retained-development-source');
  vi.stubEnv('JUSTDO_DEV_USER_DATA_DIR', requested);

  await runStorageBootstrap();

  expect(mocks.app.setPath).toHaveBeenLastCalledWith('sessionData', target);
  expect(mocks.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
  expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith(bootstrap, { recursive: true });
  expect(mocks.application).toHaveBeenCalledOnce();
});

test('an explicit development path to a missing locator target is never recreated as isolated data', async () => {
  const target = relocatedDevelopment();
  vi.stubEnv('JUSTDO_DEV_USER_DATA_DIR', target);
  mocks.lstat.mockImplementation(filename => {
    if (filename === path.join(target, 'storage-root.json')) return undefined;
    return {};
  });
  mocks.readLocator.mockImplementation(() => { throw new Error('Target unavailable.'); });

  await runStorageBootstrap();

  expect(mocks.app.exit).toHaveBeenCalledWith(1);
  expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith(bootstrap, { recursive: true });
  expect(mocks.application).not.toHaveBeenCalled();
});

test.each(['target', 'retained-source'])('a missing bootstrap marker does not make the production %s an independent development profile', async selected => {
  const target = relocatedDevelopment();
  const requested = selected === 'target' ? target : path.resolve('retained-marker-fixture');
  vi.stubEnv('JUSTDO_DEV_USER_DATA_DIR', requested);
  mocks.lstat.mockImplementation(filename => {
    if (filename === path.join(bootstrap, 'storage-root.json')) return undefined;
    return {};
  });
  mocks.readJournal.mockReturnValue({ stage: 'copying' });

  await runStorageBootstrap();

  expect(mocks.app.exit).toHaveBeenCalledWith(1);
  expect(mocks.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
  expect(mocks.application).not.toHaveBeenCalled();
  expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith(bootstrap, { recursive: true });
});

test('an explicit bridge profile takes precedence over the development environment directory', async () => {
  const bridgeProfile = path.resolve('isolated-bridge-fixture');
  mocks.app.isPackaged = false;
  vi.stubEnv('JUSTDO_DEV_USER_DATA_DIR', path.resolve('unused-development-fixture'));
  mocks.parseBridge.mockReturnValue(['status']);
  mocks.bridgeProfile.mockReturnValue(bridgeProfile);

  await runStorageBootstrap();

  expect(mocks.app.setPath).toHaveBeenCalledWith('userData', bridgeProfile);
  expect(mocks.app.setPath).toHaveBeenCalledWith('sessionData', bridgeProfile);
  expect(mocks.app.requestSingleInstanceLock).not.toHaveBeenCalled();
  expect(mocks.application).toHaveBeenCalledOnce();
});

test('a development bridge without an explicit profile retains its independent development directory', async () => {
  const independent = path.resolve('independent-bridge-environment');
  mocks.app.isPackaged = false;
  vi.stubEnv('JUSTDO_DEV_USER_DATA_DIR', independent);
  mocks.parseBridge.mockReturnValue(['status']);
  mocks.readMetadata.mockImplementation(() => { throw new Error('Broken production metadata.'); });
  mocks.readLocator.mockImplementation(() => { throw new Error('Broken production locator.'); });

  await runStorageBootstrap();

  expect(mocks.app.setPath).toHaveBeenCalledWith('userData', independent);
  expect(mocks.app.setPath).toHaveBeenCalledWith('sessionData', independent);
  expect(mocks.app.requestSingleInstanceLock).not.toHaveBeenCalled();
  expect(mocks.application).toHaveBeenCalledOnce();
  expect(mocks.readLocator).not.toHaveBeenCalled();
});

test.each(['corrupt production locator', 'pending production migration'])(
  'keeps an explicit independent bridge profile isolated from %s',
  async scenario => {
    const independent = path.resolve('independent-profile-fixture');
    mocks.parseBridge.mockReturnValue(['status']);
    mocks.bridgeProfile.mockReturnValue(independent);
    mocks.lstat.mockReturnValue({});
    mocks.readIdentity.mockImplementation(root =>
      root === independent
        ? { profileId: 'independent-profile', rootId: 'independent-root' }
        : { profileId: 'production-profile', rootId: 'production-root' },
    );
    if (scenario === 'corrupt production locator')
      mocks.readLocator.mockImplementation(() => {
        throw new Error('Corrupt production locator.');
      });
    else {
      mocks.readLocator.mockReturnValue({
        profileId: 'production-profile',
        activeRoot: bootstrap,
        activeRootId: 'production-root',
      });
      mocks.readJournal.mockReturnValue({ stage: 'copying' });
    }

    await runStorageBootstrap();

    expect(mocks.app.setPath).toHaveBeenCalledWith('userData', independent);
    expect(mocks.app.setPath).toHaveBeenCalledWith('sessionData', independent);
    expect(mocks.application).toHaveBeenCalledOnce();
    expect(mocks.app.exit).not.toHaveBeenCalled();
    expect(mocks.maintenance).not.toHaveBeenCalled();
    expect(mocks.readLocator).not.toHaveBeenCalled();
    expect(mocks.readJournal).not.toHaveBeenCalled();
    expect(mocks.app.requestSingleInstanceLock).not.toHaveBeenCalled();
  },
);

test('preserves an unmigrated Windows profile without strict parsing or installing a relocation context', async () => {
  mocks.readLocator.mockImplementation(() => {
    throw new Error('Legacy alias would fail strict relocation checks.');
  });
  mocks.readIdentity.mockImplementation(() => {
    throw new Error('Legacy alias would fail strict relocation checks.');
  });

  await runStorageBootstrap();

  expect(mocks.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
  expect(mocks.application).toHaveBeenCalledOnce();
  expect(mocks.readLocator).not.toHaveBeenCalled();
  expect(mocks.readJournal).not.toHaveBeenCalled();
  expect(mocks.readIdentity).not.toHaveBeenCalled();
  expect(mocks.assertCanonical).not.toHaveBeenCalled();
  expect(mocks.setContext).not.toHaveBeenCalled();
  expect(mocks.maintenance).not.toHaveBeenCalled();
});

test('preserves the original packaged non-Windows entry without probing or creating Windows storage controls', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  try {
    await runStorageBootstrap();
    expect(mocks.application).toHaveBeenCalledOnce();
    expect(mocks.lstat).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.app.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(mocks.setContext).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});

test.each(['storage-root.json', 'storage-relocation'])(
  'does not restore an old source if the locator is missing but %s remains',
  async trace => {
    mocks.lstat.mockImplementation(filename => {
      if (filename === path.join(bootstrap, trace)) return {};
      return undefined;
    });
    mocks.readLocator.mockReturnValue(null);

    await runStorageBootstrap();

    expect(mocks.maintenance).toHaveBeenCalledWith({
      bootstrapRoot: bootstrap,
      initialError: expect.any(Error),
      dataPath: undefined,
    });
    expect(mocks.application).not.toHaveBeenCalled();
  },
);

test('an unresolved first binding never creates a relocation directory', async () => {
  mocks.recoverInitialBinding.mockImplementation(() => { throw new Error('Binding changed.'); });

  await expect(runStorageBootstrap()).rejects.toMatchObject({
    location: 'locator', path: path.join(bootstrap, 'storage-location.initializing.json'),
  });

  expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith(bootstrap, { recursive: true });
  expect(mocks.maintenance).not.toHaveBeenCalled();
  expect(mocks.application).not.toHaveBeenCalled();
});

test('an unreadable control probe is an error, never proof of a legacy profile', async () => {
  mocks.lstat.mockImplementation(() => {
    throw Object.assign(new Error('Denied.'), { code: 'EACCES' });
  });

  await expect(runStorageBootstrap()).rejects.toMatchObject({
    location: 'recovery',
    path: path.join(bootstrap, 'storage-relocation'),
    cause: { code: 'EACCES' },
  });

  expect(mocks.application).not.toHaveBeenCalled();
  expect(mocks.maintenance).not.toHaveBeenCalled();
});

test('never creates a maintenance leaf through an invalid control parent', async () => {
  const control = path.join(bootstrap, 'storage-relocation');
  mocks.lstat.mockImplementation(filename => {
    if (filename === control) return {};
    return undefined;
  });
  mocks.assertCanonical.mockImplementation(directory => {
    if (directory === control) throw new Error('Control directory is an alias.');
    return directory;
  });

  await expect(runStorageBootstrap()).rejects.toMatchObject({
    location: 'recovery',
    path: control,
    cause: { message: 'Control directory is an alias.' },
  });

  expect(mocks.mkdir.mock.calls.every(([directory]) => directory === bootstrap)).toBe(true);
  expect(mocks.app.setPath).not.toHaveBeenCalledWith(
    'userData',
    path.join(control, 'maintenance-profile'),
  );
  expect(mocks.application).not.toHaveBeenCalled();
  expect(mocks.maintenance).not.toHaveBeenCalled();
});
