import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AppInitializationActivity } from '../../../shared/app/initialization';
import { StartupRoute, StartupStage } from '../../../shared/app/startup/routing';
import * as versionPolicy from '../../../shared/app/startup/versionPolicy';
import { DB_FILENAME } from '../../core/appConstants';
import { classifyInstallation } from './classifyInstallation';
import { type NativeStartupDatabaseRuntime,StartupCoordinator } from './startupCoordinator';
import {
  newStartupJournal, readStartupJournal, STARTUP_STATE_FILE, type StartupIdentity, writeStartupJson,
} from './startupState';

vi.mock('./classifyInstallation', () => ({ classifyInstallation: vi.fn() }));
const roots: string[] = [];
const identity: StartupIdentity = {
  appVersion: 'v2026.10.20', runtimeVersion: 'v2026.10.6', runtimeBuildId: 'a'.repeat(64),
};
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-upgrade-'));
  roots.push(root);
  vi.mocked(classifyInstallation).mockImplementation((directory, recovery = true) => ({
    route: recovery && readStartupJournal(directory)?.stage !== StartupStage.Complete &&
      readStartupJournal(directory)?.route === StartupRoute.Upgrade ? StartupRoute.Upgrade : StartupRoute.Normal,
    journal: readStartupJournal(directory),
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const native = () => ({
  deliveryIdentity: vi.fn(async () => ({ runtimeVersion: identity.runtimeVersion, runtimeBuildId: identity.runtimeBuildId })),
  identity: vi.fn(async () => ({ runtimeVersion: identity.runtimeVersion, runtimeBuildId: identity.runtimeBuildId })),
  inspect: vi.fn(async () => ({ needsUpgrade: false })),
  upgrade: vi.fn(async (_activity: (value: 'nativeInspect' | 'nativeBackup' | 'nativeUpgrade' | 'nativeVerify') => void) => {}),
  prepareCanonical: vi.fn(async (_activity?: Parameters<NativeStartupDatabaseRuntime['prepareCanonical']>[0]) => {}),
});
const progress = () => ({ advance: vi.fn(), reportActivity: vi.fn(), setHistorySummary: vi.fn() });
function receipt(completedIdentity = identity) {
  fs.writeFileSync(path.join(root, DB_FILENAME), 'opaque existing product database');
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), {
    ...newStartupJournal(StartupRoute.Normal), stage: StartupStage.Complete, completedIdentity,
  });
}

test.each([StartupRoute.Fresh, StartupRoute.Migration])('preserves the actual %s data route instead of using a missing receipt', async route => {
  vi.mocked(classifyInstallation).mockReturnValue({ route, journal: null });
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(coordinator.route).toBe(route);
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(fs.readdirSync(root)).toEqual([]);
});

test.each(['missing receipt', 'different runtime version', 'pending upgrade'])('selects an all-data-preserving upgrade for %s', async reason => {
  if (reason !== 'missing receipt') receipt({ ...identity,
    ...(reason === 'different runtime version' ? { runtimeVersion: 'v2026.9.8' } : {}),
  });
  const owner = native();
  if (reason === 'pending upgrade') writeStartupJson(path.join(root, STARTUP_STATE_FILE), {
    ...newStartupJournal(StartupRoute.Upgrade), completedIdentity: identity, targetIdentity: identity,
  });
  const before = fs.existsSync(path.join(root, STARTUP_STATE_FILE))
    ? fs.readFileSync(path.join(root, STARTUP_STATE_FILE), 'utf8') : null;
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(coordinator.route).toBe(StartupRoute.Upgrade);
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(owner.upgrade).not.toHaveBeenCalled();
  expect(before === null ? !fs.existsSync(path.join(root, STARTUP_STATE_FILE))
    : fs.readFileSync(path.join(root, STARTUP_STATE_FILE), 'utf8') === before).toBe(true);
});

test('opens normal startup without product or native validation when completed runtime metadata matches', async () => {
  receipt();
  const owner = native();
  vi.mocked(classifyInstallation).mockClear();
  vi.mocked(classifyInstallation).mockImplementation(() => { throw new Error('unexpected product validation'); });
  owner.identity.mockRejectedValue(new Error('unexpected runtime admission'));
  owner.inspect.mockRejectedValue(new Error('unexpected native inspection'));
  owner.prepareCanonical.mockRejectedValue(new Error('unexpected canonical preparation'));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(coordinator.route).toBe(StartupRoute.Normal);
  await coordinator.prepareBeforeStore(progress());
  await expect(coordinator.verifyNativeReady()).resolves.toBe(true);
  coordinator.complete();
  expect(classifyInstallation).not.toHaveBeenCalled();
  expect(owner.deliveryIdentity).toHaveBeenCalledOnce();
  expect(owner.identity).not.toHaveBeenCalled();
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(owner.prepareCanonical).not.toHaveBeenCalled();
  expect(owner.upgrade).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, DB_FILENAME), 'utf8')).toBe('opaque existing product database');
});

