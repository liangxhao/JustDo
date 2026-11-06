import { describe, expect, it, vi } from 'vitest';

import { ApprovalKind, type ApprovalRequest } from '../../shared/security/approvals';
import type { AppServerConnectionContext } from '../appServer/appServerProtocol';
import type { GatewayClientLike } from '../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../engine/openclaw/openclawRuntimeAdapter';
import { ExternalApprovalRouting } from '../openclaw/permissions/externalApprovalRouting';
import { ChromeAppServerApprovals } from './chromeAppServerApprovals';

function fixture() {
  const row = { key: 'native-key', sessionId: 'native-session', lifecycleRevision: 'revision' };
  let generation = 3;
  let sourceCurrent = true;
  const nativeRequest = vi.fn(async (method: string) => method === 'sessions.describe' ? { session: row } : {});
  const client = { request: nativeRequest } as unknown as GatewayClientLike;
  const routing = new ExternalApprovalRouting(() => client);
  const runtime = { getGatewayClient: () => client, getGatewayClientGeneration: () => generation,
    claimExternalApprovalOwner: routing.claim.bind(routing) } as unknown as OpenClawRuntimeAdapter;
  const request = vi.fn<NonNullable<AppServerConnectionContext['request']>>(async () => ({ decision: 'accept' }));
  const signal = new AbortController();
  const owner = new ChromeAppServerApprovals({
    getRuntime: () => runtime,
    context: { notify: vi.fn(), isClosed: () => false, request, isExperimentalApiEnabled: () => true },
    expected: { sessionKey: row.key, nativeSessionId: row.sessionId, clientGeneration: generation },
    signal: signal.signal, threadId: 'browser-thread', turnId: 'logical-turn', isCurrent: () => sourceCurrent,
  });
  const binding = { sessionKey: row.key, nativeSessionId: row.sessionId, lifecycleRevision: row.lifecycleRevision, clientGeneration: generation };
  const native: ApprovalRequest = { id: 'approval', kind: ApprovalKind.Exec, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    request: { sessionKey: row.key, sessionId: row.sessionId, runId: 'actual-root', command: 'read file', allowedDecisions: ['allow-once', 'deny'] } };
  return { owner, binding, row, routing, request, nativeRequest, native, signal,
    accept: () => owner.accepted({ ...binding, clientTurnId: 'logical-turn', nativeRunId: 'actual-root' }),
    replace: () => { generation += 1; }, replaceSource: () => { sourceCurrent = false; } };
}

describe('browser exact approval ownership', () => {
  it('waits for the native ACK and uses a distinct logical turn on the standard wire', async () => {
    const h = fixture();
    h.owner.prepare(h.binding);
    expect(h.routing.route(h.native)).toBe(true);
    await Promise.resolve();
    expect(h.request).not.toHaveBeenCalled();
    h.accept();
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledWith('exec.approval.resolve', { id: h.native.id, decision: 'allow-once' }));
    expect(h.request).toHaveBeenCalledWith('item/commandExecution/requestApproval',
      expect.objectContaining({ threadId: 'browser-thread', turnId: 'logical-turn' }), expect.anything());
    expect(JSON.stringify(h.request.mock.calls)).not.toContain('actual-root');
    h.owner.release();
  });

  it('keeps withdrawn ownership exclusive and denies late acceptance without aborting execution', async () => {
    const h = fixture();
    let reply!: (value: unknown) => void;
    h.request.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
    h.owner.prepare(h.binding);
    h.accept();
    h.routing.route(h.native);
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
    h.signal.abort();
    reply({ decision: 'accept' });
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledWith('exec.approval.resolve', { id: h.native.id, decision: 'deny' }));
    expect(h.routing.owns(h.native)).toBe(true);
    expect(h.nativeRequest.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
    h.owner.release();
    expect(h.routing.owns(h.native)).toBe(false);
  });

  it('implements explicit cancel only for the captured native run and retains ownership after the Stop ACK', async () => {
    const h = fixture();
    h.request.mockResolvedValue({ decision: 'cancel' });
    h.owner.prepare(h.binding);
    h.accept();
    h.routing.route(h.native);
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledWith('sessions.abort', { key: h.row.key, runId: 'actual-root' }));
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledWith('exec.approval.resolve', { id: h.native.id, decision: 'deny' }));
    expect(h.routing.owns(h.native)).toBe(true);
    h.owner.release();
  });

  it('denies promptly while cancellation still waits for its fresh native identity read', async () => {
    const h = fixture();
    let completeRead!: (value: unknown) => void;
    let descriptions = 0;
    h.nativeRequest.mockImplementation(async method => {
      if (method !== 'sessions.describe') return {};
      if (++descriptions === 2) return new Promise(resolve => { completeRead = resolve; }) as never;
      return { session: h.row };
    });
    h.request.mockResolvedValue({ decision: 'cancel' });
    h.owner.prepare(h.binding);
    h.accept();
    h.routing.route(h.native);
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledWith('exec.approval.resolve', { id: h.native.id, decision: 'deny' }));
    expect(h.nativeRequest.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
    completeRead({ session: h.row });
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledWith('sessions.abort', { key: h.row.key, runId: 'actual-root' }));
    h.owner.release();
  });

  it.each(['source', 'generation', 'incarnation'] as const)('cannot cancel or accept after its %s changes', async changed => {
    const h = fixture();
    let reply!: (value: unknown) => void;
    h.request.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
    h.owner.prepare(h.binding);
    h.accept();
    h.routing.route(h.native);
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
    if (changed === 'source') h.replaceSource();
    if (changed === 'generation') h.replace();
    if (changed === 'incarnation') h.row.lifecycleRevision = 'replacement';
    reply({ decision: 'cancel' });
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledWith('exec.approval.resolve', { id: h.native.id, decision: 'deny' }));
    expect(h.nativeRequest.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
    h.owner.release();
  });
});
