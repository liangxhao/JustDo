import { expect, test, vi } from 'vitest';

import { AppInitializationPhase } from '../../../shared/app/initialization';
import { StartupRoute } from '../../../shared/app/startup/routing';
import { EnginePhase, type OpenClawEngineStatus } from '../../../shared/openclaw/engineStatus';
import { AppInitialization } from './appInitialization';
import { StartupEnginePreparation } from './startupEnginePreparation';

function deferred() {
  let resolve!: (status: OpenClawEngineStatus) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<OpenClawEngineStatus>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const initialization = new AppInitialization('/unused', StartupRoute.Normal, vi.fn());
  await initialization.complete();
  let status: OpenClawEngineStatus = { phase: EnginePhase.Starting, version: 'test', canRetry: false };
  const state = { process: 1, lifecycle: 1, quitting: false };
  const prepared = deferred();
  const prepare = vi.fn(() => prepared.promise);
  const coordinator = new StartupEnginePreparation({ initialization, isQuitting: () => state.quitting,
    manager: { getStatus: () => status, getGatewayProcessGeneration: () => state.process,
      getGatewayLifecycleGeneration: () => state.lifecycle }, prepare });
  const publish = (phase: OpenClawEngineStatus['phase']) => {
    status = { ...status, phase };
    coordinator.observe(status);
    return status;
  };
  return { initialization, state, prepare, prepared, coordinator, publish };
}

test('keeps a running process unavailable until authenticated permission preparation completes', async () => {
  const f = await fixture();
  const admission = deferred();
  const task = f.coordinator.run(() => admission.promise);
  const running = f.publish(EnginePhase.Running);
  expect(f.coordinator.isReady()).toBe(false);
  expect(f.initialization.getState().enginePreparationPending).toBe(true);
  admission.resolve(running);
  await task;
  expect(f.coordinator.isReady()).toBe(true);
});

test('publishes a domain failure after Running without closing the shell; a retry can recover', async () => {
  const f = await fixture();
  const admission = deferred();
  const task = f.coordinator.run(() => admission.promise);
  const running = f.publish(EnginePhase.Running);
  admission.reject(new Error('Permission verification failed'));
  await expect(task).rejects.toThrow('Permission verification failed');
  expect(f.initialization.getState()).toMatchObject({ phase: AppInitializationPhase.Ready,
    enginePreparationPending: false,
    enginePreparationFailure: { error: { message: 'Permission verification failed' } } });
  expect(f.coordinator.isReady()).toBe(false);
  await f.coordinator.run(async () => running);
  expect(f.coordinator.isReady()).toBe(true);
  expect(f.initialization.getState().enginePreparationFailure).toBeUndefined();
});

test('a late failure from the original attempt cannot replace a successful retry', async () => {
  const f = await fixture();
  const old = deferred();
  const task = f.coordinator.run(() => old.promise);
  const running = f.publish(EnginePhase.Running);
  await f.coordinator.run(async () => running);
  old.reject(new Error('Retired startup'));
  await expect(task).rejects.toThrow('Retired startup');
  expect(f.coordinator.isReady()).toBe(true);
  expect(f.initialization.getState().enginePreparationFailure).toBeUndefined();
});

test('a superseded attempt cannot return old Running to its caller after a successful retry', async () => {
  const f = await fixture();
  const old = deferred();
  const task = f.coordinator.run(() => old.promise);
  const running = f.publish(EnginePhase.Running);
  await f.coordinator.run(async () => running);
  old.resolve(running);
  await expect(task).rejects.toThrow();
  expect(f.coordinator.isReady()).toBe(true);
  expect(f.initialization.getState().enginePreparationFailure).toBeUndefined();
});

test('a stable admitted verification cannot return Running after its lifecycle is replaced', async () => {
  const f = await fixture();
  const initial = deferred();
  const first = f.coordinator.run(() => initial.promise);
  const running = f.publish(EnginePhase.Running);
  initial.resolve(running);
  await first;
  const verification = deferred();
  const task = f.coordinator.run(() => verification.promise);
  f.state.lifecycle += 1;
  f.publish(EnginePhase.Starting);
  f.publish(EnginePhase.Running);
  verification.resolve(running);
  await expect(task).rejects.toThrow();
  expect(f.coordinator.isReady()).toBe(false);
  f.prepared.resolve(running);
  await vi.waitFor(() => expect(f.coordinator.isReady()).toBe(true));
});

