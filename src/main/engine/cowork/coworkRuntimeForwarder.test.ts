import { EventEmitter } from 'node:events';

import { beforeEach, expect, test, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
  },
}));
vi.mock('../../providers/providerApiConfig', () => ({ resolveCurrentApiConfig: vi.fn() }));

import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from './coworkEngineRouter';
import { bindCoworkRuntimeForwarder } from './coworkRuntimeForwarder';

beforeEach(() => vi.clearAllMocks());

test.each(['user', 'other'] as const)(
  'persists %s activity before a renderer can refresh the session list',
  kind => {
    const runtime = new EventEmitter();
    const session = { id: 'history', updatedAt: 1 };
    const recordSessionActivity = (id: string, timestamp: number) => {
      if (id === session.id) session.updatedAt = Math.max(session.updatedAt, timestamp);
    };
    bindCoworkRuntimeForwarder(
      runtime as CoworkEngineRouter,
      () => ({ recordSessionActivity }) as CoworkStore,
    );
    const refreshedTimes: number[] = [];
    send.mockImplementation(() => refreshedTimes.push(session.updatedAt));

    runtime.emit('activity', session.id, kind, 2);

    expect(refreshedTimes).toEqual([2]);
    expect(send).toHaveBeenCalledWith('cowork:session:activity', {
      sessionId: session.id,
      kind,
      timestamp: 2,
    });
  },
);
