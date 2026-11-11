import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, test, vi } from 'vitest';

import { StorageMaintenancePhase } from '../../shared/storage/storageRelocation';
import { NativeDatabaseUpgradeRuntime } from '../startup/upgrade/nativeDatabaseUpgradeRuntime';
import { readRelocationCleanupReceipt } from './relocationCleanupReceipt';
import type { NativeRelocationSource } from './relocationNativeRuntime';
import {
  readRelocationJournal,
  readStorageLocator,
  type RelocationJournal,
  RelocationStage,
  removeRelocationJournal,
  StorageRelocationFile,
  writeRelocationJournal,
  writeStorageLocator,
  writeStorageRootIdentity,
} from './relocationState';
import { executeStorageRelocation, prepareRelocationNativeTarget } from './relocationTransaction';

vi.mock('../openclaw/config/models/providerSecretFile', () => ({
  restrictCredentialDirectory: vi.fn(),
  restrictCredentialFile: vi.fn(),
}));
const fixtures: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function file(root: string, relative: string, bytes: string): string {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  return filename;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-transaction-'));
  fixtures.push(root);
  const bootstrapRoot = path.join(root, 'bootstrap');
  const targetRoot = path.join(root, 'target');
  const runtimeRoot = path.join(root, 'immutable-runtime');
  const profileId = randomUUID();
  const sourceRootId = randomUUID();
  const targetRootId = randomUUID();
  fs.mkdirSync(path.join(bootstrapRoot, StorageRelocationFile.ControlDirectory), {
    recursive: true,
  });
  fs.mkdirSync(targetRoot);
  writeStorageRootIdentity(bootstrapRoot, { version: 1, profileId, rootId: sourceRootId });
  writeStorageRootIdentity(targetRoot, { version: 1, profileId, rootId: targetRootId });
  writeStorageLocator(
    bootstrapRoot,
    { version: 1, profileId, revision: 1, activeRoot: bootstrapRoot, activeRootId: sourceRootId },
    null,
  );
  const transactionId = randomUUID();
  const journal: RelocationJournal = {
    version: 1,
    transactionId,
    profileId,
    sourceRoot: bootstrapRoot,
    targetRoot,
    sourceRootId,
    targetRootId,
    sourceRevision: 1,
    stage: RelocationStage.SourceRetired,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cleanShutdown: {
      pid: 12345,
      transactionId,
      completedAt: Date.now(),
      processes: [{ pid: 12345, creationTime: 1_700_000_000_000 }],
    },
  };
  writeRelocationJournal(bootstrapRoot, journal);
  const nativeRelative = path.join('openclaw', 'state', 'state', 'openclaw.sqlite');
  const nativeFile = file(bootstrapRoot, nativeRelative, 'live native bytes with custody rows');
  file(bootstrapRoot, `${nativeRelative}-wal`, 'native heartbeat WAL');
  const document = file(bootstrapRoot, 'documents/project.txt', 'retained project fixture');
  file(bootstrapRoot, 'openclaw/state/openclaw.json', '{}');
  let retired = false;
  let abortJoins = true;
  const assertHeld = vi.fn(async () => {});
  const release = vi.fn(async () => {
    expect(readStorageLocator(bootstrapRoot)?.activeRoot).toBe(targetRoot);
    retired = true;
  });
  const abort = vi.fn(async () => {
    if (abortJoins) retired = true;
    throw new Error('Native custody aborted.');
  });
  const createSource = vi.fn(
    (settings: ConstructorParameters<typeof NativeRelocationSource>[0]) =>
      ({
        acquire: vi.fn(async () => {
          const snapshot = file(
            settings.snapshotDir,
            'fresh.sqlite',
            'fresh native sanitized snapshot',
          );
          return {
            replaceFiles: { [nativeRelative]: snapshot },
            excludeRelativePaths: [`${nativeRelative}-wal`],
          };
        }),
        assertHeld,
        release,
        abort,
        get retirementConfirmed() {
          return retired;
        },
      }) as unknown as NativeRelocationSource,
  );
  const prepareTarget = vi.fn(async () => {
    expect(readStorageLocator(bootstrapRoot)?.activeRoot).toBe(bootstrapRoot);
    expect(fs.readFileSync(path.join(targetRoot, nativeRelative), 'utf8')).toBe(
      'fresh native sanitized snapshot',
    );
    expect(fs.existsSync(path.join(targetRoot, `${nativeRelative}-wal`))).toBe(false);
  });
  const controller = new AbortController();
  const options = {
    bootstrapRoot,
    runtimeRoot,
    signal: controller.signal,
    getProtectedPaths: vi.fn((): { directories: string[]; files: string[] } => ({ directories: [], files: [] })),
    createSource,
    prepareTarget,
  };
  return {
    root,
    bootstrapRoot,
    targetRoot,
    runtimeRoot,
    journal,
    nativeFile,
    nativeRelative,
    document,
    createSource,
    assertHeld,
    release,
    abort,
    prepareTarget,
    controller,
    options,
    setAbortJoins: (value: boolean) => {
      abortJoins = value;
    },
  };
}

