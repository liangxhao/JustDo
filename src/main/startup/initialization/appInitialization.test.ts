import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import {
  AppInitializationActivity,
  AppInitializationPhase,
  AppInitializationStep,
} from '../../../shared/app/initialization';
import { StartupRoute, StartupStage } from '../../../shared/app/startup/routing';
import { AppInitialization } from './appInitialization';

const roots: string[] = [];
test('publishes structured Main failures with their actual activity and log location', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const initialization = new AppInitialization(
    temporaryRoot(),
    StartupRoute.Normal,
    vi.fn(),
    () => ({ logPath: '/logs/main.log' }),
  );
  initialization.reportActivity(AppInitializationActivity.Database);
  initialization.fail(Object.assign(new Error('database locked'), { code: 'SQLITE_BUSY' }));
  expect(initialization.getState().failure).toMatchObject({
    source: 'main',
    error: { message: 'database locked', code: 'SQLITE_BUSY' },
    context: { activity: 'database', logPath: '/logs/main.log' },
  });
  expect(initialization.getState().historyRecovery).toBe('busy');
});
function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-initialization-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('continuing after a human confirmation starts the activity clock without resetting total startup time', () => {
  const time = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const initialization = new AppInitialization(temporaryRoot(), StartupRoute.Upgrade, vi.fn());
  initialization.setDowngradeConfirmation({ requestId: 'current-confirmation',
    source: { appVersion: '2.0.0', runtimeVersion: '2026.10.7' },
    target: { appVersion: '1.0.0', runtimeVersion: '2026.10.6' } });
  time.mockReturnValue(121000);
  initialization.setDowngradeConfirmation(undefined);
  initialization.reportActivity(AppInitializationActivity.NativeInspect);
  expect(initialization.getState()).toMatchObject({ startedAt: 1000, activityStartedAt: 121000,
    activity: AppInitializationActivity.NativeInspect, downgradeConfirmation: undefined });
  time.mockReturnValue(125000);
  initialization.setDowngradeConfirmation(undefined);
  expect(initialization.getState().activityStartedAt).toBe(121000);
});

test('publishes five real upgrade steps and never creates the first-install marker for adoption', async () => {
  const userData = temporaryRoot();
  const initialization = new AppInitialization(userData, StartupRoute.Upgrade, vi.fn());
  expect(initialization.getState()).toMatchObject({
    firstLaunch: true, route: StartupRoute.Upgrade, totalSteps: 5,
    step: AppInitializationStep.DatabaseUpgrade, completedSteps: 0,
    activity: AppInitializationActivity.NativeInspect,
  });
  for (const activity of [AppInitializationActivity.NativeBackup,
    AppInitializationActivity.NativeUpgrade, AppInitializationActivity.NativeVerify]) {
    initialization.reportActivity(activity);
    expect(initialization.getState()).toMatchObject({
      step: AppInitializationStep.DatabaseUpgrade, completedSteps: 0, activity,
    });
  }
  initialization.advance(AppInitializationStep.UserData, 0);
  expect(initialization.getState().completedSteps).toBe(1);
  initialization.advance(AppInitializationStep.Runtime, 1);
  expect(initialization.getState().completedSteps).toBe(2);
  initialization.advance(AppInitializationStep.Configuration, 2);
  expect(initialization.getState().completedSteps).toBe(3);
  initialization.advance(AppInitializationStep.Engine, 3);
  expect(initialization.getState().completedSteps).toBe(4);
  await initialization.complete();
  expect(initialization.getState()).toMatchObject({ completedSteps: 5, phase: AppInitializationPhase.Ready });
  expect(fs.existsSync(path.join(userData, '.justdo-initialized'))).toBe(false);
});

test.each([
  [StartupStage.UpgradePrepare, AppInitializationStep.DatabaseUpgrade, 0],
  [StartupStage.UpgradeVerify, AppInitializationStep.DatabaseUpgrade, 0],
  [StartupStage.Check, AppInitializationStep.DatabaseUpgrade, 0],
] as const)('resumes upgrade presentation at its actual %s milestone', (stage, step, completedSteps) => {
  const initialization = new AppInitialization(temporaryRoot(), StartupRoute.Upgrade,
    vi.fn(), () => ({}), stage);
  expect(initialization.getState()).toMatchObject({ totalSteps: 5, step, completedSteps });
});

