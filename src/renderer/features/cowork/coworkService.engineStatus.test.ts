import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoworkService } from '@/features/cowork/coworkService';
import type { OpenClawEngineStatus } from '@/features/cowork/coworkTypes';

const startingStatus: OpenClawEngineStatus = {
  phase: 'starting',
  version: 'v1',
  message: 'Starting gateway',
  canRetry: false,
};

const runningStatus: OpenClawEngineStatus = {
  phase: 'running',
  version: 'v1',
  message: 'Gateway running',
  canRetry: false,
};

describe('CoworkService OpenClaw status ordering', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not let a stale snapshot overwrite a newer progress event', async () => {
    let resolveSnapshot:
      ((result: { success: true; status: OpenClawEngineStatus }) => void) | undefined;
    let progressListener: ((status: OpenClawEngineStatus) => void) | undefined;
    const getStatus = vi.fn(
      () =>
        new Promise<{ success: true; status: OpenClawEngineStatus }>(resolve => {
          resolveSnapshot = resolve;
        }),
    );
    vi.stubGlobal('window', {
      electron: {
        openclaw: {
          engine: {
            getStatus,
            onProgress: vi.fn((listener: (status: OpenClawEngineStatus) => void) => {
              progressListener = listener;
              return vi.fn();
            }),
          },
        },
      },
    });
    const service = new CoworkService();
    const observed: OpenClawEngineStatus[] = [];
    service.onOpenClawEngineStatus(status => observed.push(status));

    const pendingStatus = service.getOpenClawEngineStatus();
    progressListener?.(runningStatus);
    resolveSnapshot?.({ success: true, status: startingStatus });

    await expect(pendingStatus).resolves.toEqual(runningStatus);
    expect(observed).toEqual([runningStatus]);
    service.destroy();
  });

  it('publishes a snapshot when no newer event arrived', async () => {
    vi.stubGlobal('window', {
      electron: {
        openclaw: {
          engine: {
            getStatus: vi.fn().mockResolvedValue({ success: true, status: startingStatus }),
            onProgress: vi.fn(() => vi.fn()),
          },
        },
      },
    });
    const service = new CoworkService();
    const observed: OpenClawEngineStatus[] = [];
    service.onOpenClawEngineStatus(status => observed.push(status));

    await expect(service.getOpenClawEngineStatus()).resolves.toEqual(startingStatus);
    expect(observed).toEqual([startingStatus]);
    service.destroy();
  });

  it('uses the dedicated start command and keeps a newer failure event', async () => {
    let resolveStart!: (result: { success: boolean; status: OpenClawEngineStatus }) => void;
    const pending = new Promise<{ success: boolean; status: OpenClawEngineStatus }>(resolve => {
      resolveStart = resolve;
    });
    const startGateway = vi.fn(() => pending);
    const restartGateway = vi.fn();
    let progressListener: ((status: OpenClawEngineStatus) => void) | undefined;
    vi.stubGlobal('window', {
      electron: {
        openclaw: {
          engine: {
            startGateway,
            restartGateway,
            onProgress: vi.fn(listener => {
              progressListener = listener;
              return vi.fn();
            }),
          },
        },
      },
    });
    const service = new CoworkService();
    const observed: OpenClawEngineStatus[] = [];
    service.onOpenClawEngineStatus(status => observed.push(status));
    const command = service.startOpenClawGateway();
    const failure: OpenClawEngineStatus = { ...runningStatus, phase: 'error', canRetry: true };
    progressListener?.(failure);
    resolveStart({ success: true, status: runningStatus });

    await expect(command).resolves.toEqual(runningStatus);
    expect(observed).toEqual([failure]);
    expect(startGateway).toHaveBeenCalledOnce();
    expect(restartGateway).not.toHaveBeenCalled();
    service.destroy();
  });

  it('propagates a failed start command so the title bar can display its reason', async () => {
    vi.stubGlobal('window', {
      electron: {
        openclaw: {
          engine: {
            startGateway: vi.fn().mockResolvedValue({
              success: false,
              status: { ...startingStatus, phase: 'ready' },
              error: 'Policy rejected',
            }),
            onProgress: vi.fn(() => vi.fn()),
          },
        },
      },
    });
    const service = new CoworkService();
    await expect(service.startOpenClawGateway()).rejects.toThrow('Policy rejected');
    service.destroy();
  });
});
