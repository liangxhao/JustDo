import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, test, vi } from 'vitest';

import { WorktreeCleanupState } from '../../../shared/openclaw/worktrees';
import { t } from '../../core/i18n';
import { WorktreeCleanupCoordinator } from './worktreeCleanup';

const receipt = (state: string, extra = {}) => ({
  jobId: 'native-job-1',
  state,
  removed: [],
  orphansDeleted: 0,
  snapshotsPruned: 0,
  ...extra,
});

const fixture = (responses: unknown[] = []) => {
  let generation = 1;
  let running = true;
  let manager = {};
  let clock = 0;
  const request = vi.fn(async (_params: { jobId?: string }): Promise<unknown> => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const coordinator = new WorktreeCleanupCoordinator({
    request,
    owner: () => ({ manager, generation, running }),
    now: () => clock,
    wait: async milliseconds => {
      clock += milliseconds;
    },
    timeoutMs: 1_500,
  });
  return {
    coordinator,
    request,
    rotate: () => {
      generation += 1;
    },
    replace: () => {
      manager = {};
    },
    stop: () => {
      running = false;
    },
  };
};

describe('native Worktree maintenance receipt custody', () => {
  test.skipIf(!process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR && process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED !== '1')(
    'consumes actual admitted native maintenance receipts',
    async () => {
      if (!process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR) {
        throw new Error('OPENCLAW_TEST_NATIVE_RUNTIME_DIR is required for the native Worktree contract');
      }
      const runtime = path.resolve(process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR);
      const executable = path.join(
        runtime,
        'node-runtime',
        process.platform === 'win32' ? 'node.exe' : 'node',
      );
      const { stdout: output } = await promisify(execFile)(
        executable,
        [
          path.resolve('tests/openclaw/runtime/worktree-maintenance-receipts.native-probe.mjs'),
          runtime,
        ],
        {
          encoding: 'utf8',
          timeout: 60_000,
          windowsHide: true,
          env: Object.fromEntries(
            Object.entries(process.env).filter(([name]) => {
              const upper = name.toUpperCase();
              return (
                !upper.startsWith('OPENCLAW_') &&
                !['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(upper)
              );
            }),
          ),
        },
      );
      const line = output
        .split(/\r?\n/)
        .find(value => value.startsWith('NATIVE_WORKTREE_RECEIPTS='));
      expect(line).toBeTruthy();
      const native = JSON.parse(line!.slice('NATIVE_WORKTREE_RECEIPTS='.length)) as {
        cases: {
          mode: string;
          queued: unknown;
          running: unknown;
          terminal: unknown;
          executions: number;
        }[];
      };
      expect(native.cases.map(value => value.mode)).toEqual(['completed', 'failed']);
      for (const row of native.cases) {
        const f = fixture([row.queued, row.running, row.terminal]);
        if (row.mode === 'completed') {
          await expect(f.coordinator.clean()).resolves.toMatchObject({
            state: 'completed',
            removed: ['native-fixture-tree'],
          });
        } else {
          await expect(f.coordinator.clean()).rejects.toThrow(
            'Native fixture maintenance rejected',
          );
        }
        expect(row.executions).toBe(1);
        expect(f.request.mock.calls.filter(([params]) => !params.jobId)).toHaveLength(1);
      }
    },
    90_000,
  );
  test('waits for queued/running/completed and only queries the admitted job', async () => {
    const f = fixture([
      receipt('queued'),
      receipt('running'),
      receipt('completed', { removed: ['native-tree'], snapshotsPruned: 2 }),
    ]);
    await expect(f.coordinator.clean()).resolves.toEqual({
      jobId: 'native-job-1',
      state: WorktreeCleanupState.Completed,
      removed: ['native-tree'],
      orphansDeleted: 0,
      snapshotsPruned: 2,
    });
    expect(f.request.mock.calls).toEqual([
      [{}],
      [{ jobId: 'native-job-1' }],
      [{ jobId: 'native-job-1' }],
    ]);
  });

  test('shares one in-flight observation across windows', async () => {
    const f = fixture([receipt('completed')]);
    const first = f.coordinator.clean();
    const second = f.coordinator.clean();
    expect(second).toBe(first);
    await first;
    expect(f.request).toHaveBeenCalledOnce();
  });

  test('reports a native failed receipt and permits a later explicit new job', async () => {
    const f = fixture([
      receipt('failed', { error: 'Native cleanup stopped because configuration changed' }),
      receipt('completed', { jobId: 'native-job-2' }),
    ]);
    await expect(f.coordinator.clean()).rejects.toThrow('Native cleanup stopped');
    await expect(f.coordinator.clean()).resolves.toMatchObject({ jobId: 'native-job-2' });
    expect(f.request.mock.calls).toEqual([[{}], [{}]]);
  });

  test('retains a timed-out job and subsequent checking cannot submit another cleanup', async () => {
    const f = fixture([
      receipt('queued'),
      receipt('running'),
      receipt('running'),
      receipt('completed'),
    ]);
    await expect(f.coordinator.clean()).rejects.toThrow(t('worktreeCleanupUnconfirmed'));
    await expect(f.coordinator.clean()).resolves.toMatchObject({ state: 'completed' });
    expect(f.request.mock.calls.filter(([params]) => !params.jobId)).toHaveLength(1);
    expect(f.request.mock.calls.slice(1).every(([params]) => params.jobId === 'native-job-1')).toBe(
      true,
    );
  });

  test('retains an admitted job after a query disconnect', async () => {
    const f = fixture([receipt('queued'), new Error('gateway closed'), receipt('completed')]);
    await expect(f.coordinator.clean()).rejects.toThrow(t('worktreeCleanupUnconfirmed'));
    await expect(f.coordinator.clean()).resolves.toMatchObject({ state: 'completed' });
    expect(f.request.mock.calls).toEqual([
      [{}],
      [{ jobId: 'native-job-1' }],
      [{ jobId: 'native-job-1' }],
    ]);
  });

  test('never resubmits an uncertain first request without a received job ID', async () => {
    const f = fixture([new Error('reply lost'), receipt('completed')]);
    await expect(f.coordinator.clean()).rejects.toThrow(t('worktreeCleanupUnconfirmed'));
    await expect(f.coordinator.clean()).rejects.toThrow(t('worktreeCleanupUnconfirmed'));
    expect(f.request).toHaveBeenCalledOnce();
  });

  test.each(['rotate', 'replace', 'stop'] as const)(
    'rejects %s during a request and retains unknown custody',
    async action => {
      const f = fixture();
      f.request.mockImplementationOnce(async () => {
        f[action]();
        return receipt('completed');
      });
      await expect(f.coordinator.clean()).rejects.toThrow(t('worktreeCleanupUnconfirmed'));
      await expect(f.coordinator.clean()).rejects.toThrow();
      expect(f.request).toHaveBeenCalledOnce();
    },
  );

  test('rejects another job ID without consuming or replacing the original job', async () => {
    const f = fixture([
      receipt('queued'),
      receipt('completed', { jobId: 'other-job' }),
      receipt('completed'),
    ]);
    await expect(f.coordinator.clean()).rejects.toThrow(t('worktreeCleanupUnconfirmed'));
    await expect(f.coordinator.clean()).resolves.toMatchObject({ jobId: 'native-job-1' });
    expect(f.request.mock.calls.slice(1)).toEqual([
      [{ jobId: 'native-job-1' }],
      [{ jobId: 'native-job-1' }],
    ]);
  });

  test.each([
    { removed: [], orphansDeleted: 0, snapshotsPruned: 0 },
    receipt('idle'),
    receipt('completed', { jobId: '' }),
    receipt('completed', { orphansDeleted: -1 }),
    receipt('completed', { removed: [false] }),
  ])('rejects a historical or malformed receipt without a new submission', async value => {
    const f = fixture([value]);
    await expect(f.coordinator.clean()).rejects.toThrow(t('worktreeCleanupUnconfirmed'));
    await expect(f.coordinator.clean()).rejects.toThrow(t('worktreeCleanupUnconfirmed'));
    expect(f.request).toHaveBeenCalledOnce();
  });
});
