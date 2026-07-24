import { describe, expect, test } from 'vitest';

import {
  ApprovalDecision,
  ApprovalKind,
  canGrantExecApprovalForSession,
  ExecApprovalDecision,
  isApprovalDecision,
  isExecApprovalDecision,
  isPermissionMode,
  PermissionMode,
} from './approvals';

describe('OpenClaw approval contracts', () => {
  test.each(Object.values(PermissionMode))('accepts permission mode %s', mode => {
    expect(isPermissionMode(mode)).toBe(true);
  });

  test.each(Object.values(ExecApprovalDecision))('accepts exec decision %s', decision => {
    expect(isExecApprovalDecision(decision)).toBe(true);
  });

  test.each(Object.values(ApprovalDecision))('accepts product decision %s', decision => {
    expect(isApprovalDecision(decision)).toBe(true);
  });

  test('rejects unknown values', () => {
    expect(isPermissionMode('allowlist')).toBe(false);
    expect(isExecApprovalDecision('approve')).toBe(false);
    expect(isApprovalDecision(ExecApprovalDecision.AllowAlways)).toBe(false);
  });

  test('requires a bound execution identity for a session grant', () => {
    const base = {
      id: 'approval-1',
      kind: ApprovalKind.Exec,
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { command: 'git status', sessionKey: 'agent:main:justdo:session-1' },
    } as const;

    expect(canGrantExecApprovalForSession(base)).toBe(true);
    expect(
      canGrantExecApprovalForSession({
        ...base,
        request: { ...base.request, envKeys: ['TOKEN'] },
      }),
    ).toBe(false);
  });
});
