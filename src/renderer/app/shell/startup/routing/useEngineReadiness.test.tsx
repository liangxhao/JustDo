// @vitest-environment jsdom
import {
  AppInitializationActivity, AppInitializationPhase, type AppInitializationState, AppInitializationStep,
} from '@shared/app/initialization';
import { StartupRoute } from '@shared/app/startup/routing';
import { captureStartupFailure, StartupFailureSource } from '@shared/app/startupFailure';
import type { EngineCommandResult, OpenClawEngineStatus } from '@shared/openclaw/engineStatus';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { getEngineReadinessSnapshot, useEngineReadiness } from './useEngineReadiness';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const state: AppInitializationState = {
    phase: AppInitializationPhase.Ready, step: AppInitializationStep.Complete,
    route: StartupRoute.Normal, firstLaunch: false, enginePreparationPending: true,
    completedSteps: 4, totalSteps: 4, userDataPath: 'C:/data',
    activity: AppInitializationActivity.Finalize, startedAt: 1, activityStartedAt: 1, updatedAt: 1,
  };
  const status: OpenClawEngineStatus = { phase: 'starting', version: 'v1', canRetry: false };
  let onState!: (next: AppInitializationState) => void;
  let onStatus!: (next: OpenClawEngineStatus) => void;
  const stateUnsubscribe = vi.fn();
  const engineUnsubscribe = vi.fn();
  const getState = vi.fn().mockResolvedValue(state);
  const getStatus = vi.fn().mockResolvedValue({ success: true, status });
  const subscribeState = vi.fn(callback => { onState = callback; return stateUnsubscribe; });
  const subscribeStatus = vi.fn(callback => { onStatus = callback; return engineUnsubscribe; });
  vi.stubGlobal('electron', {
    initialization: { getState, onChanged: subscribeState },
    openclaw: { engine: { getStatus, onProgress: subscribeStatus } },
  });
  return { state, status, getState, getStatus, stateUnsubscribe, engineUnsubscribe,
    subscribeState, subscribeStatus,
    emitState: (next: AppInitializationState) => act(() => onState(next)),
    emitStatus: (next: OpenClawEngineStatus) => act(() => onStatus(next)),
  };
}

test('waits for Main admission even after the process reports Running, without guessing unknown states', async () => {
  const api = fixture();
  const { result } = renderHook(useEngineReadiness);
  expect(result.current.ready).toBe(false);
  await waitFor(() => expect(result.current.status?.phase).toBe('starting'));
  api.emitStatus({ ...api.status, phase: 'running' });
  expect(result.current.pending).toBe(true);
  api.emitState({ ...api.state, enginePreparationPending: undefined });
  expect(result.current.ready).toBe(false);
  api.emitState({ ...api.state, enginePreparationPending: false });
  expect(result.current.ready).toBe(true);
  api.emitStatus({ ...api.status, phase: 'ready' });
  expect(result.current.ready).toBe(false);
});

test('retains preparation failure until Main explicitly begins a retry and confirms it', async () => {
  const api = fixture();
  const { result } = renderHook(useEngineReadiness);
  await waitFor(() => expect(result.current.status).toBeTruthy());
  const failure = captureStartupFailure(StartupFailureSource.Main, new Error('Policy unavailable'));
  api.emitState({ ...api.state, enginePreparationPending: false, enginePreparationFailure: failure });
  api.emitStatus({ ...api.status, phase: 'running' });
  expect(result.current.failed).toBe(true);
  expect(result.current.ready).toBe(false);
  api.emitState(api.state);
  expect(result.current.pending).toBe(true);
  api.emitState({ ...api.state, enginePreparationPending: false });
  expect(result.current.ready).toBe(true);
});

test('shares IPC subscriptions and rejects stale initial reads after live readiness changes', async () => {
  const api = fixture();
  const oldState = deferred<AppInitializationState>();
  const oldStatus = deferred<EngineCommandResult>();
  api.getState.mockReturnValue(oldState.promise);
  api.getStatus.mockReturnValue(oldStatus.promise);
  const first = renderHook(useEngineReadiness);
  const second = renderHook(useEngineReadiness);
  expect(api.subscribeState).toHaveBeenCalledOnce();
  expect(api.subscribeStatus).toHaveBeenCalledOnce();
  api.emitState({ ...api.state, enginePreparationPending: false });
  api.emitStatus({ ...api.status, phase: 'running' });
  await act(async () => { oldState.resolve(api.state); oldStatus.resolve({ success: true, status: api.status }); });
  expect(first.result.current.ready).toBe(true);
  first.unmount();
  expect(api.engineUnsubscribe).not.toHaveBeenCalled();
  second.unmount();
  expect(api.engineUnsubscribe).toHaveBeenCalledOnce();
  expect(api.stateUnsubscribe).toHaveBeenCalledOnce();
  expect(getEngineReadinessSnapshot().pending).toBe(true);
});

test('clears a failed status read when a valid engine event arrives', async () => {
  const api = fixture();
  api.getState.mockResolvedValue({ ...api.state, enginePreparationPending: false });
  api.getStatus.mockRejectedValue(new Error('IPC unavailable'));
  const { result } = renderHook(useEngineReadiness);
  await waitFor(() => expect(result.current.failed).toBe(true));
  api.emitStatus({ ...api.status, phase: 'running' });
  expect(result.current.ready).toBe(true);
});

test('ignores late read failures after unmount and preserves installation admission', async () => {
  const api = fixture();
  const read = deferred<EngineCommandResult>();
  api.getStatus.mockReturnValue(read.promise);
  const first = renderHook(useEngineReadiness);
  first.unmount();
  await act(async () => read.reject(new Error('retired read')));
  expect(getEngineReadinessSnapshot().failed).toBe(false);
  api.getStatus.mockResolvedValue({ success: true, status: { ...api.status, phase: 'running' } });
  api.getState.mockResolvedValue({ ...api.state, route: StartupRoute.Upgrade, phase: AppInitializationPhase.Preparing });
  const second = renderHook(useEngineReadiness);
  await waitFor(() => expect(second.result.current.status?.phase).toBe('running'));
  expect(second.result.current.ready).toBe(false);
  api.emitState({ ...api.state, route: StartupRoute.Upgrade });
  expect(second.result.current.ready).toBe(true);
});
