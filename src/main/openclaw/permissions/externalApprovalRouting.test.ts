import { expect, test, vi } from 'vitest';

import { ApprovalKind, type ApprovalRequest } from '../../../shared/security/approvals';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { ExternalApprovalRouting } from './externalApprovalRouting';
import { ExternalApprovalSessionScope } from './externalApprovalSessionScope';

function setup() {
  const row = { key: 'native-key', sessionId: 'native-id', lifecycleRevision: '1' };
  const request = vi.fn(async (method: string, _input?: unknown) => method === 'sessions.describe' ? { session: row } : {});
  const client = { request } as unknown as GatewayClientLike;
  let current: GatewayClientLike | null = client;
  const routing = new ExternalApprovalRouting(() => current);
  const binding = { sessionKey: row.key, sessionId: row.sessionId, lifecycleRevision: row.lifecycleRevision, runId: 'run-a', client };
  const approval: ApprovalRequest = { id: 'approval', kind: ApprovalKind.Exec, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    request: { sessionKey: row.key, sessionId: row.sessionId, runId: 'run-a', command: 'work', allowedDecisions: ['allow-once', 'deny'] } };
  return { row, request, client, routing, binding, approval, replace() { current = { request: vi.fn() } as never; } };
}

test('one exact-run owner presents once and resolves only a native single-use decision', async () => {
  const h = setup();
  const present = vi.fn(async () => 'allow-once' as const);
  const release = h.routing.claim(h.binding, present);
  h.routing.route(h.approval);
  h.routing.route(h.approval);
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', { id: 'approval', decision: 'allow-once' }));
  expect(present).toHaveBeenCalledOnce();
  release();
});

test('same-key approvals from another run or incarnation never reach the ACP owner', () => {
  const h = setup();
  const present = vi.fn(async () => 'allow-once' as const);
  const release = h.routing.claim(h.binding, present);
  expect(h.routing.route({ ...h.approval, request: { ...h.approval.request, runId: 'run-b' } })).toBe(false);
  expect(h.routing.route({ ...h.approval, request: { ...h.approval.request, sessionId: 'different' } })).toBe(false);
  expect(h.routing.route({ ...h.approval, request: { ...h.approval.request, runId: undefined } })).toBe(false);
  expect(present).not.toHaveBeenCalled();
  release();
});

test('late approval after owner closes is denied and cannot grant permission', async () => {
  const h = setup();
  let decide!: (value: 'allow-once') => void;
  const present = vi.fn(() => new Promise<'allow-once'>(resolve => { decide = resolve; }));
  const release = h.routing.claim(h.binding, present);
  h.routing.route(h.approval);
  await vi.waitFor(() => expect(present).toHaveBeenCalledOnce());
  release();
  decide('allow-once');
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', { id: 'approval', decision: 'deny' }));
});

test('cancelling a turn revokes late permission replies while retaining exclusive ownership', async () => {
  const h = setup();
  const cancellation = new AbortController();
  let decide!: (value: 'allow-once') => void;
  let permissionSignal!: AbortSignal;
  const present = vi.fn((_request: ApprovalRequest, signal: AbortSignal) => {
    permissionSignal = signal;
    return new Promise<'allow-once'>(resolve => { decide = resolve; });
  });
  const release = h.routing.claim(h.binding, present, cancellation.signal);
  h.routing.route(h.approval);
  await vi.waitFor(() => expect(present).toHaveBeenCalledOnce());

  cancellation.abort();
  expect(permissionSignal.aborted).toBe(true);
  expect(h.routing.owns(h.approval)).toBe(true);
  expect(() => h.routing.claim(h.binding, present)).toThrow('approval owner');
  decide('allow-once');
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', { id: 'approval', decision: 'deny' }));

  const laterApproval = { ...h.approval, id: 'after-cancel' };
  expect(h.routing.route(laterApproval)).toBe(true);
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', { id: 'after-cancel', decision: 'deny' }));
  expect(present).toHaveBeenCalledOnce();
  release();
  expect(h.routing.owns(h.approval)).toBe(false);
});

test('cancellation during the final authority read cannot commit a previously selected allow', async () => {
  const h = setup();
  const cancellation = new AbortController();
  let completeRead!: (value: { session: typeof h.row }) => void;
  let reads = 0;
  h.request.mockImplementation(method => {
    if (method !== 'sessions.describe') return Promise.resolve({});
    if (++reads === 1) return Promise.resolve({ session: h.row });
    return new Promise(resolve => { completeRead = resolve; });
  });
  const release = h.routing.claim(h.binding, async () => 'allow-once', cancellation.signal);
  h.routing.route(h.approval);
  await vi.waitFor(() => expect(reads).toBe(2));

  cancellation.abort();
  completeRead({ session: h.row });
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', { id: 'approval', decision: 'deny' }));
  expect(h.request.mock.calls.some(([method, input]) =>
    method === 'exec.approval.resolve' && (input as { decision?: string }).decision === 'allow-once',
  )).toBe(false);
  release();
});