test.each([EnginePhase.Running, EnginePhase.Error])(
  'a successor lifecycle requires its own preparation after an old %s result', async oldPhase => {
  const f = await fixture();
  const original = deferred();
  const task = f.coordinator.run(() => original.promise);
  const running = f.publish(EnginePhase.Running);
  f.state.lifecycle += 1;
  f.publish(EnginePhase.Starting);
  f.publish(EnginePhase.Running);
  original.resolve({ ...running, phase: oldPhase });
  await expect(task).rejects.toThrow();
  expect(f.coordinator.isReady()).toBe(false);
  expect(f.prepare).toHaveBeenCalledOnce();
  f.prepared.resolve(running);
  await vi.waitFor(() => expect(f.coordinator.isReady()).toBe(true));
});

test('an independently restarted process recovers only after checking its new generation', async () => {
  const f = await fixture();
  const first = deferred();
  const task = f.coordinator.run(() => first.promise);
  const running = f.publish(EnginePhase.Running);
  first.resolve(running);
  await task;
  f.state.process += 1;
  f.publish(EnginePhase.Starting);
  expect(f.coordinator.isReady()).toBe(false);
  f.publish(EnginePhase.Running);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.coordinator.isReady()).toBe(false);
  f.prepared.resolve(running);
  await vi.waitFor(() => expect(f.coordinator.isReady()).toBe(true));
});

test('late startup completion and ready events cannot reopen admission during shutdown', async () => {
  const f = await fixture();
  const admission = deferred();
  const task = f.coordinator.run(() => admission.promise);
  f.state.quitting = true;
  admission.resolve(f.publish(EnginePhase.Running));
  await expect(task).rejects.toThrow();
  expect(f.coordinator.isReady()).toBe(false);
  expect(f.initialization.getState().enginePreparationPending).toBe(true);
  expect(f.prepare).not.toHaveBeenCalled();
});

test.each(['quitting', 'failed'] as const)(
  'rejects a new preparation when the application is %s even if its process is still running', async reason => {
    const f = await fixture();
    const first = deferred();
    const task = f.coordinator.run(() => first.promise);
    first.resolve(f.publish(EnginePhase.Running));
    await task;
    if (reason === 'quitting') f.state.quitting = true;
    else f.initialization.fail(new Error('The application shell failed'));
    const operation = vi.fn(async () => ({ phase: EnginePhase.Running, version: 'test', canRetry: false }));
    await expect(f.coordinator.run(operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(f.coordinator.isReady()).toBe(false);
    await f.coordinator.settle();
  },
);

test('a stopped process without an active preparation stays available for an explicit start', async () => {
  const f = await fixture();
  f.publish(EnginePhase.Ready);
  expect(f.coordinator.isReady()).toBe(false);
  expect(f.initialization.getState().enginePreparationPending).toBe(false);
  expect(f.initialization.getState().enginePreparationFailure).toBeUndefined();
  expect(f.prepare).not.toHaveBeenCalled();
});

test('an in-flight preparation still owns a temporary Ready transition during restart', async () => {
  const f = await fixture();
  const admission = deferred();
  const task = f.coordinator.run(() => admission.promise);
  f.publish(EnginePhase.Ready);
  expect(f.initialization.getState().enginePreparationPending).toBe(true);
  admission.resolve(f.publish(EnginePhase.Running));
  await task;
  expect(f.coordinator.isReady()).toBe(true);
});

test('cleanup joins a successor preparation even after the original startup promise has completed', async () => {
  const f = await fixture();
  const original = deferred();
  const task = f.coordinator.run(() => original.promise);
  const running = f.publish(EnginePhase.Running);
  f.state.process += 1;
  f.publish(EnginePhase.Starting);
  f.publish(EnginePhase.Running);
  original.resolve(running);
  await expect(task).rejects.toThrow();
  f.state.quitting = true;
  let retired = false;
  const cleanup = f.coordinator.settle().then(() => { retired = true; });
  await Promise.resolve();
  expect(retired).toBe(false);
  f.prepared.resolve(running);
  await cleanup;
  expect(retired).toBe(true);
  expect(f.coordinator.isReady()).toBe(false);
});