test('refuses an already-cancelled target preparation before any native inspection or source acquisition', async () => {
  const f = fixture();
  const inspect = vi.spyOn(NativeDatabaseUpgradeRuntime.prototype, 'inspect');
  const prepareCanonical = vi.spyOn(NativeDatabaseUpgradeRuntime.prototype, 'prepareCanonical');
  const cancellation = new Error('Already cancelled.');
  f.controller.abort(cancellation);

  await expect(prepareRelocationNativeTarget(f.runtimeRoot, f.targetRoot, f.controller.signal)).rejects.toBe(cancellation);
  await expect(executeStorageRelocation(f.options)).rejects.toBe(cancellation);

  expect(inspect).not.toHaveBeenCalled();
  expect(prepareCanonical).not.toHaveBeenCalled();
  expect(f.createSource).not.toHaveBeenCalled();
  expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
});

test('joins the single target preparation worker before reporting cancellation', async () => {
  const f = fixture();
  let finishPreparation!: () => void;
  let finishRetirement!: () => void;
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
  const retirement = new Promise<void>(resolve => { finishRetirement = resolve; });
  const inspect = vi.spyOn(NativeDatabaseUpgradeRuntime.prototype, 'inspect');
  const prepareCanonical = vi.spyOn(NativeDatabaseUpgradeRuntime.prototype, 'prepareCanonical').mockReturnValue(preparation);
  const stop = vi.spyOn(NativeDatabaseUpgradeRuntime.prototype, 'stop').mockReturnValue(retirement);
  const cancellation = new Error('Cancelled during target preparation.');
  const operation = prepareRelocationNativeTarget(f.runtimeRoot, f.targetRoot, f.controller.signal);
  let settled = false;
  void operation.catch(() => { settled = true; });
  const rejected = expect(operation).rejects.toBe(cancellation);

  f.controller.abort(cancellation);
  finishPreparation();
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
  expect(settled).toBe(false);
  expect(inspect).not.toHaveBeenCalled();
  expect(prepareCanonical).toHaveBeenCalledOnce();
  finishRetirement();

  await rejected;
  expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
});