test('a turn cancelled before owner registration denies approvals without presenting them', async () => {
  const h = setup();
  const cancellation = new AbortController();
  cancellation.abort();
  const present = vi.fn(async () => 'allow-once' as const);
  const release = h.routing.claim(h.binding, present, cancellation.signal);

  expect(h.routing.route(h.approval)).toBe(true);
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', { id: 'approval', decision: 'deny' }));
  expect(present).not.toHaveBeenCalled();
  expect(h.routing.owns(h.approval)).toBe(true);
  release();
});

test('an already resolved native approval is never resolved a second time', async () => {
  const h = setup();
  let decide!: (value: 'allow-once') => void;
  const present = vi.fn(() => new Promise<'allow-once'>(resolve => { decide = resolve; }));
  const release = h.routing.claim(h.binding, present);
  h.routing.route(h.approval);
  await vi.waitFor(() => expect(present).toHaveBeenCalledOnce());
  h.routing.resolved(ApprovalKind.Exec, 'approval');
  decide('allow-once');
  await vi.waitFor(() => expect(h.routing.ownsRequest(ApprovalKind.Exec, 'approval')).toBe(false));
  expect(h.request.mock.calls.some(([method]) => method === 'exec.approval.resolve')).toBe(false);
  release();
});

test('an uncertain permission decision is not retried with a different decision', async () => {
  const h = setup();
  h.request.mockImplementation(async method => {
    if (method === 'sessions.describe') return { session: h.row };
    throw new Error('Connection lost after sending.');
  });
  const release = h.routing.claim(h.binding, async () => 'allow-once');
  h.routing.route(h.approval);
  await vi.waitFor(() => expect(h.routing.ownsRequest(ApprovalKind.Exec, 'approval')).toBe(false));
  expect(h.request.mock.calls.filter(([method]) => method === 'exec.approval.resolve')).toHaveLength(1);
  release();
});

test('replacing a connection never replays permission on its successor', async () => {
  const h = setup();
  let decide!: (value: 'allow-once') => void;
  const present = vi.fn(() => new Promise<'allow-once'>(resolve => { decide = resolve; }));
  const release = h.routing.claim(h.binding, present);
  h.routing.route(h.approval);
  await vi.waitFor(() => expect(present).toHaveBeenCalledOnce());
  h.replace();
  decide('allow-once');
  await vi.waitFor(() => expect(h.routing.ownsRequest(ApprovalKind.Exec, 'approval')).toBe(false));
  expect(h.request.mock.calls.some(([method]) => method === 'exec.approval.resolve')).toBe(false);
  release();
});

test('holds a prepared owner until the native ACK identifies the exact run', async () => {
  const h = setup();
  let accept!: (runId: string | undefined) => void;
  const runIdReady = new Promise<string | undefined>(resolve => { accept = resolve; });
  const { runId: _runId, ...identity } = h.binding;
  const present = vi.fn(async () => 'allow-once' as const);
  const release = h.routing.claim({ ...identity, runIdReady }, present);
  const actual = { ...h.approval, request: { ...h.approval.request, runId: 'ack-native-root' } };
  expect(h.routing.route(actual)).toBe(true);
  await Promise.resolve();
  expect(present).not.toHaveBeenCalled();
  expect(h.request).not.toHaveBeenCalled();

  accept('ack-native-root');
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', { id: actual.id, decision: 'allow-once' }));
  expect(present).toHaveBeenCalledOnce();
  const foreign = { ...actual, id: 'foreign', request: { ...actual.request, runId: 'not-the-ack' } };
  expect(h.routing.route(foreign)).toBe(true);
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', { id: foreign.id, decision: 'deny' }));
  expect(present).toHaveBeenCalledOnce();
  release();
});

test('withdraws an ACK-pending presenter without releasing its approval owner', async () => {
  const h = setup();
  const { runId: _runId, ...identity } = h.binding;
  const cancelled = new AbortController();
  const present = vi.fn(async () => 'allow-once' as const);
  const release = h.routing.claim({ ...identity, runIdReady: new Promise(() => {}) }, present, cancelled.signal);
  expect(h.routing.route(h.approval)).toBe(true);
  cancelled.abort();
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', { id: h.approval.id, decision: 'deny' }));
  expect(present).not.toHaveBeenCalled();
  expect(h.routing.owns(h.approval)).toBe(true);
  release();
});

test('an ACK-pending owner never presents or sends a decision after the same client reconnects', async () => {
  const h = setup();
  let accept!: (runId: string) => void;
  const runIdReady = new Promise<string>(resolve => { accept = resolve; });
  const { runId: _runId, ...identity } = h.binding;
  let generation = 1;
  const present = vi.fn(async () => 'allow-once' as const);
  const release = h.routing.claim({ ...identity, runIdReady }, present, undefined, () => generation === 1);
  const actual = { ...h.approval, request: { ...h.approval.request, runId: 'ack-native-root' } };
  expect(h.routing.route(actual)).toBe(true);
  generation++;
  accept('ack-native-root');

  await vi.waitFor(() => expect(h.routing.ownsRequest(ApprovalKind.Exec, actual.id)).toBe(false));
  expect(h.request).not.toHaveBeenCalled();
  expect(present).not.toHaveBeenCalled();
  expect(h.routing.owns(actual)).toBe(true);
  release();
});