test.each([StartupRoute.Fresh, StartupRoute.Migration, StartupRoute.Upgrade])('reports session validation separately from schema upgrades on %s startup', async route => {
  if (route === StartupRoute.Fresh || route === StartupRoute.Migration)
    vi.mocked(classifyInstallation).mockReturnValue({ route, journal: null });
  const owner = native();
  owner.prepareCanonical.mockImplementation(async report => {
    for (const activity of [AppInitializationActivity.NativeInspect, AppInitializationActivity.NativeBackup,
      AppInitializationActivity.NativeUpgrade, AppInitializationActivity.NativeVerify] as const)
      report?.(activity);
  });
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(coordinator.route).toBe(route);
  const report = vi.fn();
  await coordinator.verifyNativeReady(report);
  expect(report.mock.calls.flat()).toEqual([AppInitializationActivity.SessionInspect,
    AppInitializationActivity.SessionBackup, AppInitializationActivity.SessionPrepare,
    AppInitializationActivity.SessionVerify]);
  expect(owner.upgrade).not.toHaveBeenCalled();
});

test.each([
  { appVersion: 'v2026.10.19' },
  { runtimeBuildId: 'b'.repeat(64) },
  { appVersion: 'v2026.10.19', runtimeBuildId: 'b'.repeat(64) },
  { appVersion: 'v2026.10.19', runtimeVersion: '2026.10.6', runtimeBuildId: 'b'.repeat(64) },
])('normal startup retains maintenance proof and records only its application opening: %j', async change => {
  const previous = { ...identity, ...change };
  receipt(previous);
  fs.writeFileSync(path.join(root, 'retained-settings'), 'exact user state');
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(coordinator.route).toBe(StartupRoute.Normal);
  expect(coordinator.getDowngradeConfirmation()).toBeUndefined();
  expect(owner.inspect).not.toHaveBeenCalled();
  const observed = progress();
  await coordinator.prepareBeforeStore(observed);
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
  await coordinator.verifyNativeReady();
  expect(readStartupJournal(root)?.completedIdentity).toEqual(previous);
  coordinator.complete();
  expect(readStartupJournal(root)).toMatchObject({ stage: StartupStage.Complete, completedIdentity: previous,
    lastOpenedIdentity: identity });
  expect(readStartupJournal(root)?.targetIdentity).toBeUndefined();
  expect(owner.identity).not.toHaveBeenCalled();
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(owner.prepareCanonical).not.toHaveBeenCalled();
  expect(owner.upgrade).not.toHaveBeenCalled();
  expect(observed.advance).not.toHaveBeenCalled();
  expect(observed.reportActivity).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, 'retained-settings'), 'utf8')).toBe('exact user state');
  expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
  const unchanged = vi.spyOn(fs, 'renameSync');
  coordinator.complete();
  expect(unchanged).not.toHaveBeenCalled();
});

test('ordinary app-only startup leaves pending native schema discovery to Gateway', async () => {
  receipt({ ...identity, appVersion: 'v2026.10.19', runtimeBuildId: 'b'.repeat(64) });
  const owner = native();
  owner.inspect.mockResolvedValue({ needsUpgrade: true });
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(coordinator.route).toBe(StartupRoute.Normal);
  await expect(coordinator.verifyNativeReady()).resolves.toBe(true);
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(owner.upgrade).not.toHaveBeenCalled();
});

test('normal readiness does not dispatch canonical preparation or publish maintenance proof', async () => {
  const previous = { ...identity, appVersion: 'v2026.10.19' };
  receipt(previous);
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const owner = native();
  owner.prepareCanonical.mockImplementation(() => new Promise<void>(() => {}));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await coordinator.prepareBeforeStore(progress());
  expect(coordinator.route).toBe(StartupRoute.Normal);
  expect(owner.prepareCanonical).not.toHaveBeenCalled();
  await expect(coordinator.verifyNativeReady()).resolves.toBe(true);
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
  expect(owner.prepareCanonical).not.toHaveBeenCalled();
  expect(owner.inspect).not.toHaveBeenCalled();
  coordinator.complete();
  expect(readStartupJournal(root)?.completedIdentity).toEqual(previous);
  expect(readStartupJournal(root)?.lastOpenedIdentity).toEqual(identity);
  expect(owner.upgrade).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
});

