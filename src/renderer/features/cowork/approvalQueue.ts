import type { ApprovalRequest } from '@shared/openclaw/approvals';

type ApprovalListResult = {
  success: boolean;
  requests: ApprovalRequest[];
  error?: string;
};

export const loadPendingApprovalsWithRetry = async (options: {
  list: () => Promise<ApprovalListResult>;
  wait: (delayMs: number) => Promise<void>;
  isCancelled?: () => boolean;
  delaysMs?: number[];
}): Promise<ApprovalListResult | null> => {
  let lastResult: ApprovalListResult = { success: false, requests: [] };
  for (const delayMs of options.delaysMs ?? [0, 500, 1_500]) {
    if (delayMs > 0) await options.wait(delayMs);
    if (options.isCancelled?.()) return null;
    try {
      lastResult = await options.list();
    } catch (error) {
      lastResult = { success: false, requests: [], error: String(error) };
    }
    if (lastResult.success) return lastResult;
  }
  return lastResult;
};

export const APPROVAL_TOMBSTONE_TTL_MS = 10 * 60 * 1000;

export const approvalQueueKey = (approval: Pick<ApprovalRequest, 'id' | 'kind'>): string =>
  `${approval.kind}:${approval.id}`;

export const markApprovalResolved = (
  tombstones: Map<string, number>,
  approval: Pick<ApprovalRequest, 'id' | 'kind'>,
  now = Date.now(),
): void => {
  tombstones.set(approvalQueueKey(approval), now);
};

export const upsertPendingApproval = (
  queue: ApprovalRequest[],
  request: ApprovalRequest,
  tombstones: Map<string, number>,
  now = Date.now(),
): ApprovalRequest[] => {
  for (const [key, resolvedAt] of tombstones) {
    if (now - resolvedAt > APPROVAL_TOMBSTONE_TTL_MS) tombstones.delete(key);
  }
  if (
    !request.id ||
    !request.request ||
    !Number.isFinite(request.expiresAtMs) ||
    request.expiresAtMs <= now ||
    tombstones.has(approvalQueueKey(request))
  ) {
    return queue;
  }
  const key = approvalQueueKey(request);
  return [...queue.filter(item => approvalQueueKey(item) !== key), request].sort(
    (a, b) => a.createdAtMs - b.createdAtMs,
  );
};

export const removePendingApproval = (
  queue: ApprovalRequest[],
  approval: Pick<ApprovalRequest, 'id' | 'kind'>,
): ApprovalRequest[] => {
  const key = approvalQueueKey(approval);
  return queue.filter(item => approvalQueueKey(item) !== key);
};

export const reconcilePendingApprovalSnapshot = (
  requests: ApprovalRequest[],
  tombstones: Map<string, number>,
  now = Date.now(),
): ApprovalRequest[] => {
  return requests.reduce<ApprovalRequest[]>(
    (queue, request) => upsertPendingApproval(queue, request, tombstones, now),
    [],
  );
};
