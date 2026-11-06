import { describe, expect, it, vi } from 'vitest';

import { CoworkSessionSource } from '../../shared/cowork/sessionSource';
import { ApprovalKind, type ApprovalRequest } from '../../shared/security/approvals';
import type { AppServerConnectionContext } from '../clients/appServer/protocol/appServerProtocol';
import type { GatewayClientLike } from '../engine/gateway/types';
import type { CoworkStartOptions } from '../engine/types';
import { ExternalApprovalRouting } from '../openclaw/permissions/externalApprovalRouting';
import { ChromeExtensionChatController } from './chromeExtensionChatController';

const logicalId = '11111111-1111-4111-8111-111111111111';
function fixture(knownUnsent = false) {
  const session = { id: 'browser-thread', source: CoworkSessionSource.ChromeExtension, title: 'Browser',
    cwd: '/task', agentId: 'main', permissionMode: 'ask', modelRef: 'provider/vision', nativeSessionKey: 'native-key' };
  const binding = { sessionKey: session.nativeSessionKey, nativeSessionId: 'physical', lifecycleRevision: 'revision', clientGeneration: 3 };
  const native: ApprovalRequest = { id: 'approval', kind: ApprovalKind.Exec, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    request: { sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId, runId: 'actual-root', command: 'read file', allowedDecisions: ['allow-once', 'deny'] } };
  const nativeRequest = vi.fn(async (method: string) => method === 'sessions.describe'
    ? { session: { key: binding.sessionKey, sessionId: binding.nativeSessionId, lifecycleRevision: binding.lifecycleRevision } }
    : method === 'models.list' ? { models: [{ id: 'vision', provider: 'provider', name: 'Vision', input: ['text', 'image'] }] } : {});
  const client = { request: nativeRequest } as unknown as GatewayClientLike;
  const routing = new ExternalApprovalRouting(() => client);
  let settled = false;
  const runtime = {
    getGatewayClient: () => client, getGatewayClientGeneration: () => 3,
    getSessionKeysForSession: () => [binding.sessionKey], claimExternalApprovalOwner: routing.claim.bind(routing),
    getRunTerminalReceipt: () => settled ? { runId: 'actual-root', sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId,
      clientGeneration: 3, executionSettled: true, status: 'completed', endedAt: 2_000, agentSeq: 1 } : null,
  };
  let timing: Record<string, unknown> | undefined;
  const store = {
    getSession: () => session, getSessionRunByClientTurnId: () => timing,
    beginSessionRun: vi.fn(value => (timing = { id: 'timing', state: 'running', ...value })),
    finishSessionRun: vi.fn(),
  };
  const router = { isSessionActive: () => false,
    prepareSession: vi.fn(async () => ({ sessionKey: binding.sessionKey, gatewaySessionId: binding.nativeSessionId })),
    startSession: vi.fn(async (_id: string, _message: string, options: CoworkStartOptions) => {
      options.finalSyncAdmission?.(binding);
      if (knownUnsent) {
        await options.onNativeSendAbandoned?.();
        throw Object.assign(new Error('The native sender was closed before dispatch.'), { requestSent: false });
      }
      routing.route(native);
      options.onNativeAccepted?.({ ...binding, clientTurnId: logicalId, nativeRunId: 'actual-root' });
      timing!.rootRunId = 'actual-root';
      options.onAccepted?.();
    }),
  };
  const controller = new ChromeExtensionChatController({
    ensureEngineRunning: async () => ({ phase: 'running' }) as never,
    getStore: () => store as never, getRuntime: () => runtime as never, getRouter: () => router as never,
  });
  const request = vi.fn<NonNullable<AppServerConnectionContext['request']>>(async () => ({ decision: 'accept' }));
  const context = { notify: vi.fn(), isClosed: () => false, request, isExperimentalApiEnabled: () => true };
  const peer = new AbortController();
  const trusted = { assertCurrent: vi.fn(), approvals: { context, signal: peer.signal } };
  return { controller, request, routing, nativeRequest, native, router, trusted, store,
    settle: () => { settled = true; } };
}

describe('browser controller approval admission', () => {
  it('installs an exact prepared owner, preserves page context, and releases only after verified settlement', async () => {
    const h = fixture();
    await h.controller.sendMessage({ sessionId: 'browser-thread', clientTurnId: logicalId, message: 'Input',
      pageContext: { title: 'Selected page' } }, h.trusted);
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledWith('exec.approval.resolve', { id: h.native.id, decision: 'allow-once' }));
    expect(h.request).toHaveBeenCalledWith('item/commandExecution/requestApproval',
      expect.objectContaining({ turnId: logicalId }), expect.anything());
    expect(h.router.startSession.mock.calls[0][2].untrustedContext).toContain('Selected page');
    expect(h.routing.owns(h.native)).toBe(true);
    h.settle();
    await expect(h.controller.getTurnState('browser-thread', logicalId)).resolves.toMatchObject({ executionSettled: true });
    expect(h.routing.owns(h.native)).toBe(false);
  });

  it('releases an installed owner when the owning sender proves the input was never dispatched', async () => {
    const h = fixture(true);
    await expect(h.controller.sendMessage({ sessionId: 'browser-thread', clientTurnId: logicalId, message: 'Input' }, h.trusted))
      .rejects.toMatchObject({ requestSent: false });
    expect(h.routing.owns(h.native)).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.store.finishSessionRun).toHaveBeenCalledWith('timing', 'failed', expect.any(Number));
  });

  it('keeps attachment-only input empty instead of inserting fabricated text', async () => {
    const h = fixture();
    const attachments = [{ name: 'image.png', mimeType: 'image/png', base64Data: 'aGVsbG8=' }];
    await h.controller.sendMessage({ sessionId: 'browser-thread', clientTurnId: logicalId, message: '', attachments }, h.trusted);
    expect(h.router.startSession).toHaveBeenCalledWith('browser-thread', '', expect.objectContaining({ attachments }));
    h.routing.resolved(ApprovalKind.Exec, h.native.id);
    h.settle();
    await h.controller.getTurnState('browser-thread', logicalId);
  });

  it('rejects a competing submission before asynchronous preparation can overwrite the sending owner', async () => {
    const h = fixture();
    let prepared!: () => void;
    h.router.prepareSession.mockImplementationOnce(() => new Promise(resolve => {
      prepared = () => resolve({ sessionKey: 'native-key', gatewaySessionId: 'physical' });
    }));
    const sending = h.controller.sendMessage({ sessionId: 'browser-thread', clientTurnId: logicalId, message: 'First' }, h.trusted);
    await vi.waitFor(() => expect(h.router.prepareSession).toHaveBeenCalledOnce());
    await expect(h.controller.sendMessage({ sessionId: 'browser-thread',
      clientTurnId: '22222222-2222-4222-8222-222222222222', message: 'Competing' }, h.trusted))
      .rejects.toMatchObject({ message: 'This conversation already has a pending submission.', requestSent: false });
    expect(h.router.startSession).not.toHaveBeenCalled();
    prepared();
    await sending;
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledWith('exec.approval.resolve', { id: h.native.id, decision: 'allow-once' }));
    expect(h.router.startSession).toHaveBeenCalledOnce();
    h.settle();
    await h.controller.getTurnState('browser-thread', logicalId);
    expect(h.routing.owns(h.native)).toBe(false);
  });
});