test('normal startup does not consume stale canonical failures as host admission evidence', async () => {
  receipt({ ...identity, appVersion: 'v2026.10.19' });
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await coordinator.prepareBeforeStore(progress());
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  owner.prepareCanonical.mockRejectedValue(new Error('Native database inventory changed after routing.'));
  await expect(coordinator.verifyNativeReady()).resolves.toBe(true);
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(owner.prepareCanonical).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
});

test('canonical failure keeps the upgrade startup receipt unconfirmed', async () => {
  const owner = native();
  owner.prepareCanonical.mockRejectedValue(new Error('canonical commit failed'));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(coordinator.route).toBe(StartupRoute.Upgrade);
  await coordinator.prepareBeforeStore(progress());
  const before = fs.existsSync(path.join(root, STARTUP_STATE_FILE))
    ? fs.readFileSync(path.join(root, STARTUP_STATE_FILE)) : undefined;
  await expect(coordinator.verifyNativeReady()).rejects.toThrow('canonical commit failed');
  expect(() => coordinator.complete()).toThrow(/startup checks/);
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
  expect(owner.upgrade).not.toHaveBeenCalled();
});

test('closing startup during canonical preparation rejects a late successful result', async () => {
  const owner = native();
  let finish!: () => void;
  owner.prepareCanonical.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await coordinator.prepareBeforeStore(progress());
  const pending = coordinator.verifyNativeReady();
  const rejected = expect(pending).rejects.toThrow(/interrupted/);
  await vi.waitFor(() => expect(owner.prepareCanonical).toHaveBeenCalledOnce());
  coordinator.stop(); finish(); await rejected;
  expect(() => coordinator.complete()).toThrow(/interrupted/);
});

test('fresh canonical failure retains settings access while withholding Gateway admission and completed identity', async () => {
  vi.mocked(classifyInstallation).mockReturnValue({ route: StartupRoute.Fresh, journal: null });
  const owner = native();
  owner.prepareCanonical.mockRejectedValue(new Error('canonical worker failed'));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await coordinator.prepareBeforeStore(progress());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(coordinator.verifyNativeReady()).resolves.toBe(false);
  coordinator.complete();
  expect(readStartupJournal(root)?.completedIdentity).toBeUndefined();
  expect(owner.prepareCanonical).toHaveBeenCalledOnce();
});

test('a pending upgrade of the same native version is resumed even when only the app changed', async () => {
  const pending = { ...newStartupJournal(StartupRoute.Upgrade),
    targetIdentity: identity, completedIdentity: { ...identity, appVersion: 'v2026.10.19' } };
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), pending);
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(coordinator.route).toBe(StartupRoute.Upgrade);
  await coordinator.prepareBeforeStore(progress());
  await coordinator.verifyNativeReady();
  coordinator.complete();
  expect(readStartupJournal(root)?.transactionId).toBe(pending.transactionId);
  expect(readStartupJournal(root)?.completedIdentity).toEqual(identity);
  expect(owner.upgrade).not.toHaveBeenCalled();
});

test('a normal completion write failure preserves the previous delivery and reports the failure', async () => {
  receipt({ ...identity, appVersion: 'v2026.10.19', runtimeBuildId: 'b'.repeat(64) });
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: native() });
  await coordinator.prepareBeforeStore(progress());
  await coordinator.verifyNativeReady();
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('receipt publication failed'); });
  expect(() => coordinator.complete()).toThrow(/receipt publication failed/);
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
});

test('normal completion refreshes the source used by the next app-only downgrade warning', async () => {
  receipt({ ...identity, appVersion: 'v2026.10.19', runtimeBuildId: 'b'.repeat(64) });
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: native() });
  await coordinator.prepareBeforeStore(progress());
  await coordinator.verifyNativeReady();
  coordinator.complete();
  const owner = native();
  const previousApp = await StartupCoordinator.prepare(root, { appVersion: 'v2026.10.19', native: owner });
  expect(previousApp.route).toBe(StartupRoute.Upgrade);
  expect(previousApp.getDowngradeConfirmation()).toMatchObject({
    source: { appVersion: identity.appVersion }, target: { appVersion: 'v2026.10.19' },
  });
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(owner.upgrade).not.toHaveBeenCalled();
  const confirmation = previousApp.getDowngradeConfirmation()!;
  const continuation = previousApp.prepareBeforeStore(progress());
  expect(previousApp.confirmDowngrade(confirmation.requestId)).toBe(true);
  expect(previousApp.confirmDowngrade(confirmation.requestId)).toBe(false);
  await continuation;
  await previousApp.verifyNativeReady();
  previousApp.complete();
  expect(readStartupJournal(root)).toMatchObject({
    completedIdentity: { ...identity, appVersion: 'v2026.10.19' },
    lastOpenedIdentity: { ...identity, appVersion: 'v2026.10.19' },
  });
});