test('keeps the original process startup clock after asynchronous routing inspection', () => {
  const initialization = new AppInitialization(temporaryRoot(), StartupRoute.Upgrade,
    vi.fn(), () => ({}), StartupStage.UpgradePrepare, 1000);
  expect(initialization.getState()).toMatchObject({ startedAt: 1000, activityStartedAt: 1000 });
});

test('initializes a Chinese path containing spaces and remembers successful completion', async () => {
  const userData = path.join(temporaryRoot(), '用户 数据');
  const onChanged = vi.fn();
  const initialization = new AppInitialization(userData, StartupRoute.Fresh, onChanged);
  expect(initialization.getState().firstLaunch).toBe(true);
  await initialization.prepareUserData();
  initialization.advance(AppInitializationStep.Engine, 3);
  expect(onChanged.mock.lastCall?.[0].completedSteps).toBe(3);
  await initialization.complete();
  expect(initialization.getState().phase).toBe(AppInitializationPhase.Ready);
  // The same process and its replacement windows retain their launch presentation.
  expect(initialization.getState().firstLaunch).toBe(true);
  expect(onChanged.mock.calls.every(([state]) => state.firstLaunch)).toBe(true);
  expect(new AppInitialization(userData, StartupRoute.Normal, vi.fn()).getState().firstLaunch).toBe(
    false,
  );
});

test('keeps the failed step and real filesystem error without marking initialization complete', async () => {
  const userData = path.join(temporaryRoot(), 'occupied-by-file');
  fs.writeFileSync(userData, 'preserve');
  const initialization = new AppInitialization(userData, StartupRoute.Fresh, vi.fn());
  try {
    await initialization.prepareUserData();
    throw new Error('Expected mkdir to fail');
  } catch (error) {
    initialization.fail(error);
  }
  expect(initialization.getState()).toMatchObject({
    phase: AppInitializationPhase.Failed,
    step: AppInitializationStep.UserData,
    completedSteps: 0,
  });
  expect(initialization.getState().error).toMatch(/EEXIST|ENOTDIR/);
  expect(fs.readFileSync(userData, 'utf8')).toBe('preserve');
  expect(new AppInitialization(userData, StartupRoute.Fresh, vi.fn()).getState().firstLaunch).toBe(
    true,
  );
});

test('an optional engine failure retains its full error and context without blocking the application', async () => {
  const userData = temporaryRoot();
  const onChanged = vi.fn();
  const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const initialization = new AppInitialization(userData, StartupRoute.Fresh, onChanged);
  const error = Object.assign(new Error('Gateway could not bind its port'), {
    code: 'EADDRINUSE',
    syscall: 'listen',
    cause: new Error('The requested address is already in use'),
  });
  initialization.advance(AppInitializationStep.Engine, 3);

  await initialization.runOptionalTask('start assistant engine', async () => {
    throw error;
  });

  expect(logError).toHaveBeenCalledWith(
    '[AppInitialization] Optional startup task failed; continuing:',
    'start assistant engine',
    { step: AppInitializationStep.Engine, userDataPath: userData },
    error,
  );
  expect(logError.mock.calls[0][3]).toBe(error);
  expect(initialization.getState()).toMatchObject({
    phase: AppInitializationPhase.Preparing,
    completedSteps: 3,
  });
  expect(initialization.getState().error).toBeUndefined();
  await initialization.complete();
  expect(initialization.getState().phase).toBe(AppInitializationPhase.Ready);
  expect(
    onChanged.mock.calls.every(([state]) => state.phase !== AppInitializationPhase.Failed),
  ).toBe(true);
  expect(new AppInitialization(userData, StartupRoute.Normal, vi.fn()).getState().firstLaunch).toBe(
    false,
  );
});

