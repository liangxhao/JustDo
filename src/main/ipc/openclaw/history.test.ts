import { beforeEach, describe, expect, test, vi } from 'vitest';

const { ipcHandle } = vi.hoisted(() => ({ ipcHandle: vi.fn() }));

vi.mock('electron', () => ({
  ipcMain: { handle: ipcHandle },
}));

import { OpenClawHistoryIpc } from '../../../shared/openclaw/historyIpc';
import { normalizeDetailIds, registerOpenClawHistoryHandlers } from './history';

describe('OpenClaw v2026.9.2 history detail IPC', () => {
  beforeEach(() => {
    ipcHandle.mockReset();
  });

  test('bounds and deduplicates detail identifiers', () => {
    expect(normalizeDetailIds([' one ', 'one', '', 2], 'tool call')).toEqual({ ids: ['one'] });
    expect(normalizeDetailIds(Array.from({ length: 251 }, () => 'id'), 'tool call')).toEqual({
      ids: [],
      error: 'Too many tool call IDs',
    });
  });

  test('loads tool inputs through the restricted runtime services', async () => {
    const requestGateway = vi.fn().mockResolvedValue({
      toolInputs: { call_1: { name: 'exec', input: { command: 'pwd' } } },
      compactionDetails: {},
    });
    registerOpenClawHistoryHandlers({ requestGateway });
    const handler = ipcHandle.mock.calls.find(
      ([channel]) => channel === OpenClawHistoryIpc.GetToolInputs,
    )?.[1];

    await expect(
      handler({}, { sessionKey: 'agent:main:justdo:one', toolCallIds: ['call_1'] }),
    ).resolves.toEqual({
      success: true,
      inputs: { call_1: { name: 'exec', input: { command: 'pwd' } } },
    });
    expect(requestGateway).toHaveBeenCalledWith('runtimeServices.historyDetails', {
      sessionKey: 'agent:main:justdo:one',
      toolCallIds: ['call_1'],
    });
  });

  test('loads compaction details through the restricted runtime services', async () => {
    const requestGateway = vi.fn().mockResolvedValue({
      toolInputs: {},
      compactionDetails: { compact_1: { summary: 'handoff', tokensBefore: 100 } },
    });
    registerOpenClawHistoryHandlers({ requestGateway });
    const handler = ipcHandle.mock.calls.find(
      ([channel]) => channel === OpenClawHistoryIpc.GetCompactionDetails,
    )?.[1];

    await expect(
      handler({}, { sessionKey: 'agent:main:justdo:one', entryIds: ['compact_1'] }),
    ).resolves.toEqual({
      success: true,
      details: { compact_1: { summary: 'handoff', tokensBefore: 100 } },
    });
  });

  test('redacts runtime paths from bridge failures', async () => {
    const requestGateway = vi
      .fn()
      .mockRejectedValue(new Error('failed at C:\\Users\\secret\\sessions.db'));
    registerOpenClawHistoryHandlers({ requestGateway });
    const handler = ipcHandle.mock.calls.find(
      ([channel]) => channel === OpenClawHistoryIpc.GetToolInputs,
    )?.[1];

    await expect(
      handler({}, { sessionKey: 'agent:main:justdo:one', toolCallIds: ['call_1'] }),
    ).resolves.toEqual({
      success: false,
      error: 'failed at [path]',
    });
  });
});