test('leaves generated plugin skill junctions for native republication without traversing their targets', async () => {
  const f = fixture();
  const bundledSkill = path.dirname(file(f.runtimeRoot, 'skills/bundled/SKILL.md', 'bundled skill fixture'));
  const installedRelative = 'openclaw/state/extensions/example/skills/installed/SKILL.md';
  const installedSkill = path.dirname(file(f.bootstrapRoot, installedRelative, 'installed skill fixture'));
  const links = path.join(f.bootstrapRoot, 'openclaw/state/plugin-skills');
  fs.mkdirSync(links);
  const destinations = [bundledSkill, installedSkill, path.join(f.root, 'missing-skill')];
  for (const [index, destination] of destinations.entries())
    fs.symlinkSync(destination, path.join(links, String(index)), process.platform === 'win32' ? 'junction' : 'dir');
  file(links, 'unexpected/notes.txt', 'ordinary data in generated directory');
  file(f.bootstrapRoot, 'documents/plugin-skills/notes.txt', 'unrelated user data');

  await executeStorageRelocation(f.options);

  expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.targetRoot);
  expect(fs.existsSync(path.join(f.targetRoot, 'openclaw/state/plugin-skills'))).toBe(false);
  const preserved = path.join(f.targetRoot, 'openclaw/retained-plugin-skills', f.journal.transactionId);
  expect(fs.readdirSync(preserved)).toEqual(['unexpected']);
  expect(fs.readFileSync(path.join(preserved, 'unexpected/notes.txt'), 'utf8'))
    .toBe('ordinary data in generated directory');
  expect(fs.readFileSync(path.join(f.targetRoot, installedRelative), 'utf8')).toBe('installed skill fixture');
  expect(fs.readFileSync(path.join(f.targetRoot, 'documents/plugin-skills/notes.txt'), 'utf8')).toBe('unrelated user data');
  expect(fs.existsSync(links)).toBe(false);
  expect(fs.readFileSync(path.join(bundledSkill, 'SKILL.md'), 'utf8')).toBe('bundled skill fixture');
});

