import { describe, expect, it, vi } from 'vitest';

import { ApprovalKind, type ApprovalRequest } from '../../../shared/security/approvals';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { ExternalApprovalSessionScope } from './externalApprovalSessionScope';

const fixture = () => {
  const client = { request: vi.fn() } as unknown as GatewayClientLike;
  const binding = { sessionKey: 'key', sessionId: 'physical', lifecycleRevision: 'revision', client,
    clientGeneration: 1, isCurrent: () => true, runId: 'run' };
  const request: ApprovalRequest = { kind: ApprovalKind.Exec, id: 'approval', createdAtMs: 1, expiresAtMs: Date.now() + 60_000,
    request: { sessionKey: binding.sessionKey, sessionId: binding.sessionId, runId: 'run', command: 'read file',
      cwd: '/task', allowedDecisions: ['allow-once', 'deny'] } };
  return { binding, request };
};

describe('external connection approval session grants', () => {
  it('reuses only the exact command context and clears grants on explicit scope closure', () => {
    const h = fixture();
    const scope = new ExternalApprovalSessionScope();
    expect(scope.grant(h.binding, h.request)).toBe(true);
    expect(scope.matches(h.binding, h.request)).toBe(true);
    expect(scope.matches(h.binding, { ...h.request, request: { ...h.request.request, command: 'read another-file' } })).toBe(false);
    expect(scope.matches(h.binding, h.request)).toBe(true);
    scope.close();
    expect(scope.matches(h.binding, h.request)).toBe(false);
    expect(scope.grant(h.binding, h.request)).toBe(false);
  });

  it.each(['sessionId', 'lifecycleRevision', 'clientGeneration', 'client'] as const)(
    'does not carry grants across a changed %s', changed => {
      const h = fixture();
      const scope = new ExternalApprovalSessionScope();
      scope.grant(h.binding, h.request);
      const replacement = { ...h.binding, [changed]: changed === 'clientGeneration' ? 2 : changed === 'client' ? {} : 'replacement' };
      expect(scope.matches(replacement as typeof h.binding, h.request)).toBe(false);
      expect(scope.matches(h.binding, h.request)).toBe(false);
    },
  );

  it('revokes on disconnect and refuses unbound environment values or missing native generation proof', () => {
    const h = fixture();
    const disconnected = new AbortController();
    const scope = new ExternalApprovalSessionScope(disconnected.signal);
    scope.grant(h.binding, h.request);
    disconnected.abort();
    expect(scope.matches(h.binding, h.request)).toBe(false);
    const fresh = new ExternalApprovalSessionScope();
    expect(fresh.canGrant(h.binding, { ...h.request, request: { ...h.request.request, envKeys: ['SECRET'] } })).toBe(false);
    expect(fresh.canGrant({ ...h.binding, clientGeneration: undefined }, h.request)).toBe(false);
    expect(fresh.canGrant({ ...h.binding, isCurrent: () => false }, h.request)).toBe(false);
  });

  it('does not fill a missing approval incarnation from its prepared owner', () => {
    const h = fixture();
    const scope = new ExternalApprovalSessionScope();
    const missing = { ...h.request, request: { ...h.request.request, sessionId: undefined } };
    expect(scope.canGrant(h.binding, missing)).toBe(false);
    expect(scope.grant(h.binding, missing)).toBe(false);
    expect(scope.grant(h.binding, h.request)).toBe(true);
    expect(scope.matches(h.binding, missing)).toBe(false);
    scope.close();
  });
});
