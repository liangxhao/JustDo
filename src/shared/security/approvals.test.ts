import { describe, expect, test } from 'vitest';

import {
  ApprovalDecision,
  ApprovalKind,
  canGrantExecApprovalForSession,
  DEFAULT_PERMISSION_MODE,
  ExecApprovalDecision,
  isApprovalDecision,
  isExecApprovalDecision,
  isPermissionMode,
  PermissionMode,
  resolvePermissionMode,
  toOpenClawSessionPermissionMode,
} from './approvals';

describe('OpenClaw approval contracts', () => {
  test('defaults execution permissions to full access', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe(PermissionMode.Full);
    expect(resolvePermissionMode(undefined)).toBe(PermissionMode.Full);
    expect(resolvePermissionMode(null)).toBe(PermissionMode.Full);
    expect(resolvePermissionMode('invalid')).toBe(PermissionMode.Full);
  });

  test.each(Object.values(PermissionMode))('preserves stored permission mode %s', mode => {
    expect(resolvePermissionMode(mode)).toBe(mode);
  });

  test.each(Object.values(PermissionMode))('accepts permission mode %s', mode => {
    expect(isPermissionMode(mode)).toBe(true);
  });

  test.each([
    [PermissionMode.Ask, 'guarded'],
    [PermissionMode.Auto, 'workspace'],
    [PermissionMode.Full, 'full'],
  ] as const)('maps %s to the OpenClaw session mode %s', (mode, expected) => {
    expect(toOpenClawSessionPermissionMode(mode)).toBe(expected);
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
