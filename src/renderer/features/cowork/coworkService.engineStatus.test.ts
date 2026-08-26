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
});
