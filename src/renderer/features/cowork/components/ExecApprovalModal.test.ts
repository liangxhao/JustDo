import {
  ApprovalDecision,
  ApprovalKind,
  type ApprovalRequest,
  ExecApprovalDecision,
} from '@shared/openclaw/approvals';
import { describe, expect, it } from 'vitest';

import {
  resolveAllowedDecisions,
  resolveApprovalDeadline,
  resolveApprovalSummary,
} from './ExecApprovalModal';

const approval = (request: Record<string, unknown>): ApprovalRequest => ({
  id: 'approval-1',
  kind: ApprovalKind.Exec,
  request: {
    command: 'git status',
    sessionKey: 'agent:main:justdo:session-1',
    ...request,
  },
  createdAtMs: 1,
  expiresAtMs: Date.now() + 60_000,
});

describe('resolveAllowedDecisions', () => {
  it('treats an empty Gateway decision list as unspecified for compatibility', () => {
    expect(resolveAllowedDecisions(approval({ allowedDecisions: [] }))).toEqual([
      ApprovalDecision.AllowOnce,
      ApprovalDecision.AllowForSession,
      ApprovalDecision.Deny,
    ]);
  });

  it('never exposes the Gateway persistent allow-always decision', () => {
    expect(
      resolveAllowedDecisions(
        approval({
          allowedDecisions: [
            ExecApprovalDecision.AllowOnce,
            ExecApprovalDecision.AllowAlways,
            ExecApprovalDecision.Deny,
          ],
        }),
      ),
    ).not.toContain(ExecApprovalDecision.AllowAlways);
  });

  it('hides session approval when environment values are not bound', () => {
    expect(
      resolveAllowedDecisions(approval({ envKeys: ['TOKEN'], systemRunBinding: null })),
    ).not.toContain(ApprovalDecision.AllowForSession);
  });
});

describe('resolveApprovalSummary', () => {
  it('shows the actual command without the working directory for exec approvals', () => {
    expect(
      resolveApprovalSummary(
        approval({
          command: 'git status --short',
          commandPreview: 'git status',
          cwd: 'E:/project',
        }),
      ),
    ).toBe('git status --short');
  });

  it('combines the file operation and target into one line', () => {
    const request: ApprovalRequest = {
      id: 'approval-2',
      kind: ApprovalKind.Plugin,
      request: {
        pluginId: 'file-permission-policy',
        title: 'Allow file changes?',
        description: 'C:/project/report.md',
        toolName: 'write',
      },
      createdAtMs: 1,
      expiresAtMs: Date.now() + 60_000,
    };

    expect(resolveApprovalSummary(request)).toBe('write C:/project/report.md');
  });
});

describe('resolveApprovalDeadline', () => {
  it('does not expose a countdown or expire persistent approvals', () => {
    expect(resolveApprovalDeadline(Number.MAX_SAFE_INTEGER, Date.now())).toEqual({
      remainingSeconds: null,
      expired: false,
    });
  });

  it('keeps countdown behavior for finite approvals', () => {
    expect(resolveApprovalDeadline(61_000, 1_000)).toEqual({
      remainingSeconds: 60,
      expired: false,
    });
    expect(resolveApprovalDeadline(1_000, 1_000)).toEqual({
      remainingSeconds: 0,
      expired: true,
    });
  });
});
