// @vitest-environment jsdom
import {
  AppInitializationActivity,
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
} from '@shared/app/initialization';
import { StartupRoute } from '@shared/app/startup/routing';
import { captureStartupFailure, StartupFailureSource } from '@shared/app/startupFailure';
import type { EngineDiagnosticReport } from '@shared/openclaw/engineDiagnostics';
import type { OpenClawEngineStatus } from '@shared/openclaw/engineStatus';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  STARTUP_ENTRY_DURATION_MS,
  STARTUP_ENTRY_STARTED_ATTRIBUTE,
} from '../initialization/startupMotion';
import AppInitializationGate from './AppInitializationGate';
import ApplicationLoading, {
  useInitializationFailure,
  useInitialWorkspaceReadiness,
  useStartupActivity,
} from './ApplicationLoading';
import { RendererStartupActivity } from './startupPresentation';

vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => <div>window controls</div> }));
vi.mock('@/services/i18n', () => ({
  i18nService: { setLanguage: vi.fn(), subscribe: () => vi.fn(), t: (key: string) => key },
}));
beforeEach(() => {
  // The HTML entry has already played before this coordination-only fixture mounts React.
  document.documentElement.setAttribute(
    STARTUP_ENTRY_STARTED_ATTRIBUTE,
    String(Date.now() - STARTUP_ENTRY_DURATION_MS),
  );
});
afterEach(() => {
  cleanup();
  delete window.startupDiagnostics;
  document.documentElement.removeAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function snapshot(firstLaunch: boolean): AppInitializationState {
  const now = Date.now();
  return {
    phase: AppInitializationPhase.Preparing,
    step: AppInitializationStep.Configuration,
    firstLaunch,
    completedSteps: 2,
    totalSteps: 4,
    userDataPath: 'C:\\existing-data',
    activity: AppInitializationActivity.DefaultFiles,
    startedAt: now,
    activityStartedAt: now,
    updatedAt: now,
  };
}
function bridge(firstLaunch: boolean, read: Promise<AppInitializationState>) {
  let callback!: (state: AppInitializationState) => void;
  const unsubscribe = vi.fn();
  const relaunch = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      platform: 'win32',
      initialization: {
        firstLaunch,
        isTransientWindow: false,
        getState: () => read,
        relaunch,
        onChanged: (next: typeof callback) => {
          callback = next;
          return unsubscribe;
        },
      },
      appInfo: { getSystemLocale: () => Promise.resolve('zh-CN') },
      log: { getPath: () => Promise.resolve('') },
    },
  });
  return {
    emit: (state: AppInitializationState) => act(() => callback(state)),
    unsubscribe,
    relaunch,
  };
}
function WorkspaceProbe({ completion }: { completion: Promise<void> }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void completion.then(
      () => {
        if (active) setReady(true);
      },
      reason => {
        if (active) setError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [completion]);
  useInitialWorkspaceReadiness(ready, error);
  return ready ? (
    <div>workspace ready</div>
  ) : (
    <ApplicationLoading activity={RendererStartupActivity.Conversations} />
  );
}
function observedModes(container: HTMLElement) {
  const modes = new Set<string>();
  const collect = () =>
    container
      .querySelectorAll('[data-startup-view]')
      .forEach(element => modes.add(element.getAttribute('data-startup-view')!));
  collect();
  const observer = new MutationObserver(collect);
  observer.observe(container, { subtree: true, childList: true, attributes: true });
  return { modes, collect, stop: () => observer.disconnect() };
}

test.each([true, false])(
  'keeps one presentation from pending snapshot through lazy App and workspace readiness (firstLaunch=%s)',
  async firstLaunch => {
    const read = deferred<AppInitializationState>();
    const api = bridge(firstLaunch, read.promise);
    const module = deferred<{ default: React.ComponentType }>();
    const workspace = deferred<void>();
    const Application = React.lazy(() => module.promise);
    const view = render(
      <AppInitializationGate>
        <Application />
      </AppInitializationGate>,
    );
    const history = observedModes(view.container);
    const expected = firstLaunch ? 'first-launch' : 'launch';
    expect(view.container.querySelector(`[data-startup-view="${expected}"]`)).toBeTruthy();
    const state = snapshot(firstLaunch);
    api.emit(state);
    expect(view.container.querySelector('[data-application-surface]')).toBeNull();
    api.emit({
      ...state,
      phase: AppInitializationPhase.Ready,
      completedSteps: 4,
      step: AppInitializationStep.Complete,
    });
    expect(
      view.container.querySelector('[data-application-surface]')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(view.container.querySelector(`[data-startup-view="${expected}"]`)).toBeTruthy();
    await act(async () => {
      module.resolve({ default: () => <WorkspaceProbe completion={workspace.promise} /> });
    });
    await waitFor(() =>
      expect(
        screen.getByText(
          firstLaunch ? 'initializationRenderer_conversations' : 'startupRenderer_conversations',
        ),
      ).toBeTruthy(),
    );
    expect(view.container.querySelector(`[data-startup-view="${expected}"]`)).toBeTruthy();
    expect(
      view.container.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow'),
    ).toBe(false);
    expect(
      screen.getByText(firstLaunch ? 'initializationInterfaceLoading' : 'startupInterfaceLoading'),
    ).toBeTruthy();
    await act(async () => {
      read.resolve({ ...state, firstLaunch: !firstLaunch });
    });
    expect(view.container.querySelector(`[data-startup-view="${expected}"]`)).toBeTruthy();
    await act(async () => {
      workspace.resolve();
    });
    await waitFor(() => expect(view.container.querySelector('.initialization-overlay')).toBeNull());
    expect(screen.getByText('workspace ready')).toBeTruthy();
    expect(view.container.querySelector('[data-application-surface]')?.hasAttribute('inert')).toBe(
      false,
    );
    history.collect();
    history.stop();
    expect(history.modes).toEqual(new Set([expected]));
    view.unmount();
    expect(api.unsubscribe).toHaveBeenCalledOnce();
  },
);

test.each([true, false])(
  'keeps snapshot and renderer errors inside their owning mode (firstLaunch=%s)',
  async firstLaunch => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const read = deferred<AppInitializationState>();
    const api = bridge(firstLaunch, read.promise);
    const workspace = deferred<void>();
    const view = render(
      <AppInitializationGate>
        <WorkspaceProbe completion={workspace.promise} />
      </AppInitializationGate>,
    );
    const history = observedModes(view.container);
    await act(async () => {
      read.reject(new Error('snapshot unavailable'));
    });
    expect(screen.getByRole('alert').textContent).toContain('snapshot unavailable');
    api.emit({ ...snapshot(firstLaunch), phase: AppInitializationPhase.Ready });
    await act(async () => {
      workspace.reject(new Error('workspace unavailable'));
    });
    expect(screen.getByRole('alert').textContent).toContain('workspace unavailable');
    expect(
      screen.getByRole('button', { name: firstLaunch ? 'initializationReload' : 'startupReload' }),
    ).toBeTruthy();
    expect(api.relaunch).not.toHaveBeenCalled();
    history.collect();
    history.stop();
    expect(history.modes).toEqual(new Set([firstLaunch ? 'first-launch' : 'launch']));
  },
);

test.each([true, false])(
  'keeps a failed lazy module inside its owning presentation (firstLaunch=%s)',
  async firstLaunch => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const state = snapshot(firstLaunch);
    bridge(firstLaunch, Promise.resolve({ ...state, phase: AppInitializationPhase.Ready }));
    const module = deferred<{ default: React.ComponentType }>();
    const Application = React.lazy(() => module.promise);
    const view = render(
      <AppInitializationGate>
        <Application />
      </AppInitializationGate>,
    );
    const history = observedModes(view.container);
    await waitFor(() =>
      expect(view.container.querySelector('[data-application-surface]')).toBeTruthy(),
    );
    await act(async () => {
      module.reject(new Error('interface chunk unavailable'));
    });
    expect(screen.getByRole('alert').textContent).toContain('interface chunk unavailable');
    history.collect();
    history.stop();
    expect(history.modes).toEqual(new Set([firstLaunch ? 'first-launch' : 'launch']));
  },
);