test('still rejects links in actual user skill storage before activating the target', async () => {
  const f = fixture();
  const outside = path.dirname(file(f.root, 'outside/SKILL.md', 'outside skill fixture'));
  const skills = path.join(f.bootstrapRoot, 'openclaw/state/skills');
  fs.mkdirSync(skills);
  fs.symlinkSync(outside, path.join(skills, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

  await expect(executeStorageRelocation(f.options)).rejects.toThrow();

  expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
  expect(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8')).toBe('outside skill fixture');
});

test('refuses a linked native state root before acquiring a native maintenance lock', async () => {
  const f = fixture();
  const state = path.join(f.bootstrapRoot, 'openclaw', 'state');
  const outside = path.join(f.root, 'outside-state');
  fs.renameSync(state, outside);
  fs.symlinkSync(outside, state, process.platform === 'win32' ? 'junction' : 'dir');

  await expect(executeStorageRelocation(f.options)).rejects.toThrow();

  expect(f.createSource).not.toHaveBeenCalled();
  expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
});

test('refuses a replacement target folder before copying into it', async () => {
  const f = fixture();
  const replaceTarget = () => {
    fs.renameSync(f.targetRoot, path.join(f.root, 'original-target'));
    fs.mkdirSync(f.targetRoot);
    writeStorageRootIdentity(f.targetRoot, {
      version: 1, profileId: f.journal.profileId, rootId: randomUUID(),
    });
  };

  await expect(executeStorageRelocation({ ...f.options, onTemporaryDirectory: replaceTarget }))
    .rejects.toThrow('Target ownership changed.');

  expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
  expect(f.prepareTarget).not.toHaveBeenCalled();
});

test('keeps the source authoritative when its configuration cannot be serialized without losing values', async () => {
  const f = fixture();
  const input = '{ custom: Infinity }';
  const config = file(f.bootstrapRoot, 'openclaw/state/openclaw.json', input);

  await expect(executeStorageRelocation(f.options)).rejects.toThrow('cannot be preserved as JSON');

  expect(f.prepareTarget).not.toHaveBeenCalled();
  expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
  expect(fs.readFileSync(config, 'utf8')).toBe(input);
});

test('copies opaque host records and cold plugin SQLite without interpreting or changing source data', async () => {
  const f = fixture();
  const fixtureDatabase = path.join(f.root, 'fixture.sqlite');
  const writer = new DatabaseSync(fixtureDatabase);
  let family: Array<[string, Buffer]>;
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES('committed in WAL')");
    family = ['', '-wal', '-shm'].map(suffix => [suffix, fs.readFileSync(`${fixtureDatabase}${suffix}`)]);
  } finally { writer.close(); }
  const relative = 'openclaw/state/plugin-data/opaque/data.sqlite';
  for (const [suffix, bytes] of family) {
    const filename = path.join(f.bootstrapRoot, `${relative}${suffix}`);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  }
  const opaque = {
    'openclaw/state/plugin-data/.host/unknown.json': '{unmanaged host bytes',
    'openclaw/state/plugin-data/another/opaque.sqlite-journal': 'opaque journal bytes',
    'local-speech-models/model-a/model.onnx': 'opaque model weights',
  };
  for (const [name, bytes] of Object.entries(opaque)) file(f.bootstrapRoot, name, bytes);

  await executeStorageRelocation(f.options);

  for (const [suffix, bytes] of family) {
    expect(fs.readFileSync(path.join(f.targetRoot, `${relative}${suffix}`))).toEqual(bytes);
  }
  for (const [name, bytes] of Object.entries(opaque)) {
    expect(fs.readFileSync(path.join(f.targetRoot, name), 'utf8')).toBe(bytes);
  }
  const reader = new DatabaseSync(path.join(f.targetRoot, relative), { readOnly: true });
  try { expect(reader.prepare('SELECT value FROM sample').get()).toEqual({ value: 'committed in WAL' }); }
  finally { reader.close(); }
});

test.each(['cleanShutdown', 'forcedShutdown'] as const)(
  'commits only after native target preparation with %s', async shutdown => {
    const f = fixture();
    const config = path.join('openclaw', 'state', 'openclaw.json');
    fs.linkSync(path.join(f.bootstrapRoot, config), path.join(f.root, 'linked-config.json'));
    if (shutdown === 'forcedShutdown') writeRelocationJournal(f.bootstrapRoot, {
      ...f.journal, cleanShutdown: undefined, forcedShutdown: f.journal.cleanShutdown,
    });
    await executeStorageRelocation(f.options);
    expect(readStorageLocator(f.bootstrapRoot)).toMatchObject({
      activeRoot: f.targetRoot,
      revision: 2,
    });
    expect(readRelocationJournal(f.bootstrapRoot)?.stage).toBe(RelocationStage.Activated);
    expect(fs.statSync(path.join(f.targetRoot, config)).nlink).toBe(1);
    expect(fs.existsSync(f.nativeFile)).toBe(false);
    expect(fs.readFileSync(f.document, 'utf8')).toBe('retained project fixture');
    expect(fs.readFileSync(path.join(f.targetRoot, 'documents/project.txt'), 'utf8')).toBe(
      'retained project fixture',
    );
    expect(f.prepareTarget).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.abort).not.toHaveBeenCalled();
    const snapshots = f.createSource.mock.calls[0][0].snapshotDir;
    expect(path.dirname(snapshots)).toBe(path.dirname(f.targetRoot));
    expect(fs.existsSync(snapshots)).toBe(false);
});

test('removes verified copies before marking the offline migration complete', async () => {
  const f = fixture();
  const cache = file(f.bootstrapRoot, 'Cache/cache-fixture', 'regenerable cache bytes');
  const partitionCache = 'Partitions/justdo-browser/Cache/cache-fixture';
  file(f.bootstrapRoot, partitionCache, 'partition cache bytes');
  const compileCachePath = 'openclaw/state/.compile-cache/runtime-cache';
  file(f.bootstrapRoot, compileCachePath, 'compiled bytes');
  const skipped = [
    'outbound-header-proxy/custom/subdirectory/policy-data',
    'chrome-extension/old-registration',
    'external-agent/old-endpoint',
  ];
  for (const relative of skipped) file(f.bootstrapRoot, relative, 'old local configuration');
  const connection = 'app-server/connection.json';
  file(f.bootstrapRoot, connection, 'persistent connection settings');
  const protectedProject = file(f.bootstrapRoot, 'local-speech-models/project/output.md', 'project output');
  const downloaded = file(f.bootstrapRoot, 'logs/report.pdf', 'saved download');
  f.options.getProtectedPaths.mockReturnValue({ directories: [], files: [downloaded] });
  const media = 'openclaw/state/media/outgoing/originals/image.png';
  file(f.bootstrapRoot, media, 'attachment bytes');
  const outside = file(f.root, 'outside-skill/SKILL.md', 'external skill');
  const skills = path.join(f.bootstrapRoot, 'openclaw/state/plugin-skills');
  fs.mkdirSync(skills);
  fs.symlinkSync(path.dirname(outside), path.join(skills, 'example'), process.platform === 'win32' ? 'junction' : 'dir');
  file(f.bootstrapRoot, 'openclaw/state/openclaw.json', JSON.stringify({
    agents: { defaults: { cwd: path.dirname(protectedProject) } },
  }));
  const wal = `${f.nativeFile}-wal`;
  f.assertHeld.mockImplementationOnce(async () => {
    expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
    expect(readRelocationJournal(f.bootstrapRoot)?.stage).toBe(RelocationStage.SourceRetired);
    expect(readRelocationCleanupReceipt(f.journal, 'openclaw')?.entries).toEqual(
      [expect.objectContaining({ relativePath: 'openclaw', kind: 'directory' })],
    );
    const copied = readRelocationCleanupReceipt(f.journal, 'copied');
    const paths = copied?.entries.map(entry => entry.relativePath);
    expect(paths).toContain('Cache/cache-fixture');
    expect(paths).not.toContain('local-speech-models/project/output.md');
    expect(paths).not.toContain('openclaw/state/media/outgoing/originals/image.png');
  });
  const originalRelease = f.release.getMockImplementation()!;
  f.release.mockImplementationOnce(async () => {
    expect(fs.existsSync(cache)).toBe(true);
    expect(fs.existsSync(f.nativeFile)).toBe(true);
    fs.appendFileSync(wal, ' later bytes');
    await originalRelease();
  });

  const onPhase = vi.fn((phase: StorageMaintenancePhase) => {
    if (phase === StorageMaintenancePhase.SwitchingLocation)
      expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
  });
  await executeStorageRelocation({ ...f.options, onPhase });

  expect(onPhase.mock.calls.flat()).toEqual([
    StorageMaintenancePhase.PreparingData,
    StorageMaintenancePhase.CopyingData,
    StorageMaintenancePhase.PreparingDestination,
    StorageMaintenancePhase.SwitchingLocation,
  ]);
  for (const relative of skipped)
    expect(fs.existsSync(path.join(f.targetRoot, relative))).toBe(false);
  expect(fs.existsSync(path.join(f.targetRoot, 'Cache'))).toBe(false);
  expect(fs.readFileSync(path.join(f.targetRoot, partitionCache), 'utf8')).toBe('partition cache bytes');
  expect(fs.readFileSync(path.join(f.targetRoot, connection), 'utf8')).toBe('persistent connection settings');
  expect(fs.readFileSync(path.join(f.targetRoot, compileCachePath), 'utf8')).toBe('compiled bytes');
  expect(readRelocationJournal(f.bootstrapRoot)?.stage).toBe(RelocationStage.Activated);
  expect(f.options.getProtectedPaths).toHaveBeenCalledExactlyOnceWith(f.targetRoot);
  expect(fs.existsSync(cache)).toBe(false);
  expect(fs.existsSync(path.join(f.bootstrapRoot, 'openclaw'))).toBe(false);
  expect(fs.existsSync(protectedProject)).toBe(true);
  expect(fs.readFileSync(downloaded, 'utf8')).toBe('saved download');
  expect(fs.readFileSync(outside, 'utf8')).toBe('external skill');
  expect(fs.readFileSync(path.join(f.targetRoot, media), 'utf8')).toBe('attachment bytes');
  expect(fs.readFileSync(path.join(f.targetRoot, f.nativeRelative), 'utf8')).toBe(
    'fresh native sanitized snapshot',
  );
});

test('retries a locked old directory without copying again or changing the target revision', async () => {
  const f = fixture();
  const oldOpenClaw = path.join(f.bootstrapRoot, 'openclaw');
  const retired = path.join(f.bootstrapRoot, `.storage-retired-${f.journal.transactionId}`);
  const failure = Object.assign(new Error('Old directory is busy.'), { code: 'EBUSY', path: retired });
  const remove = fsp.rm;
  const blocked = vi.spyOn(fsp, 'rm').mockImplementation((file, options) =>
    file === retired ? Promise.reject(failure) : remove(file, options));
  await expect(executeStorageRelocation(f.options)).rejects.toBe(failure);
  expect(readRelocationJournal(f.bootstrapRoot)?.stage).toBe(RelocationStage.SourceRetired);
  expect(fs.existsSync(oldOpenClaw)).toBe(false);
  expect(fs.existsSync(retired)).toBe(true);
  blocked.mockRestore();
  const prepareTarget = vi.fn(async () => {});
  await executeStorageRelocation({ ...f.options, prepareTarget });
  expect(readStorageLocator(f.bootstrapRoot)).toMatchObject({
    activeRoot: f.targetRoot,
    revision: 2,
  });
  expect(readRelocationJournal(f.bootstrapRoot)?.stage).toBe(RelocationStage.Activated);
  expect(fs.existsSync(oldOpenClaw)).toBe(false);
  expect(fs.existsSync(retired)).toBe(false);
  expect(f.createSource).toHaveBeenCalledOnce();
  expect(prepareTarget).not.toHaveBeenCalled();
});

test('keeps the committed target authoritative when source release fails after the locator replacement', async () => {
  const f = fixture();
  f.release.mockRejectedValueOnce(new Error('Source release failed after commit.'));
  await expect(executeStorageRelocation(f.options)).rejects.toThrow(
    'Source release failed after commit.',
  );
  expect(readStorageLocator(f.bootstrapRoot)).toMatchObject({
    activeRoot: f.targetRoot,
    revision: 2,
  });
  expect(readRelocationJournal(f.bootstrapRoot)?.stage).toBe(RelocationStage.SourceRetired);
  expect(f.abort).toHaveBeenCalledOnce();
  expect(fs.existsSync(path.join(f.bootstrapRoot, 'openclaw'))).toBe(true);
  await executeStorageRelocation(f.options);
  expect(readRelocationJournal(f.bootstrapRoot)?.stage).toBe(RelocationStage.Activated);
  expect(readStorageLocator(f.bootstrapRoot)).toMatchObject({
    activeRoot: f.targetRoot,
    revision: 2,
  });
  expect(f.createSource).toHaveBeenCalledOnce();
  expect(fs.existsSync(path.join(f.bootstrapRoot, 'openclaw'))).toBe(false);
});

test('keeps the source authoritative when target preparation fails', async () => {
  const f = fixture();
  f.prepareTarget.mockRejectedValueOnce(new Error('Target canonical validation failed.'));
  await expect(executeStorageRelocation(f.options)).rejects.toThrow(
    'Target canonical validation failed.',
  );
  expect(readStorageLocator(f.bootstrapRoot)).toMatchObject({
    activeRoot: f.bootstrapRoot,
    revision: 1,
  });
  expect(readRelocationJournal(f.bootstrapRoot)).toEqual(f.journal);
  expect(f.abort).toHaveBeenCalledOnce();
  expect(f.release).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.document, 'utf8')).toBe('retained project fixture');
  const snapshots = f.createSource.mock.calls[0][0].snapshotDir;
  expect(fs.readFileSync(path.join(snapshots, 'fresh.sqlite'), 'utf8')).toBe(
    'fresh native sanitized snapshot',
  );
});

