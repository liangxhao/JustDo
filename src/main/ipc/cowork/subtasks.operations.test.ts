import { beforeEach, expect, it, vi } from 'vitest';

import { CoworkSubagentDetailsIpc } from '../../../shared/cowork/subagentDetails';
import type { OpenClawRuntimeAdapter } from '../../engine';
const mocks = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
import { registerCoworkSubtaskHandlers } from './subtasks';
beforeEach(() => mocks.handle.mockReset());
it.each([CoworkSubagentDetailsIpc.Control, CoworkSubagentDetailsIpc.ListChildren])(
  'rejects deleted product sessions before native access for %s',
  async channel => {
    const getRuntime = vi.fn();
    registerCoworkSubtaskHandlers({ getRuntime, hasSession: () => false });
    const handler = mocks.handle.mock.calls.find(call => call[0] === channel)![1];
    await expect(handler({}, 'deleted-session', 'task-one', 'cancel')).resolves.toEqual({
      success: false,
      error: 'Product session was not found',
    });
    expect(getRuntime).not.toHaveBeenCalled();
  },
);
it('rejects invalid task operations without sending a native mutation', async () => {
  const request = vi.fn();
  const runtime = {
    getGatewayClient: () => ({ request }),
    getSessionKeysForSession: () => ['root'],
  } as unknown as OpenClawRuntimeAdapter;
  registerCoworkSubtaskHandlers({ getRuntime: () => runtime, hasSession: () => true });
  const handler = mocks.handle.mock.calls.find(
    call => call[0] === CoworkSubagentDetailsIpc.Control,
  )![1];
  await expect(handler({}, 'session', 'task-one', 'rerun')).resolves.toEqual({
    success: false,
    error: 'Unknown subagent operation',
  });
  expect(request).not.toHaveBeenCalled();
});