test('rejects a mode-changing snapshot rather than displaying another startup flow', async () => {
  bridge(true, Promise.resolve(snapshot(false)));
  const view = render(
    <AppInitializationGate>
      <div>application</div>
    </AppInitializationGate>,
  );
  expect(await screen.findByText('initializationModeMismatch')).toBeTruthy();
  expect(view.container.querySelector('[data-startup-view="first-launch"]')).toBeTruthy();
  expect(view.container.querySelector('[data-startup-view="launch"]')).toBeNull();
});

test.each([true, false])(
  'starts the renderer operation clock when Main becomes ready (firstLaunch=%s)',
  async firstLaunch => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const state = snapshot(firstLaunch);
    const api = bridge(firstLaunch, Promise.resolve(state));
    const module = deferred<{ default: React.ComponentType }>();
    const Application = React.lazy(() => module.promise);
    const view = render(
      <AppInitializationGate>
        <Application />
      </AppInitializationGate>,
    );
    await waitFor(() =>
      expect(
        view.container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
      ).toBe('2'),
    );
    time.mockReturnValue(101_000);
    api.emit({ ...state, phase: AppInitializationPhase.Ready, updatedAt: Date.now() });
    expect(
      screen.getByText(
        firstLaunch ? 'initializationRenderer_interface' : 'startupRenderer_interface',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(firstLaunch ? 'initializationExtendedWait' : 'startupExtendedWait'),
    ).toBeNull();
    expect(screen.getByText('01:40')).toBeTruthy();
    expect(screen.getByText('00:00')).toBeTruthy();
  },
);

