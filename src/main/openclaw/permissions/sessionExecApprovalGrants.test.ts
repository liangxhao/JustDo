import { describe, expect, it } from 'vitest';

import type { ExecApprovalRequest } from '../../../shared/openclaw/approvals';
import {
  buildSessionExecApprovalFingerprint,
  SessionExecApprovalGrants,
} from './sessionExecApprovalGrants';

const request = (
  overrides: Partial<ExecApprovalRequest['request']> = {},
): ExecApprovalRequest => ({
  id: 'approval-1',
  createdAtMs: 1,
  expiresAtMs: Date.now() + 60_000,
  request: {
    command: 'git status',
    commandArgv: ['git', 'status'],
    cwd: 'E:/workspace/project',
    host: 'gateway',
    agentId: 'main',
    sessionKey: 'agent:main:justdo:session-1',
    envKeys: ['PATH', 'CI'],
    systemRunBinding: { envHash: 'env-hash-1' },
    systemRunPlan: { mutableFileOperand: { path: 'script.ps1', sha256: 'hash-1' } },
    resolvedPath: 'C:/Program Files/Git/cmd/git.exe',
    security: 'allowlist',
    ask: 'on-miss',
    ...overrides,
  },
});

describe('SessionExecApprovalGrants', () => {
  it('matches the same command context in the same session', () => {
    const grants = new SessionExecApprovalGrants();
    const original = request();

    expect(grants.grant(original)).toBe(true);
    expect(grants.matches(request({ envKeys: ['CI', 'PATH'] }))).toBe(true);
  });

  it.each([
    { sessionKey: 'agent:main:justdo:session-2' },
    { command: 'git push' },
    { commandArgv: ['git', 'status', '--short'] },
    { cwd: 'E:/workspace/other' },
    { host: 'sandbox' },
    { agentId: 'helper' },
    { security: 'full' },
    { ask: 'always' },
    { resolvedPath: 'C:/other/git.exe' },
    { systemRunBinding: { envHash: 'env-hash-2' } },
    { systemRunPlan: { mutableFileOperand: { path: 'script.ps1', sha256: 'hash-2' } } },
  ])('does not broaden a grant for a changed execution context: %o', override => {
    const grants = new SessionExecApprovalGrants();
    grants.grant(request());

    expect(grants.matches(request(override))).toBe(false);
  });

  it('clears all grants for a deleted session', () => {
    const grants = new SessionExecApprovalGrants();
    grants.grant(request());

    grants.clearSession('agent:main:justdo:session-1');

    expect(grants.matches(request())).toBe(false);
  });

  it('rejects requests without a trustworthy session and command identity', () => {
    expect(buildSessionExecApprovalFingerprint(request({ sessionKey: null }))).toBeNull();
    expect(
      buildSessionExecApprovalFingerprint(request({ command: undefined, commandArgv: [] })),
    ).toBeNull();
    expect(
      buildSessionExecApprovalFingerprint(request({ envKeys: ['TOKEN'], systemRunBinding: null })),
    ).toBeNull();
  });

  it('compares execution strings exactly without trimming', () => {
    const grants = new SessionExecApprovalGrants();
    grants.grant(request());

    expect(grants.matches(request({ command: 'git status ' }))).toBe(false);
    expect(grants.matches(request({ cwd: 'E:/workspace/project ' }))).toBe(false);
  });
});