test.each(['pending', 'unreadable'])('normal startup delegates %s native state to Gateway without host preflight', async change => {
  receipt({ ...identity, appVersion: 'v2026.10.19', runtimeBuildId: 'b'.repeat(64) });
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(coordinator.route).toBe(StartupRoute.Normal);
  await coordinator.prepareBeforeStore(progress());
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const failure = new Error(change === 'pending'
    ? 'Native schema must be current before canonical preparation.'
    : 'native snapshot is no longer readable');
  owner.prepareCanonical.mockRejectedValue(failure);
  owner.inspect.mockRejectedValue(failure);
  await expect(coordinator.verifyNativeReady()).resolves.toBe(true);
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(owner.prepareCanonical).not.toHaveBeenCalled();
  expect(owner.upgrade).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
});

test('normal shutdown cannot publish a late application-opening receipt', async () => {
  receipt({ ...identity, appVersion: 'v2026.10.19' });
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: native() });
  coordinator.stop();
  await expect(coordinator.verifyNativeReady()).rejects.toThrow(/interrupted/);
  expect(() => coordinator.complete()).toThrow(/interrupted/);
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
});

test('a completed installation with a missing product pathname cannot recreate an empty database', async () => {
  receipt();
  fs.unlinkSync(path.join(root, DB_FILENAME));
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await expect(coordinator.prepareBeforeStore(progress())).rejects.toThrow(/product database is missing/);
  expect(owner.identity).not.toHaveBeenCalled();
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(root, DB_FILENAME))).toBe(false);
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
});

test('maintenance refuses a different admitted runtime than its lightweight delivery without writing a receipt', async () => {
  fs.writeFileSync(path.join(root, 'retained-settings'), 'unchanged');
  const owner = native();
  owner.identity.mockResolvedValue({ runtimeVersion: identity.runtimeVersion, runtimeBuildId: 'b'.repeat(64) });
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await expect(coordinator.prepareBeforeStore(progress())).rejects.toMatchObject({
    code: versionPolicy.StartupCompatibilityErrorCode.VersionUnconfirmed,
  });
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(owner.upgrade).not.toHaveBeenCalled();
  expect(owner.prepareCanonical).not.toHaveBeenCalled();
  expect(fs.readdirSync(root)).toEqual(['retained-settings']);
});

test('validates the optional application-opening identity without upgrading old receipt records', () => {
  receipt();
  const old = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  expect(readStartupJournal(root)?.lastOpenedIdentity).toBeUndefined();
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(old);
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), {
    ...readStartupJournal(root), lastOpenedIdentity: { ...identity, runtimeBuildId: 'invalid' },
  });
  expect(() => readStartupJournal(root)).toThrow(/Invalid startup recovery record/);
});

test('selects the upgrade route without inspection and preserves files when execution inspection fails', async () => {
  fs.writeFileSync(path.join(root, 'retained-config.json'), '{"keep":true}');
  const owner = native();
  let reject!: (error: Error) => void;
  owner.inspect.mockImplementationOnce(() => new Promise((_resolve, failed) => { reject = failed; }));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner, startedAt: 1000 });
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(coordinator.route).toBe(StartupRoute.Upgrade);
  const preparation = coordinator.prepareBeforeStore(progress());
  await vi.waitFor(() => expect(owner.inspect).toHaveBeenCalledOnce());
  const error = new Error('Native inventory is unreadable');
  const rejected = expect(preparation).rejects.toBe(error);
  reject(error);
  await rejected;
  expect(coordinator.startedAt).toBe(1000);
  expect(() => coordinator.complete()).toThrow(/startup checks/);
  expect(fs.readdirSync(root)).toEqual(['retained-config.json']);
  expect(fs.readFileSync(path.join(root, 'retained-config.json'), 'utf8')).toBe('{"keep":true}');
});

