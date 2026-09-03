import { beforeEach, describe, expect, test, vi } from 'vitest';

const { ipcHandle } = vi.hoisted(() => ({ ipcHandle: vi.fn() }));

vi.mock('electron', () => ({
  ipcMain: { handle: ipcHandle },
}));

import { OpenClawHistoryIpc } from '../../../shared/openclaw/historyIpc';
import {
  decodeHistoryOffsetCursor,
  encodeHistoryOffsetCursor,
  normalizeDetailIds,
  registerOpenClawHistoryHandlers,
} from './history';

describe('OpenClaw v2026.8.2 history IPC', () => {
  beforeEach(() => {
    ipcHandle.mockReset();
  });

  test('encodes only bounded opaque offset cursors', () => {
    expect(encodeHistoryOffsetCursor(42)).toBe('offset:42');
    expect(decodeHistoryOffsetCursor('offset:42')).toBe(42);
    expect(decodeHistoryOffsetCursor(undefined)).toBeUndefined();
    expect(() => decodeHistoryOffsetCursor('../sessions.json')).toThrow('Invalid history cursor');
  });

  test('bounds and deduplicates detail identifiers', () => {
    expect(normalizeDetailIds([' one ', 'one', '', 2], 'tool call')).toEqual({ ids: ['one'] });
    expect(normalizeDetailIds(Array.from({ length: 251 }, () => 'id'), 'tool call')).toEqual({
      ids: [],
      error: 'Too many tool call IDs',
    });
  });

  test('uses native chat.history pagination instead of runtime files or REST', async () => {
    const requestGateway = vi.fn().mockResolvedValue({
      messages: [{ role: 'assistant', content: 'recent' }],
      hasMore: true,
      nextOffset: 30,
    });
    registerOpenClawHistoryHandlers({ requestGateway });
    const handler = ipcHandle.mock.calls.find(
      ([channel]) => channel === OpenClawHistoryIpc.GetPagedHistory,
    )?.[1];

    await expect(
      handler({}, { sessionKey: 'agent:main:justdo:one', cursor: 'offset:10', limit: 20 }),
    ).resolves.toEqual({
      success: true,
      messages: [{ role: 'assistant', content: 'recent' }],
      hasMore: true,
      nextCursor: 'offset:30',
    });
    expect(requestGateway).toHaveBeenCalledWith('chat.history', {
      sessionKey: 'agent:main:justdo:one',
      offset: 10,
      limit: 20,
    });
  });

  test('loads tool inputs through the restricted runtime bridge', async () => {
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
    expect(requestGateway).toHaveBeenCalledWith('justdoRuntimeBridge.historyDetails', {
      sessionKey: 'agent:main:justdo:one',
      toolCallIds: ['call_1'],
    });
  });

  test('loads compaction details through the restricted runtime bridge', async () => {
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

  test('rejects malformed v2026.8.2 wire responses and redacts paths', async () => {
    const requestGateway = vi
      .fn()
      .mockRejectedValue(new Error('failed at C:\\Users\\secret\\sessions.db'));
    registerOpenClawHistoryHandlers({ requestGateway });
    const handler = ipcHandle.mock.calls.find(
      ([channel]) => channel === OpenClawHistoryIpc.GetPagedHistory,
    )?.[1];

    await expect(handler({}, { sessionKey: 'agent:main:justdo:one' })).resolves.toEqual({
      success: false,
      error: 'failed at [path]',
    });
  });
});