test.each([true, false])(
  'keeps App initialization failures in their owning presentation (firstLaunch=%s)',
  async firstLaunch => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bridge(
      firstLaunch,
      Promise.resolve({ ...snapshot(firstLaunch), phase: AppInitializationPhase.Ready }),
    );
    function FailedApplication() {
      useInitializationFailure('application preferences unavailable');
      return <div>failed app surface</div>;
    }
    const view = render(
      <AppInitializationGate>
        <FailedApplication />
      </AppInitializationGate>,
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'application preferences unavailable',
    );
    expect(
      view.container.querySelector(
        `[data-startup-view="${firstLaunch ? 'first-launch' : 'launch'}"]`,
      ),
    ).toBeTruthy();
    expect(
      view.container.querySelector('[data-application-surface]')?.getAttribute('aria-hidden'),
    ).toBe('true');
  },
);

test.each([true, false])(
  'never reopens startup after workspace remounts (firstLaunch=%s)',
  async firstLaunch => {
    bridge(
      firstLaunch,
      Promise.resolve({ ...snapshot(firstLaunch), phase: AppInitializationPhase.Ready }),
    );
    const ready = Promise.resolve();
    const view = render(
      <React.StrictMode>
        <AppInitializationGate>
          <WorkspaceProbe completion={ready} />
        </AppInitializationGate>
      </React.StrictMode>,
    );
    await waitFor(() => expect(view.container.querySelector('.initialization-overlay')).toBeNull());
    view.rerender(
      <React.StrictMode>
        <AppInitializationGate>
          <WorkspaceProbe key="new-workspace" completion={new Promise(() => {})} />
        </AppInitializationGate>
      </React.StrictMode>,
    );
    expect(view.container.querySelector('[data-startup-view]')).toBeNull();
    expect(view.container.querySelector('[data-application-surface]')?.hasAttribute('inert')).toBe(
      false,
    );
  },
);

function engineBridge() {
  const status: OpenClawEngineStatus = {
    phase: 'error',
    version: 'test',
    canRetry: true,
    message: 'Engine timed out',
    diagnosticId: 'e05834ef-8035-45cc-a3f8-545ee4a75e30',
  };
  const report: EngineDiagnosticReport = {
    context: {
      id: status.diagnosticId!,
      startedAt: 1000,
      failedAt: 2000,
      processGeneration: 1,
      status,
    },
    collectedAt: 2500,
    window: { from: 1000, to: 2500 },
    engineChanged: false,
    evidence: [],
    findings: [],
    coverage: [],
  };
  let listener!: (status: unknown) => void;
  const unsubscribe = vi.fn();
  const engine = {
    getStatus: vi.fn().mockResolvedValue({ success: true, status }),
    onProgress: vi.fn(callback => {
      listener = callback;
      return unsubscribe;
    }),
    collectDiagnostics: vi.fn().mockResolvedValue({ success: true, report }),
    cancelDiagnostics: vi.fn().mockResolvedValue({ success: false, reason: 'canceled' }),
    startGateway: vi
      .fn()
      .mockResolvedValue({ success: true, status: { ...status, phase: 'running' } }),
  };
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { ...window.electron, openclaw: { engine } },
  });
  return {
    engine,
    status,
    unsubscribe,
    emit: (next: OpenClawEngineStatus) => act(() => listener(next)),
  };
}