test('does not activate a prepared target if source custody health fails before commit', async () => {
  const f = fixture();
  f.assertHeld.mockRejectedValueOnce(new Error('Native source ownership was lost.'));
  await expect(executeStorageRelocation(f.options)).rejects.toThrow(
    'Native source ownership was lost.',
  );
  expect(f.prepareTarget).toHaveBeenCalledOnce();
  expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
  expect(f.release).not.toHaveBeenCalled();
});

test('cancels before the locator commit and joins source custody', async () => {
  const f = fixture();
  f.assertHeld.mockImplementationOnce(async () => { f.controller.abort(); });
  await expect(executeStorageRelocation(f.options)).rejects.toThrow();
  expect(readStorageLocator(f.bootstrapRoot)).toMatchObject({
    activeRoot: f.bootstrapRoot,
    revision: 1,
  });
  expect(readRelocationJournal(f.bootstrapRoot)).toEqual(f.journal);
  expect(f.abort).toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
});

test('propagates unconfirmed target retirement without declaring a source switch', async () => {
  const f = fixture();
  f.prepareTarget.mockRejectedValueOnce(
    Object.assign(new Error('Target is not retired.'), { code: 'retirement-unconfirmed' }),
  );
  await expect(executeStorageRelocation(f.options)).rejects.toMatchObject({
    code: 'retirement-unconfirmed',
  });
  expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
  expect(f.abort).toHaveBeenCalledOnce();
});