test('preserves every unrelated file during adoption and records completion only after verification', async () => {
  for (const file of ['product.sqlite', 'login.json', 'plugin-state.sqlite', 'permissions.json'])
    fs.writeFileSync(path.join(root, file), 'retained:' + file);
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(() => coordinator.complete()).toThrow(/startup checks/);
  await coordinator.prepareBeforeStore(progress());
  expect(owner.upgrade).not.toHaveBeenCalled();
  expect(readStartupJournal(root)).toMatchObject({ route: StartupRoute.Upgrade, stage: StartupStage.Check, targetIdentity: identity });
  expect(readStartupJournal(root)?.completedIdentity).toBeUndefined();
  await coordinator.verifyNativeReady();
  coordinator.complete();
  expect(readStartupJournal(root)).toMatchObject({ stage: StartupStage.Complete, completedIdentity: identity,
    lastOpenedIdentity: identity });
  expect(readStartupJournal(root)?.targetIdentity).toBeUndefined();
  for (const file of ['product.sqlite', 'login.json', 'plugin-state.sqlite', 'permissions.json'])
    expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe('retained:' + file);
  expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
});

test('an interrupted native mutation retains its journal and reconciles before any new mutation', async () => {
  const owner = native();
  owner.inspect.mockResolvedValue({ needsUpgrade: true });
  owner.upgrade.mockRejectedValueOnce(new Error('Unknown native child outcome'));
  const first = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await expect(first.prepareBeforeStore(progress())).rejects.toThrow('Unknown native child outcome');
  const pending = readStartupJournal(root)!;
  expect(pending.stage).toBe(StartupStage.UpgradePrepare);
  expect(pending.completedIdentity).toBeUndefined();
  const resumedOwner = native(); // Native facts confirm that the first process already committed.
  const resumed = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: resumedOwner });
  await resumed.prepareBeforeStore(progress());
  await resumed.verifyNativeReady();
  resumed.complete();
  expect(resumedOwner.upgrade).not.toHaveBeenCalled();
  expect(readStartupJournal(root)?.transactionId).toBe(pending.transactionId);
  expect(readStartupJournal(root)?.completedIdentity).toEqual(identity);
});

test('a native maintenance verification failure does not publish a completed receipt', async () => {
  const owner = native();
  owner.inspect.mockResolvedValue({ needsUpgrade: true });
  owner.upgrade.mockRejectedValueOnce(new Error('Native database upgrade was not verified.'));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await expect(coordinator.prepareBeforeStore(progress())).rejects.toThrow(/not verified/);
  expect(owner.upgrade).toHaveBeenCalledOnce();
  expect(readStartupJournal(root)?.stage).toBe(StartupStage.UpgradePrepare);
  expect(() => coordinator.complete()).toThrow(/startup checks/);
});

test('forwards actual native maintenance activity and verifies its result before completion', async () => {
  const owner = native();
  owner.inspect.mockResolvedValueOnce({ needsUpgrade: true });
  owner.upgrade.mockImplementation(async activity => {
    for (const value of ['nativeInspect', 'nativeBackup', 'nativeUpgrade', 'nativeVerify'] as const)
      activity(value);
  });
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  const observed = progress();
  await coordinator.prepareBeforeStore(observed);
  expect(owner.upgrade).toHaveBeenCalledOnce();
  expect(owner.inspect).toHaveBeenCalledOnce();
  expect(observed.reportActivity.mock.calls.map(([value]) => value))
    .toEqual(['nativeInspect', 'nativeInspect', 'nativeBackup', 'nativeUpgrade', 'nativeVerify', 'nativeVerify']);
  expect(readStartupJournal(root)?.completedIdentity).toBeUndefined();
  await coordinator.verifyNativeReady();
  coordinator.complete();
  expect(readStartupJournal(root)?.completedIdentity).toEqual(identity);
});

test('a product generation change across the native await keeps Store admission closed', async () => {
  const owner = native();
  owner.inspect.mockResolvedValue({ needsUpgrade: true });
  owner.upgrade.mockImplementation(async () => {
    vi.mocked(classifyInstallation).mockReturnValue({ route: StartupRoute.Fresh, journal: null });
    owner.inspect.mockResolvedValue({ needsUpgrade: false });
  });
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await expect(coordinator.prepareBeforeStore(progress())).rejects.toThrow(/generation changed/);
  expect(readStartupJournal(root)?.completedIdentity).toBeUndefined();
  expect(() => coordinator.complete()).toThrow(/startup checks/);
});

