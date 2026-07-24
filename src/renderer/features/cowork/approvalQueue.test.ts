import { ApprovalKind, type ApprovalRequest } from '@shared/openclaw/approvals';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import {
  approvalQueueKey,
  loadPendingApprovalsWithRetry,
  markApprovalResolved,
  reconcilePendingApprovalSnapshot,
  removePendingApproval,
  upsertPendingApproval,
} from './approvalQueue';

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ({
    kind: ApprovalKind.Exec,
    id: 'approval-1',
    request: { command: 'npm test' },
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    ...overrides,
  }) as ApprovalRequest;

describe('approval queue', () => {
  it('retries transient list failures and returns the first successful result', async () => {
    const approval = request();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ success: false, requests: [], error: 'starting' })
      .mockRejectedValueOnce(new Error('transport unavailable'))
      .mockResolvedValueOnce({ success: true, requests: [approval] });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      loadPendingApprovalsWithRetry({ list, wait, delaysMs: [0, 10, 20] }),
    ).resolves.toEqual({ success: true, requests: [approval] });
    expect(list).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 10);
    expect(wait).toHaveBeenNthCalledWith(2, 20);
  });

  it('stops retrying when the caller is cancelled', async () => {
    const list = vi.fn().mockResolvedValue({ success: false, requests: [] });
    const wait = vi.fn().mockResolvedValue(undefined);
    let cancelled = false;

    const result = await loadPendingApprovalsWithRetry({
      list,
      wait: async delayMs => {
        await wait(delayMs);
        cancelled = true;
      },
      isCancelled: () => cancelled,
      delaysMs: [0, 10],
    });

    expect(result).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('does not re-add a resolved request from a stale list snapshot', () => {
    const tombstones = new Map<string, number>();
    const approval = request();
    markApprovalResolved(tombstones, approval, 2_000);

    expect(upsertPendingApproval([], approval, tombstones, 3_000)).toEqual([]);
  });

  it('does not enqueue an expired approval', () => {
    expect(upsertPendingApproval([], request(), new Map(), 10_000)).toEqual([]);
  });

  it('keys exec and plugin approvals independently', () => {
    const exec = request();
    const plugin = request({
      kind: ApprovalKind.Plugin,
      request: { title: 'Edit', description: 'x' },
    });

    expect(approvalQueueKey(exec)).not.toBe(approvalQueueKey(plugin));
  });

  it('removes only the matching kind and id', () => {
    const exec = request();
    const plugin = request({
      kind: ApprovalKind.Plugin,
      request: { title: 'Edit', description: 'x' },
    });

    expect(removePendingApproval([exec, plugin], exec)).toEqual([plugin]);
  });

  it('treats a Gateway snapshot as authoritative while preserving resolved tombstones', () => {
    const stale = request({ id: 'stale', createdAtMs: 500 });
    const pending = request({ id: 'pending', createdAtMs: 1_500 });
    const resolved = request({ id: 'resolved', createdAtMs: 1_000 });
    const tombstones = new Map<string, number>();
    markApprovalResolved(tombstones, resolved, 2_000);

    expect(reconcilePendingApprovalSnapshot([pending, resolved], tombstones, 3_000)).toEqual([
      pending,
    ]);
    expect(reconcilePendingApprovalSnapshot([stale], tombstones, 3_000)).toEqual([stale]);
  });
});
