import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { AppInitializationPhase, AppInitializationStep } from '../../../shared/app/initialization';
import { AppInitialization } from './appInitialization';

const roots: string[] = [];
function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-initialization-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('initializes a Chinese path containing spaces and remembers successful completion', async () => {
  const userData = path.join(temporaryRoot(), '用户 数据');
  const onChanged = vi.fn();
  const initialization = new AppInitialization(userData, true, onChanged);
  expect(initialization.getState().firstLaunch).toBe(true);
  await initialization.prepareUserData();
  initialization.advance(AppInitializationStep.Engine, 3);
  expect(onChanged.mock.lastCall?.[0].completedSteps).toBe(3);
  await initialization.complete();
  expect(initialization.getState().phase).toBe(AppInitializationPhase.Ready);
  expect(new AppInitialization(userData, true, vi.fn()).getState().firstLaunch).toBe(false);
});

test('keeps the failed step and real filesystem error without marking initialization complete', async () => {
  const userData = path.join(temporaryRoot(), 'occupied-by-file');
  fs.writeFileSync(userData, 'preserve');
  const initialization = new AppInitialization(userData, true, vi.fn());
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
  expect(new AppInitialization(userData, true, vi.fn()).getState().firstLaunch).toBe(true);
});

test('an optional engine failure retains its full error and context without blocking the application', async () => {
  const userData = temporaryRoot();
  const onChanged = vi.fn();
  const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const initialization = new AppInitialization(userData, true, onChanged);
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
  expect(new AppInitialization(userData, true, vi.fn()).getState().firstLaunch).toBe(false);
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
  const initialization = new AppInitialization(userData, true, onChanged);
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
  expect(new AppInitialization(userData, true, vi.fn()).getState().firstLaunch).toBe(true);
});

test('does not introduce first-install markers in development or other platforms', async () => {
  const root = temporaryRoot();
  const initialization = new AppInitialization(root, false, vi.fn());
  await initialization.complete();
  expect(fs.readdirSync(root)).toEqual([]);
});
