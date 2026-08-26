// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenClawEngineStatus } from '@/features/cowork/coworkTypes';

import EngineStartupStatusBar from './EngineStartupStatusBar';

const serviceMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  onStatus: vi.fn(),
  restartGateway: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useSelector: () => true,
}));

vi.mock('@/features/cowork/coworkService', () => ({
  coworkService: {
    getOpenClawEngineStatus: serviceMocks.getStatus,
    onOpenClawEngineStatus: serviceMocks.onStatus,
    restartOpenClawGateway: serviceMocks.restartGateway,
  },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

const startingStatus: OpenClawEngineStatus = {
  phase: 'starting',
  version: 'v1',
  message: 'Starting gateway',
  canRetry: false,
};

describe('EngineStartupStatusBar', () => {
  let statusListener: ((status: OpenClawEngineStatus) => void) | undefined;

  beforeEach(() => {
    statusListener = undefined;
    serviceMocks.getStatus.mockReset().mockImplementation(async () => {
      statusListener?.(startingStatus);
      return startingStatus;
    });
    serviceMocks.onStatus.mockReset().mockImplementation(callback => {
      statusListener = callback;
      return vi.fn();
    });
    serviceMocks.restartGateway.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows a quiet indeterminate ring without a percentage', async () => {
    const { container } = render(<EngineStartupStatusBar />);

    expect(await screen.findByText('coworkOpenClawStarting')).toBeTruthy();
    expect(container.querySelector('[aria-hidden="true"].animate-spin')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.textContent).not.toContain('%');
    expect(container.querySelector('[style*="width"]')).toBeNull();
  });

  it('removes the startup notice as soon as the gateway is running', async () => {
    render(<EngineStartupStatusBar />);
    expect(await screen.findByText('coworkOpenClawStarting')).toBeTruthy();

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
});