test.each([true, false])(
  'uses the existing on-demand engine collector and holds the report through app readiness (firstLaunch=%s)',
  async firstLaunch => {
    const read = deferred<AppInitializationState>();
    const workspace = deferred<void>();
    bridge(firstLaunch, read.promise);
    const { engine, status, unsubscribe } = engineBridge();
    const view = render(
      <AppInitializationGate>
        <WorkspaceProbe completion={workspace.promise} />
      </AppInitializationGate>,
    );
    await screen.findByRole('button', { name: 'startupDiagnosticsView' });
    expect(engine.collectDiagnostics).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'startupDiagnosticsView' }));
    const dialog = await screen.findByRole('dialog');
    expect(view.container.querySelector('.initialization-overlay')?.contains(dialog)).toBe(true);
    await waitFor(() =>
      expect(engine.collectDiagnostics).toHaveBeenCalledWith(
        expect.objectContaining({ diagnosticId: status.diagnosticId }),
      ),
    );
    await act(async () => {
      read.resolve({ ...snapshot(firstLaunch), phase: AppInitializationPhase.Ready });
      workspace.resolve();
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 700));
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(view.container.querySelector('[data-application-surface]')?.hasAttribute('inert')).toBe(
      true,
    );
    expect(
      view.container.querySelector('[data-startup-view]')?.getAttribute('data-startup-view'),
    ).toBe(firstLaunch ? 'first-launch' : 'launch');
    fireEvent.click(screen.getByRole('button', { name: 'windowClose' }));
    await waitFor(() => expect(view.container.querySelector('.initialization-overlay')).toBeNull());
    expect(engine.cancelDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ diagnosticId: status.diagnosticId }),
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
  },
);

test('fresh and migration snapshots cannot switch a window even though both use the shared guide', async () => {
  bridge(true, Promise.resolve({ ...snapshot(true), route: StartupRoute.Fresh }));
  Object.assign(window.electron.initialization, { route: StartupRoute.Migration });
  render(
    <AppInitializationGate>
      <div />
    </AppInitializationGate>,
  );
  expect((await screen.findByRole('alert')).textContent).toContain('initializationModeMismatch');
  expect(screen.getByText('initializationBackup')).toBeTruthy();
});

test('a migration waits for workspace readiness and explicit result confirmation before revealing the app', async () => {
  const ready = {
    ...snapshot(true),
    route: StartupRoute.Migration,
    phase: AppInitializationPhase.Ready,
    step: AppInitializationStep.Complete,
    totalSteps: 6,
    completedSteps: 6,
    historySummary: {
      conversations: 3,
      cachedConversations: 1,
      unavailableConversations: 1,
      nativeSessions: 4,
      missingTranscripts: 1,
      unavailableWorkspaces: 2,
    },
    historyBackupPath: 'C:/data/backups/history',
  };
  bridge(true, Promise.resolve(ready));
  Object.assign(window.electron.initialization, { route: StartupRoute.Migration });
  const workspace = deferred<void>();
  const view = render(
    <AppInitializationGate>
      <WorkspaceProbe completion={workspace.promise} />
    </AppInitializationGate>,
  );
  await waitFor(() => expect(screen.getByText('initializationInterfaceLoading')).toBeTruthy());
  expect(view.container.querySelector('[data-history-result]')).toBeNull();
  await act(async () => {
    workspace.resolve();
  });
  await screen.findByRole('region', { name: 'initializationResultTitle' });
  expect(view.container.querySelector('[data-application-surface]')?.hasAttribute('inert')).toBe(
    true,
  );
  expect(view.container.querySelector('.initialization-overlay')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'initializationResultContinue' }));
  await waitFor(() => expect(view.container.querySelector('.initialization-overlay')).toBeNull());
  expect(view.container.querySelector('[data-application-surface]')?.hasAttribute('inert')).toBe(
    false,
  );
});

test('a transient pre-backup guide never queries or subscribes to the runtime manager', async () => {
  bridge(true, Promise.resolve(snapshot(true)));
  const { engine } = engineBridge();
  Object.assign(window.electron.initialization, { isTransientWindow: true });
  const view = render(
    <AppInitializationGate>
      <div />
    </AppInitializationGate>,
  );
  await waitFor(() => expect(view.container.querySelector('[data-startup-view]')).toBeTruthy());
  expect(engine.getStatus).not.toHaveBeenCalled();
  expect(engine.onProgress).not.toHaveBeenCalled();
  expect(engine.startGateway).not.toHaveBeenCalled();
});