test('a failed presentation marker write is logged without blocking an initialized application', async () => {
  const userData = temporaryRoot();
  const markerPath = path.join(userData, '.justdo-initialized');
  const error = Object.assign(new Error(`EACCES: permission denied, open '${markerPath}'`), {
    code: 'EACCES',
    syscall: 'open',
    path: markerPath,
  });
  const writeFile = vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(error);
  const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const onChanged = vi.fn();
  const initialization = new AppInitialization(userData, StartupRoute.Fresh, onChanged);
  initialization.advance(AppInitializationStep.Engine, 3);

  await initialization.complete();

  expect(writeFile).toHaveBeenCalledWith(markerPath, 'ready\n', 'utf8');
  expect(logError).toHaveBeenCalledWith(
    '[AppInitialization] Optional startup task failed; continuing:',
    'remember initialization',
    { step: AppInitializationStep.Engine, userDataPath: userData },
    error,
  );
  expect(initialization.getState()).toMatchObject({
    phase: AppInitializationPhase.Ready,
    step: AppInitializationStep.Complete,
    completedSteps: 4,
  });
  expect(onChanged.mock.lastCall?.[0].phase).toBe(AppInitializationPhase.Ready);
  expect(fs.existsSync(markerPath)).toBe(false);
  expect(new AppInitialization(userData, StartupRoute.Fresh, vi.fn()).getState().firstLaunch).toBe(
    true,
  );
});

test('does not introduce first-install markers on the ordinary route', async () => {
  const root = temporaryRoot();
  const initialization = new AppInitialization(root, StartupRoute.Normal, vi.fn());
  await initialization.complete();
  expect(fs.readdirSync(root)).toEqual([]);
});

test('reports real activities without advancing milestones and retains timestamps across snapshots', async () => {
  const onChanged = vi.fn();
  const time = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const initialization = new AppInitialization(temporaryRoot(), StartupRoute.Normal, onChanged);
  time.mockReturnValue(5000);
  initialization.reportActivity(AppInitializationActivity.Database);
  expect(initialization.getState()).toMatchObject({
    activity: AppInitializationActivity.Database,
    completedSteps: 0,
    startedAt: 1000,
    activityStartedAt: 5000,
    updatedAt: 5000,
  });
  time.mockReturnValue(9000);
  initialization.reportActivity(AppInitializationActivity.Database);
  expect(onChanged).toHaveBeenCalledOnce();
  expect(initialization.getState().activityStartedAt).toBe(5000);
  initialization.advance(AppInitializationStep.Runtime, 1);
  expect(initialization.getState()).toMatchObject({
    activity: AppInitializationActivity.Python,
    startedAt: 1000,
    activityStartedAt: 9000,
  });
  await initialization.complete();
  initialization.reportActivity(AppInitializationActivity.EngineStart);
  expect(initialization.getState().phase).toBe(AppInitializationPhase.Ready);
  expect(initialization.getState().activity).toBe(AppInitializationActivity.Python);
});

test('preserves the failed activity and ignores late activity reports', () => {
  const initialization = new AppInitialization(temporaryRoot(), StartupRoute.Normal, vi.fn());
  initialization.reportActivity(AppInitializationActivity.Database);
  initialization.fail(new Error('database unavailable'));
  const failedState = initialization.getState();
  initialization.reportActivity(AppInitializationActivity.Python);
  expect(initialization.getState()).toEqual(failedState);
});

test('a resumed migration checks current resources without rewinding confirmed recovery milestones', () => {
  const initialization = new AppInitialization(
    temporaryRoot(),
    StartupRoute.Migration,
    vi.fn(),
    undefined,
    StartupStage.Check,
  );
  expect(initialization.getState()).toMatchObject({ completedSteps: 5, totalSteps: 6 });
  initialization.advance(AppInitializationStep.UserData, 0);
  expect(initialization.getState()).toMatchObject({
    step: AppInitializationStep.Engine,
    completedSteps: 5,
    activity: AppInitializationActivity.UserDirectory,
  });
});
