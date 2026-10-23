import { expect, test, vi } from 'vitest';

import { ApprovalKind, type ApprovalRequest } from '../../../shared/security/approvals';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { ExternalApprovalRouting } from './externalApprovalRouting';

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