test('preserves the retirement fence when abort fails to join the source instead of treating failure as safe cancellation', async () => {
  const f = fixture();
  f.setAbortJoins(false);
  f.prepareTarget.mockRejectedValueOnce(new Error('Target failed.'));
  await expect(executeStorageRelocation(f.options)).rejects.toMatchObject({
    code: 'retirement-unconfirmed',
  });
  expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
  expect(f.release).not.toHaveBeenCalled();
});

test('leaves the original location active after a failed copy and copies afresh to a new target', async () => {
  const f = fixture();
  const original = file(f.bootstrapRoot, 'first.txt', 'first attempt');
  const open = fsp.open;
  const failure = Object.assign(new Error('Disk full.'), { code: 'ENOSPC' });
  const diskFull = vi.spyOn(fsp, 'open').mockImplementation(async (filename, flags, mode) => {
    if (filename === path.join(f.targetRoot, 'openclaw/state/openclaw.json') && flags === 'wx')
      throw failure;
    return open(filename, flags, mode);
  });

  await expect(executeStorageRelocation(f.options)).rejects.toBe(failure);
  diskFull.mockRestore();

  const partial = path.join(f.targetRoot, 'first.txt');
  expect(fs.readFileSync(partial, 'utf8')).toBe('first attempt');
  expect(readStorageLocator(f.bootstrapRoot)?.activeRoot).toBe(f.bootstrapRoot);
  expect(readRelocationJournal(f.bootstrapRoot)).toEqual(f.journal);
  await expect(executeStorageRelocation(f.options)).rejects.toMatchObject({ code: 'target-not-empty' });
  expect(f.createSource).toHaveBeenCalledOnce();

  removeRelocationJournal(f.bootstrapRoot, f.journal.transactionId);
  const targetRoot = path.join(f.root, 'new-target');
  const targetRootId = randomUUID();
  const transactionId = randomUUID();
  fs.mkdirSync(targetRoot);
  writeStorageRootIdentity(targetRoot, { version: 1, profileId: f.journal.profileId, rootId: targetRootId });
  writeRelocationJournal(f.bootstrapRoot, {
    ...f.journal, targetRoot, targetRootId, transactionId,
    cleanShutdown: { ...f.journal.cleanShutdown!, transactionId },
  });
  fs.writeFileSync(original, 'second attempt');
  f.release.mockResolvedValueOnce(undefined);
  f.prepareTarget.mockResolvedValueOnce(undefined);

  await executeStorageRelocation(f.options);

  expect(readStorageLocator(f.bootstrapRoot)).toMatchObject({ activeRoot: targetRoot, revision: 2 });
  expect(fs.readFileSync(path.join(targetRoot, 'first.txt'), 'utf8')).toBe('second attempt');
  expect(fs.readFileSync(partial, 'utf8')).toBe('first attempt');
});
