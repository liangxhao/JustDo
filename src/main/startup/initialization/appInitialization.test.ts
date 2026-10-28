import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import {
  AppInitializationActivity,
  AppInitializationPhase,
  AppInitializationStep,
  AppInitializationTask,
  AppInitializationTaskStatus,
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

test('keeps Normal engine preparation pending across shell readiness and publishes its later settlement', async () => {
  const onChanged = vi.fn();
  const initialization = new AppInitialization(temporaryRoot(), StartupRoute.Normal, onChanged);
  initialization.setEnginePreparationPending(true);
  await initialization.complete();
  expect(initialization.getState()).toMatchObject({
    phase: AppInitializationPhase.Ready, enginePreparationPending: true,
  });
  initialization.setEnginePreparationPending(false);
  expect(onChanged.mock.lastCall?.[0]).toMatchObject({
    phase: AppInitializationPhase.Ready, enginePreparationPending: false,
  });
  initialization.setEnginePreparationPending(true);
  expect(initialization.getState().enginePreparationPending).toBe(true);
});

test('an engine failure preserves the usable shell and clears when a retry begins', async () => {
  const initialization = new AppInitialization(temporaryRoot(), StartupRoute.Normal, vi.fn());
  expect(initialization.getState().enginePreparationPending).toBe(true);
  await initialization.complete();
  initialization.failEnginePreparation(new Error('Permission preparation failed'));
  expect(initialization.getState()).toMatchObject({ phase: AppInitializationPhase.Ready,
    enginePreparationPending: false,
    enginePreparationFailure: { error: { message: 'Permission preparation failed' } } });
  initialization.setEnginePreparationPending(true);
  expect(initialization.getState()).toMatchObject({ phase: AppInitializationPhase.Ready,
    enginePreparationPending: true, enginePreparationFailure: undefined });
});

test.each([StartupRoute.Fresh, StartupRoute.Migration, StartupRoute.Upgrade])(
  'keeps the original first-launch engine waiting contract without a Normal pending flag (%s)', route => {
    const initialization = new AppInitialization(temporaryRoot(), route, vi.fn());
    initialization.setEnginePreparationPending(true);
    initialization.setEnginePreparationPending(false);
    expect(initialization.getState().enginePreparationPending).toBeUndefined();
  },
);

test('rejects a late engine settlement after startup failed', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const onChanged = vi.fn();
  const initialization = new AppInitialization(temporaryRoot(), StartupRoute.Normal, onChanged);
  initialization.setEnginePreparationPending(true);
  initialization.fail(new Error('Startup failed'));
  const failed = initialization.getState();
  initialization.setEnginePreparationPending(false);
  expect(initialization.getState()).toEqual(failed);
  expect(onChanged.mock.lastCall?.[0]).toEqual(failed);
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

test('publishes independent task progress without changing older snapshots or completing waiting work', async () => {
  const initialization = new AppInitialization(temporaryRoot(), StartupRoute.Normal, vi.fn());
  const original = initialization.getState();
  initialization.setTaskStatus(AppInitializationTask.UserData, AppInitializationTaskStatus.Running);
  initialization.setTaskStatus(AppInitializationTask.Configuration, AppInitializationTaskStatus.Running);
  const parallel = initialization.getState();
  initialization.setTaskStatus(AppInitializationTask.UserData, AppInitializationTaskStatus.Complete);
  expect(parallel.tasks?.userData).toBe(AppInitializationTaskStatus.Running);
  expect(original.tasks?.userData).toBe(AppInitializationTaskStatus.Waiting);
  expect(initialization.getState().tasks).toEqual({ userData: 'complete', configuration: 'running', integrations: 'waiting' });
  const copy = initialization.getState();
  copy.tasks!.configuration = AppInitializationTaskStatus.Complete;
  expect(initialization.getState().tasks?.configuration).toBe(AppInitializationTaskStatus.Running);
  initialization.setTaskStatus(AppInitializationTask.Integrations, AppInitializationTaskStatus.Complete);
  expect(initialization.getState().tasks?.integrations).toBe(AppInitializationTaskStatus.Waiting);
  await initialization.complete();
  expect(initialization.getState().tasks).toEqual({ userData: 'complete', configuration: 'running', integrations: 'waiting' });
});

test('Main failure marks only its active tasks failed and refuses late task completion', () => {
  const initialization = new AppInitialization(temporaryRoot(), StartupRoute.Normal, vi.fn());
  initialization.setTaskStatus(AppInitializationTask.UserData, AppInitializationTaskStatus.Running);
  initialization.setTaskStatus(AppInitializationTask.UserData, AppInitializationTaskStatus.Complete);
  initialization.setTaskStatus(AppInitializationTask.Integrations, AppInitializationTaskStatus.Running);
  initialization.fail(new Error('service preparation failed'));
  const failed = initialization.getState();
  expect(failed.tasks).toEqual({ userData: 'complete', configuration: 'waiting', integrations: 'failed' });
  initialization.setTaskStatus(AppInitializationTask.Integrations, AppInitializationTaskStatus.Complete);
  expect(initialization.getState()).toEqual(failed);
});

test('allows active local services to settle after shell readiness without starting new work', async () => {
  const initialization = new AppInitialization(temporaryRoot(), StartupRoute.Normal, vi.fn());
  initialization.setTaskStatus(AppInitializationTask.Integrations, AppInitializationTaskStatus.Running);
  await initialization.complete();
  initialization.setTaskStatus(AppInitializationTask.UserData, AppInitializationTaskStatus.Running);
  expect(initialization.getState().tasks?.userData).toBe(AppInitializationTaskStatus.Waiting);
  initialization.setTaskStatus(AppInitializationTask.Integrations, AppInitializationTaskStatus.Complete);
  expect(initialization.getState().tasks?.integrations).toBe(AppInitializationTaskStatus.Complete);
  initialization.setTaskStatus(AppInitializationTask.Integrations, AppInitializationTaskStatus.Failed);
  expect(initialization.getState().tasks?.integrations).toBe(AppInitializationTaskStatus.Complete);
});

test.each([StartupRoute.Fresh, StartupRoute.Migration, StartupRoute.Upgrade])('does not add ordinary parallel task state to %s startup', route => {
  const initialization = new AppInitialization(temporaryRoot(), route, vi.fn());
  initialization.setTaskStatus(AppInitializationTask.UserData, AppInitializationTaskStatus.Running);
  expect(initialization.getState().tasks).toBeUndefined();
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
