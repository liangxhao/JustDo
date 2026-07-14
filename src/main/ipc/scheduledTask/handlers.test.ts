import { beforeEach, expect, test, vi } from 'vitest';

import { IpcChannel as ScheduledTaskIpc } from '../../../scheduledTask/constants';
import type { CronJobService } from '../../../scheduledTask/cronJobService';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerScheduledTaskHandlers } from './handlers';

beforeEach(() => {
  handlers.clear();
});

test('loads persisted tasks through the service while the gateway is still connecting', async () => {
  const tasks = [{ id: 'persisted-job' }];
  const listJobs = vi.fn().mockResolvedValue(tasks);

  registerScheduledTaskHandlers({
    getCronJobService: () => ({ listJobs }) as unknown as CronJobService,
    getOpenClawRuntimeAdapter: () =>
      ({
        getGatewayClient: () => null,
        fetchSessionByKey: vi.fn(),
      }),
  });

  const listHandler = handlers.get(ScheduledTaskIpc.List);
  expect(listHandler).toBeDefined();

  await expect(listHandler?.({})).resolves.toEqual({ success: true, tasks });
  expect(listJobs).toHaveBeenCalledOnce();
});