test('fresh startup may retain settings access without claiming an unverified native identity', async () => {
  vi.mocked(classifyInstallation).mockReturnValue({ route: StartupRoute.Fresh, journal: null });
  const owner = native();
  owner.inspect.mockRejectedValue(new Error('Native readiness unavailable'));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await coordinator.prepareBeforeStore(progress());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await coordinator.verifyNativeReady();
  coordinator.complete();
  expect(readStartupJournal(root)).toMatchObject({ route: StartupRoute.Fresh, stage: StartupStage.Complete });
  expect(readStartupJournal(root)?.completedIdentity).toBeUndefined();
});

test.each([{ appVersion: 'v2026.10.19' }, { runtimeBuildId: 'b'.repeat(64) },
  { runtimeVersion: 'v2026.10.5' }])('resumes an unfinished upgrade by version and current native facts: %j', async change => {
  const journal = {
    ...newStartupJournal(StartupRoute.Upgrade), targetIdentity: { ...identity, ...change },
  };
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), journal);
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const owner = native();
  const needsUpgrade = 'runtimeVersion' in change;
  if (needsUpgrade) owner.inspect.mockResolvedValueOnce({ needsUpgrade: true });
  owner.upgrade.mockImplementation(async () => {
    expect(readStartupJournal(root)).toMatchObject({ stage: StartupStage.UpgradePrepare, targetIdentity: identity });
  });
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
  await coordinator.prepareBeforeStore(progress());
  expect(readStartupJournal(root)).toMatchObject({ stage: StartupStage.Check,
    transactionId: journal.transactionId, targetIdentity: identity });
  expect(owner.upgrade).toHaveBeenCalledTimes(needsUpgrade ? 1 : 0);
  await coordinator.verifyNativeReady();
  coordinator.complete();
  expect(readStartupJournal(root)?.completedIdentity).toEqual(identity);
});

test('a completed phase with an unconfirmed native target resumes maintenance in the same transaction', async () => {
  fs.writeFileSync(path.join(root, DB_FILENAME), 'existing product database');
  const journal = { ...newStartupJournal(StartupRoute.Fresh), stage: StartupStage.Complete,
    targetIdentity: { ...identity, runtimeVersion: 'v2026.10.5' } };
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), journal);
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(coordinator.route).toBe(StartupRoute.Upgrade);
  await coordinator.prepareBeforeStore(progress());
  expect(readStartupJournal(root)).toMatchObject({ route: StartupRoute.Upgrade, stage: StartupStage.Check,
    transactionId: journal.transactionId, targetIdentity: identity });
  await coordinator.verifyNativeReady();
  coordinator.complete();
  expect(readStartupJournal(root)?.targetIdentity).toBeUndefined();
  expect(readStartupJournal(root)?.completedIdentity).toEqual(identity);
});

test('a failed schema readiness publication remains pending and is verified again on restart', async () => {
  const journal = { ...newStartupJournal(StartupRoute.Fresh), targetIdentity: identity, schemaPreparationPending: true };
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), journal);
  vi.mocked(classifyInstallation).mockImplementation(() => ({ route: StartupRoute.Fresh, journal: readStartupJournal(root) }));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: native() });
  const rename = fs.renameSync.bind(fs);
  const failClear = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === path.join(root, STARTUP_STATE_FILE) &&
        JSON.parse(fs.readFileSync(from, 'utf8')).schemaPreparationPending !== true)
      throw new Error('schema readiness publication failed');
    rename(from, to);
  });
  await expect(coordinator.prepareBeforeStore(progress())).rejects.toThrow(/publication failed/);
  expect(readStartupJournal(root)).toMatchObject({ transactionId: journal.transactionId,
    targetIdentity: identity, schemaPreparationPending: true });
  failClear.mockRestore();
  const owner = native();
  const resumed = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await resumed.prepareBeforeStore(progress());
  expect(owner.inspect).toHaveBeenCalledOnce();
  expect(readStartupJournal(root)?.schemaPreparationPending).toBeUndefined();
  expect(owner.prepareCanonical).not.toHaveBeenCalled();
});

test.each([
  { schemaPreparationPending: 'true', targetIdentity: identity },
  { schemaPreparationPending: 1, targetIdentity: identity },
  { schemaPreparationPending: true },
])('rejects malformed schema recovery state before any admission: %j', fields => {
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), { ...newStartupJournal(StartupRoute.Fresh), ...fields });
  expect(() => readStartupJournal(root)).toThrow(/Invalid startup recovery record/);
});

test('a failed durable completion write cannot replace the pending receipt', async () => {
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: native() });
  await coordinator.prepareBeforeStore(progress());
  await coordinator.verifyNativeReady();
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('receipt publication failed'); });
  expect(() => coordinator.complete()).toThrow(/receipt publication failed/);
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
});

