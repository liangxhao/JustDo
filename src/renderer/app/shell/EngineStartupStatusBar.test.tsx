// @vitest-environment jsdom

import { AppInitializationActivity, AppInitializationPhase, type AppInitializationState, AppInitializationStep } from '@shared/app/initialization';
import { StartupRoute } from '@shared/app/startup/routing';
import { captureStartupFailure, StartupFailureSource } from '@shared/app/startupFailure';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenClawEngineStatus } from '@/features/cowork/coworkTypes';

import EngineStartupStatusBar from './EngineStartupStatusBar';
import WindowHeader from './window/WindowHeader';

const serviceMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  onStatus: vi.fn(),
  startGateway: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useSelector: () => true,
}));

vi.mock('@/features/cowork/coworkService', () => ({
  coworkService: {
    getOpenClawEngineStatus: serviceMocks.getStatus,
    onOpenClawEngineStatus: serviceMocks.onStatus,
    startOpenClawGateway: serviceMocks.startGateway,
  },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

vi.mock('./window/WindowTitleBar', () => ({
  default: () => <button data-window-control="minimize">Minimize</button>,
}));

const startingStatus: OpenClawEngineStatus = {
  phase: 'starting',
  version: 'v1',
  message: 'Starting gateway',
  canRetry: false,
};

describe('EngineStartupStatusBar', () => {
  let statusListener: ((status: OpenClawEngineStatus) => void) | undefined;
  let initializationListener: ((state: AppInitializationState) => void) | undefined;
  let initializationState: AppInitializationState;

  beforeEach(() => {
    statusListener = undefined;
    initializationListener = undefined;
    initializationState = {
      phase: AppInitializationPhase.Ready, step: AppInitializationStep.Complete,
      route: StartupRoute.Normal, firstLaunch: false, enginePreparationPending: false,
      completedSteps: 4, totalSteps: 4, userDataPath: 'C:/data',
      activity: AppInitializationActivity.Finalize,
      startedAt: 1, activityStartedAt: 1, updatedAt: 1,
    };
    Object.defineProperty(window, 'electron', { configurable: true, value: {
      initialization: {
        getState: async () => initializationState,
        onChanged: (callback: typeof initializationListener) => {
          initializationListener = callback;
          return () => {};
        },
      },
      openclaw: { engine: {
        getStatus: async () => ({ success: true, status: await serviceMocks.getStatus() }),
        onProgress: (callback: typeof statusListener) => serviceMocks.onStatus(callback),
      } },
    } });
    serviceMocks.getStatus.mockReset().mockImplementation(async () => {
      statusListener?.(startingStatus);
      return startingStatus;
    });
    serviceMocks.onStatus.mockReset().mockImplementation(callback => {
      statusListener = callback;
      return vi.fn();
    });
    serviceMocks.startGateway
      .mockReset()
      .mockResolvedValue({ ...startingStatus, phase: 'running' });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows a visible indeterminate ring that keeps rotating without a percentage', async () => {
    const { container } = render(<EngineStartupStatusBar />);

    expect(await screen.findByText('engineStarting')).toBeTruthy();
    const spinner = container.querySelector('[aria-hidden="true"].animate-spin');
    expect(spinner).toBeTruthy();
    expect(spinner?.classList.contains('border-2')).toBe(true);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.textContent).not.toContain('%');
    expect(container.querySelector('[style*="width"]')).toBeNull();
  });

  it('removes the startup notice as soon as the gateway is running', async () => {
    render(<EngineStartupStatusBar />);
    expect(await screen.findByText('engineStarting')).toBeTruthy();

    act(() => {
      statusListener?.({
        phase: 'running',
        version: 'v1',
        message: 'Gateway running',
        canRetry: false,
      });
    });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the notice until Main confirms execution admission after Running', async () => {
    initializationState = { ...initializationState, enginePreparationPending: true };
    render(<EngineStartupStatusBar />);
    expect(await screen.findByText('engineStarting')).toBeTruthy();
    act(() => statusListener?.({ ...startingStatus, phase: 'running' }));
    expect(screen.getByText('engineStarting')).toBeTruthy();
    act(() => initializationListener?.({ ...initializationState, enginePreparationPending: false }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows only a start action while stopped and starts without a restart', async () => {
    render(<EngineStartupStatusBar />);
    await act(async () => {});
    act(() => statusListener?.({ ...startingStatus, phase: 'ready' }));

    expect(screen.getByRole('status').textContent).toBe('engineStart');
    fireEvent.click(screen.getByRole('button', { name: 'engineStart' }));
    await waitFor(() => expect(serviceMocks.startGateway).toHaveBeenCalledOnce());
  });

  it('uses Main restart evidence even when mounted midway through a restart', async () => {
    serviceMocks.getStatus.mockImplementation(async () => {
      statusListener?.({ ...startingStatus, restarting: true });
    });
    render(<EngineStartupStatusBar />);

    expect(await screen.findByText('engineRestarting')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens the actual failure reason outside the title bar and allows a retry', async () => {
    const { container } = render(<EngineStartupStatusBar />);
    act(() =>
      statusListener?.({
        ...startingStatus,
        phase: 'error',
        canRetry: true,
        message: 'Port is occupied',
      }),
    );

    expect(screen.getByText('engineStartFailed')).toBeTruthy();
    expect(screen.queryByText('Port is occupied')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'engineViewReason' }));
    expect(screen.getByRole('dialog').textContent).toContain('Port is occupied');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'engineStart' }));
    await waitFor(() => expect(serviceMocks.startGateway).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a failed start command visible even if Main has not published an error', async () => {
    serviceMocks.startGateway.mockRejectedValue(new Error('Policy verification failed'));
    render(<EngineStartupStatusBar />);
    await act(async () => {});
    act(() => statusListener?.({ ...startingStatus, phase: 'ready' }));
    fireEvent.click(screen.getByRole('button', { name: 'engineStart' }));

    fireEvent.click(await screen.findByRole('button', { name: 'engineViewReason' }));
    expect(screen.getByRole('dialog').textContent).toContain('Policy verification failed');
  });

  it('recovers a failed initial status read after a retry without requiring a new process event', async () => {
    serviceMocks.getStatus.mockRejectedValueOnce(new Error('Status read failed'))
      .mockResolvedValue({ ...startingStatus, phase: 'running' });
    render(<EngineStartupStatusBar />);
    fireEvent.click(await screen.findByRole('button', { name: 'engineViewReason' }));
    fireEvent.click(screen.getByRole('button', { name: 'engineStart' }));
    await waitFor(() => expect(serviceMocks.startGateway).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('allows preparation to be retried while the underlying process is still running', async () => {
    initializationState = { ...initializationState,
      enginePreparationFailure: captureStartupFailure(StartupFailureSource.Main, new Error('Permission preparation failed')),
    };
    serviceMocks.getStatus.mockResolvedValue({ ...startingStatus, phase: 'running', canRetry: false });
    render(<EngineStartupStatusBar />);
    fireEvent.click(await screen.findByRole('button', { name: 'engineViewReason' }));
    fireEvent.click(screen.getByRole('button', { name: 'engineStart' }));
    await waitFor(() => expect(serviceMocks.startGateway).toHaveBeenCalledOnce());
  });

  it('places status immediately before minimize in the shared title bar', async () => {
    render(<WindowHeader showEngineStatus />);
    const status = await screen.findByRole('status');
    const header = status.closest('[data-window-header]');
    expect(header).toBeTruthy();
    expect(status.parentElement?.nextElementSibling?.getAttribute('data-window-control')).toBe(
      'minimize',
    );
    expect(header?.className).not.toContain('fixed');
  });
});