test('expires an approval awaiting its native ACK without fabricating run ownership', async () => {
  const h = setup();
  const { runId: _runId, ...identity } = h.binding;
  const present = vi.fn(async () => 'allow-once' as const);
  const release = h.routing.claim({ ...identity, runIdReady: new Promise(() => {}) }, present);
  const expiring = { ...h.approval, expiresAtMs: Date.now() + 20 };
  expect(h.routing.route(expiring)).toBe(true);
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', { id: expiring.id, decision: 'deny' }));
  expect(present).not.toHaveBeenCalled();
  release();
});

test('a session grant commits only native allow-once and reuses the exact fingerprint across settled runs', async () => {
  const h = setup();
  const scope = new ExternalApprovalSessionScope();
  const binding = { ...h.binding, clientGeneration: 1, isCurrent: () => true, approvalScope: scope };
  const present = vi.fn(async () => 'allow-session' as const);
  h.request.mockImplementation(async (method, input) => {
    if (method === 'sessions.describe') return { session: h.row };
    if (method === 'exec.approval.resolve') h.routing.resolved(ApprovalKind.Exec, (input as { id: string }).id);
    return {};
  });
  const first = h.routing.claim(binding, present);
  h.routing.route(h.approval);
  await vi.waitFor(() => expect(scope.matches(binding, h.approval)).toBe(true));
  first();
  const next = { ...h.approval, id: 'second', request: { ...h.approval.request, runId: 'run-b' } };
  const second = h.routing.claim({ ...binding, runId: 'run-b' }, present);
  h.routing.route(next);
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', { id: next.id, decision: 'allow-once' }));
  expect(present).toHaveBeenCalledOnce();
  expect(h.request.mock.calls.some(([, input]) => (input as { decision?: string })?.decision === 'allow-always')).toBe(false);
  second();
  scope.close();
});

test('an uncertain native allow-once response never installs a session grant', async () => {
  const h = setup();
  const scope = new ExternalApprovalSessionScope();
  const binding = { ...h.binding, clientGeneration: 1, isCurrent: () => true, approvalScope: scope };
  h.request.mockImplementation(async method => {
    if (method === 'sessions.describe') return { session: h.row };
    throw new Error('The native response was lost.');
  });
  const release = h.routing.claim(binding, async () => 'allow-session');
  h.routing.route(h.approval);
  await vi.waitFor(() => expect(h.routing.ownsRequest(ApprovalKind.Exec, h.approval.id)).toBe(false));
  expect(scope.matches(binding, h.approval)).toBe(false);
  expect(h.request.mock.calls.filter(([method]) => method === 'exec.approval.resolve')).toHaveLength(1);
  release();
  scope.close();
});

test('a confirmed decision from a retired connection cannot install a session grant', async () => {
  const h = setup();
  const scope = new ExternalApprovalSessionScope();
  const binding = { ...h.binding, clientGeneration: 1, isCurrent: () => true, approvalScope: scope };
  let generation = 1;
  let acknowledge!: () => void;
  h.request.mockImplementation(async method => {
    if (method === 'sessions.describe') return { session: h.row };
    await new Promise<void>(resolve => { acknowledge = resolve; });
    return {};
  });
  const release = h.routing.claim(binding, async () => 'allow-session', undefined, () => generation === 1);
  h.routing.route(h.approval);
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('exec.approval.resolve', {
    id: h.approval.id, decision: 'allow-once',
  }));
  generation++;
  acknowledge();

  await vi.waitFor(() => expect(h.routing.ownsRequest(ApprovalKind.Exec, h.approval.id)).toBe(false));
  expect(scope.matches(binding, h.approval)).toBe(false);
  expect(h.request.mock.calls.filter(([method]) => method === 'exec.approval.resolve')).toHaveLength(1);
  release();
  scope.close();
});

test('routes a genuine persistent App grant while rejecting a forged or withdrawn native action', async () => {
  const h = setup();
  const request: ApprovalRequest = { ...h.approval, kind: ApprovalKind.Plugin, request: {
    sessionKey: h.binding.sessionKey, runId: h.binding.runId, pluginId: 'bundle-mcp', title: 'App', description: 'Requested App permissions',
    allowedDecisions: ['allow-always', 'deny'],
    actions: [{ kind: 'decision', decision: 'allow-always', command: 'allow-always', label: 'Native action' }],
  } };
  let answer!: (decision: 'allow-always') => void;
  const present = vi.fn(() => new Promise<'allow-always'>(resolve => { answer = resolve; }));
  const release = h.routing.claim(h.binding, present);
  h.routing.route(request);
  await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(1));
  answer('allow-always');
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('plugin.approval.resolve', { id: request.id, decision: 'allow-always' }));
  const withdrawn = { ...request, id: 'withdrawn', request: { ...request.request, actions: [...request.request.actions!] } };
  h.routing.route(withdrawn);
  await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(2));
  withdrawn.request.actions = [];
  answer('allow-always');
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith('plugin.approval.resolve', { id: withdrawn.id, decision: 'deny' }));
  release();
});