test.each([
  { appVersion: 'v2026.10.21' }, { runtimeVersion: 'v2026.10.7' },
  { appVersion: 'v2026.10.19', runtimeVersion: 'v2026.10.7' },
])('requires confirmation for a completed newer delivery before native inspection or any file write: %j', async source => {
    receipt({ ...identity, ...source });
    fs.writeFileSync(path.join(root, 'retained-settings'), 'exact user state');
    const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
    const owner = native();
    const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
    const pending = coordinator.getDowngradeConfirmation()!;
    expect(pending.source).toEqual({ appVersion: source.appVersion ?? identity.appVersion,
      runtimeVersion: source.runtimeVersion ?? identity.runtimeVersion });
    expect(coordinator.route).toBe(StartupRoute.Upgrade);
    let finished = false;
    const continuation = coordinator.prepareBeforeStore(progress()).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(owner.inspect).not.toHaveBeenCalled();
    expect(owner.upgrade).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
    expect(fs.readFileSync(path.join(root, 'retained-settings'), 'utf8')).toBe('exact user state');
    expect(coordinator.confirmDowngrade('not-the-current-request')).toBe(false);
    expect(coordinator.confirmDowngrade(pending.requestId)).toBe(true);
    expect(coordinator.confirmDowngrade(pending.requestId)).toBe(false);
    await continuation;
    expect(finished).toBe(true);
    expect(owner.inspect).toHaveBeenCalled();
    expect(coordinator.route).toBe(StartupRoute.Upgrade);
    expect(coordinator.getDowngradeConfirmation()).toBeUndefined();
});

test('does not discard a newer completed identity when classification selects history migration', async () => {
  receipt({ ...identity, runtimeVersion: 'v2026.10.7' });
  vi.mocked(classifyInstallation).mockReturnValue({ route: StartupRoute.Migration, journal: null });
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(coordinator.getDowngradeConfirmation()).toBeDefined();
  const continuation = coordinator.prepareBeforeStore(progress());
  const rejected = expect(continuation).rejects.toThrow(/confirmation was cancelled/);
  coordinator.stop();
  await rejected;
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(owner.upgrade).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
});

test('human confirmation cannot grant native schema compatibility or publish an upgrade journal', async () => {
  receipt({ ...identity, runtimeVersion: 'v2026.10.7' });
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const owner = native();
  const failure = Object.assign(new Error('native schema is newer than supported'), {
    code: versionPolicy.StartupCompatibilityErrorCode.NativeSchemaUnsupported,
  });
  owner.inspect.mockRejectedValue(failure);
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  const continuation = coordinator.prepareBeforeStore(progress());
  const rejected = expect(continuation).rejects.toBe(failure);
  expect(coordinator.confirmDowngrade(coordinator.getDowngradeConfirmation()!.requestId)).toBe(true);
  await rejected;
  expect(owner.upgrade).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
});

test('shutdown rejects a pending confirmation without any native inspection or writes', async () => {
  receipt({ ...identity, runtimeVersion: 'v2026.10.7' });
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  const pending = coordinator.getDowngradeConfirmation()!;
  const continuation = coordinator.prepareBeforeStore(progress());
  const rejected = expect(continuation).rejects.toThrow(/confirmation was cancelled/);
  coordinator.stop();
  await rejected;
  expect(coordinator.confirmDowngrade(pending.requestId)).toBe(false);
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
});

test('a receipt identity change while the warning is visible invalidates the click', async () => {
  receipt({ ...identity, runtimeVersion: 'v2026.10.7' });
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  const pending = coordinator.getDowngradeConfirmation()!;
  receipt({ ...identity, runtimeVersion: 'v2026.10.8' });
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  expect(coordinator.confirmDowngrade(pending.requestId)).toBe(false);
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
  coordinator.stop();
});

test('changing only the last application-opening identity invalidates an existing downgrade confirmation', async () => {
  receipt();
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), {
    ...readStartupJournal(root), lastOpenedIdentity: { ...identity, appVersion: 'v2026.10.21' },
  });
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  const pending = coordinator.getDowngradeConfirmation()!;
  expect(pending.source.appVersion).toBe('v2026.10.21');
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), {
    ...readStartupJournal(root), lastOpenedIdentity: { ...identity, appVersion: 'v2026.10.22' },
  });
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  expect(coordinator.confirmDowngrade(pending.requestId)).toBe(false);
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
  coordinator.stop();
});