test('a same-tick model failure retains the real error code and model activity', async () => {
  bridge(false, Promise.resolve({ ...snapshot(false), phase: AppInitializationPhase.Ready }));
  const cause = Object.assign(new Error('model configuration unavailable'), {
    code: 'ERR_MODEL_READ',
  });
  function ModelProbe() {
    const [, report] = useStartupActivity(RendererStartupActivity.Language);
    const [failure, setFailure] = useState<Error | null>(null);
    useEffect(() => {
      report(RendererStartupActivity.Models);
      setFailure(cause);
    }, [report]);
    useInitializationFailure(failure);
    return null;
  }
  render(
    <AppInitializationGate>
      <ModelProbe />
    </AppInitializationGate>,
  );
  expect((await screen.findByRole('alert')).textContent).toContain(
    'model configuration unavailable',
  );
  expect(screen.getByText(/ERR_MODEL_READ/).textContent).toContain('activity: models');
});

test('captures renderer failures while an engine report is open and retains them after close', async () => {
  bridge(false, Promise.resolve(snapshot(false)));
  engineBridge();
  render(
    <AppInitializationGate>
      <div />
    </AppInitializationGate>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'startupDiagnosticsView' }));
  await screen.findByRole('dialog');
  act(() => {
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: Object.assign(new Error('workspace module failed'), { code: 'ERR_CHUNK' }),
      }),
    );
  });
  fireEvent.click(screen.getByRole('button', { name: 'windowClose' }));
  expect((await screen.findByRole('alert')).textContent).toContain('workspace module failed');
  expect(screen.getByText(/ERR_CHUNK/).textContent).toContain('workspace module failed');
});

test('preserves the viewed failure identity when the engine starts or becomes ready elsewhere', async () => {
  bridge(false, Promise.resolve(snapshot(false)));
  const { engine, status, emit } = engineBridge();
  render(
    <AppInitializationGate>
      <div />
    </AppInitializationGate>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'startupDiagnosticsView' }));
  await screen.findByRole('dialog');
  await waitFor(() => expect(engine.collectDiagnostics).toHaveBeenCalledOnce());
  emit({ ...status, phase: 'starting', canRetry: false, diagnosticId: undefined });
  emit({ ...status, phase: 'running', canRetry: false, diagnosticId: undefined });
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(engine.collectDiagnostics).toHaveBeenCalledOnce();
  expect(engine.cancelDiagnostics).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'engineStart' })).toBeNull();
});

test('keeps Main and engine failures independent and retries only the engine, discarding stale status reads', async () => {
  const main = {
    ...snapshot(false),
    phase: AppInitializationPhase.Failed,
    error: 'SQLITE_BUSY',
    failure: captureStartupFailure(
      StartupFailureSource.Main,
      Object.assign(new Error('database locked'), { code: 'SQLITE_BUSY' }),
    ),
  };
  const { relaunch } = bridge(false, Promise.resolve(main));
  const { engine, status, emit } = engineBridge();
  const oldStatus = deferred<{ success: boolean; status: OpenClawEngineStatus }>();
  engine.getStatus.mockReturnValue(oldStatus.promise);
  const view = render(
    <AppInitializationGate>
      <div />
    </AppInitializationGate>,
  );
  emit(status);
  await act(async () =>
    oldStatus.resolve({ success: true, status: { ...status, phase: 'running' } }),
  );
  expect(screen.getByRole('alert').textContent).toContain('SQLITE_BUSY');
  expect(view.container.textContent).toContain('database locked');
  fireEvent.click(screen.getByRole('button', { name: 'startupDiagnosticsView' }));
  await screen.findByRole('dialog');
  await waitFor(() => expect(engine.collectDiagnostics).toHaveBeenCalledOnce());
  emit({
    ...status,
    diagnosticId: 'acbe67d5-92e2-4845-bbb6-c460cc359d01',
    message: 'New engine failure',
  });
  await waitFor(() => expect(engine.collectDiagnostics).toHaveBeenCalledTimes(2));
  expect(engine.cancelDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({ diagnosticId: status.diagnosticId }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'engineStart' }));
  await waitFor(() => expect(engine.startGateway).toHaveBeenCalledOnce());
  expect(engine.cancelDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({ diagnosticId: 'acbe67d5-92e2-4845-bbb6-c460cc359d01' }),
  );
  expect(relaunch).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('SQLITE_BUSY');
});

test('retains bootstrap errors that arrive before the first React commit', async () => {
  bridge(false, Promise.resolve(snapshot(false)));
  window.startupDiagnostics = {
    failure: captureStartupFailure(StartupFailureSource.Renderer, new Error('early module failed')),
    fail: vi.fn(),
  };
  render(
    <AppInitializationGate>
      <div />
    </AppInitializationGate>,
  );
  expect((await screen.findByRole('alert')).textContent).toContain('early module failed');
  expect(screen.getByText(/renderer ·/).textContent).toContain('early module failed');
});
