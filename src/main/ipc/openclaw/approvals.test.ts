import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import {
  ApprovalDecision,
  ApprovalKind,
  ExecApprovalDecision,
  OpenClawApprovalIpc,
} from '../../../shared/openclaw/approvals';
import { registerOpenClawApprovalHandlers } from './approvals';

describe('OpenClaw approval IPC', () => {
  const listPendingApprovals = vi.fn();
  const resolveApproval = vi.fn();

  beforeEach(() => {
    handlers.clear();
    listPendingApprovals.mockReset();
    resolveApproval.mockReset();
    registerOpenClawApprovalHandlers({
      getRuntime: () => ({ listPendingApprovals, resolveApproval } as never),
    });
  });

  it('lists and tags exec and plugin approvals', async () => {
    listPendingApprovals.mockResolvedValue([
      {
        id: 'plugin-1',
        kind: ApprovalKind.Plugin,
        request: { title: 'Edit', description: 'a.ts' },
        createdAtMs: 1,
        expiresAtMs: 20,
      },
      {
        id: 'exec-1',
        kind: ApprovalKind.Exec,
        request: { command: 'npm test' },
        createdAtMs: 2,
        expiresAtMs: 20,
      },
    ]);

    const result = await handlers.get(OpenClawApprovalIpc.List)?.({});

    expect(result).toMatchObject({
      success: true,
      requests: [
        { id: 'plugin-1', kind: ApprovalKind.Plugin },
        { id: 'exec-1', kind: ApprovalKind.Exec },
      ],
    });
  });

  it.each([
    [ApprovalKind.Exec, 'exec.approval.resolve'],
    [ApprovalKind.Plugin, 'plugin.approval.resolve'],
  ] as const)('routes %s decisions through the runtime broker', async (kind, _method) => {
    resolveApproval.mockResolvedValue(undefined);

    const result = await handlers.get(OpenClawApprovalIpc.Resolve)?.({}, {
      id: 'approval-1',
      kind,
      decision: ExecApprovalDecision.AllowOnce,
    });

    expect(result).toEqual({ success: true });
    expect(resolveApproval).toHaveBeenCalledWith(
      'approval-1',
      ExecApprovalDecision.AllowOnce,
      kind,
    );
  });

  it('accepts a session-scoped command grant', async () => {
    const result = await handlers.get(OpenClawApprovalIpc.Resolve)?.({}, {
      id: 'approval-1',
      kind: ApprovalKind.Exec,
      decision: ApprovalDecision.AllowForSession,
    });

    expect(result).toEqual({ success: true });
    expect(resolveApproval).toHaveBeenCalledWith(
      'approval-1',
      ApprovalDecision.AllowForSession,
      ApprovalKind.Exec,
    );
  });

  it('rejects an invalid kind without calling the Gateway', async () => {
    const result = await handlers.get(OpenClawApprovalIpc.Resolve)?.({}, {
      id: 'approval-1',
      kind: 'other',
      decision: ExecApprovalDecision.AllowOnce,
    });

    expect(result).toEqual({ success: false, error: 'Invalid approval decision.' });
    expect(resolveApproval).not.toHaveBeenCalled();
  });
});