test('an interrupted downgrade retains the last opening as its next-process warning source', async () => {
  const maintained = { ...identity, appVersion: 'v2026.10.19' };
  const lastOpened = { ...identity, appVersion: 'v2026.10.21' };
  receipt(maintained);
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), {
    ...readStartupJournal(root), lastOpenedIdentity: lastOpened,
  });
  const first = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: native() });
  const warning = first.getDowngradeConfirmation()!;
  const continuing = first.prepareBeforeStore(progress());
  expect(first.confirmDowngrade(warning.requestId)).toBe(true);
  await continuing;
  first.stop();
  expect(readStartupJournal(root)).toMatchObject({
    completedIdentity: maintained, lastOpenedIdentity: lastOpened, targetIdentity: identity,
  });
  const resumedOwner = native();
  const resumed = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: resumedOwner });
  expect(resumed.getDowngradeConfirmation()).toMatchObject({ source: { appVersion: lastOpened.appVersion },
    target: { appVersion: identity.appVersion } });
  expect(resumedOwner.inspect).not.toHaveBeenCalled();
  resumed.stop();
});

test.each(['appVersion', 'runtimeVersion'] as const)('blocks an uncomparable %s before profile admission', async field => {
  receipt({ ...identity, [field]: '2026.10.6-preview' });
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await expect(coordinator.prepareBeforeStore(progress())).rejects.toMatchObject({
    code: versionPolicy.StartupCompatibilityErrorCode.VersionUnconfirmed,
  });
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(owner.upgrade).not.toHaveBeenCalled();
});

test.each([StartupRoute.Fresh, StartupRoute.Migration])('rejects a foreign pending %s target before profile writes', async route => {
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), {
    ...newStartupJournal(route), targetIdentity: { ...identity, runtimeVersion: 'v2026.10.7' },
  });
  vi.mocked(classifyInstallation).mockReturnValue({ route, journal: readStartupJournal(root) });
  fs.writeFileSync(path.join(root, 'preserved-file'), 'unchanged');
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const owner = native();
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  await expect(coordinator.prepareBeforeStore(progress())).rejects.toMatchObject({
    code: versionPolicy.StartupCompatibilityErrorCode.VersionUnconfirmed,
  });
  expect(owner.inspect).not.toHaveBeenCalled();
  expect(owner.upgrade).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
  expect(fs.readFileSync(path.join(root, 'preserved-file'), 'utf8')).toBe('unchanged');
  expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
});

test('records the fresh target before initialization and rejects another delivery on resume', async () => {
  vi.mocked(classifyInstallation).mockImplementation(() => ({ route: StartupRoute.Fresh, journal: readStartupJournal(root) }));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: native() });
  await coordinator.prepareBeforeStore(progress());
  expect(readStartupJournal(root)?.targetIdentity).toEqual(identity);
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const resumed = await StartupCoordinator.prepare(root, { appVersion: 'v2026.10.19', native: native() });
  await expect(resumed.prepareBeforeStore(progress())).rejects.toMatchObject({
    code: versionPolicy.StartupCompatibilityErrorCode.VersionUnconfirmed,
  });
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
});

test.each([false, true])('a future exact declaration only continues after actual native inspection: rejected=%s', async rejected => {
  const previous = { ...identity, runtimeVersion: 'v2026.10.7' };
  receipt(previous);
  const actualAssessment = versionPolicy.assessStartupDelivery;
  vi.spyOn(versionPolicy, 'assessStartupDelivery').mockImplementation(options => actualAssessment({ ...options,
    declaredDowngrades: [{ evidenceId: 'all-persistent-domains-reviewed', source: previous, target: identity }],
  }));
  const owner = native();
  if (rejected) owner.inspect.mockRejectedValue(new Error('native inspection rejected the source'));
  const before = fs.readFileSync(path.join(root, STARTUP_STATE_FILE));
  const coordinator = await StartupCoordinator.prepare(root, { appVersion: identity.appVersion, native: owner });
  expect(owner.inspect).toHaveBeenCalledOnce();
  expect(owner.upgrade).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(root, STARTUP_STATE_FILE))).toEqual(before);
  if (rejected) await expect(coordinator.prepareBeforeStore(progress())).rejects.toThrow(/inspection rejected/);
  else {
    expect(coordinator.route).toBe(StartupRoute.Upgrade);
    await coordinator.prepareBeforeStore(progress());
    expect(readStartupJournal(root)?.completedIdentity).toEqual(previous);
    await coordinator.verifyNativeReady();
    coordinator.complete();
    expect(readStartupJournal(root)?.completedIdentity).toEqual(identity);
  }
});
