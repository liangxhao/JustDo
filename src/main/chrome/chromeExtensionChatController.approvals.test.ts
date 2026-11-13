import { describe, expect, it, vi } from 'vitest';

import type { SessionRunTiming } from '../../shared/cowork/sessionRun';
import { CoworkSessionSource } from '../../shared/cowork/sessionSource';
import { ApprovalKind, type ApprovalRequest } from '../../shared/security/approvals';
import type { AppServerConnectionContext } from '../clients/appServer/protocol/appServerProtocol';
import type { GatewayClientLike } from '../engine/gateway/types';
import { AutomaticErrorRetryCoordinator } from '../engine/openclaw/automaticErrorRetry/coordinator';
import { CONTEXT_OVERFLOW_ERROR_CODE } from '../engine/openclaw/automaticErrorRetry/rules';
import type { CoworkStartOptions } from '../engine/types';
import { ExternalApprovalRouting } from '../openclaw/permissions/externalApprovalRouting';
import { ChromeExtensionChatController } from './chromeExtensionChatController';

const logicalId = '11111111-1111-4111-8111-111111111111';
function fixture(knownUnsent = false, retry = false) {
  const session = { id: 'browser-thread', source: CoworkSessionSource.ChromeExtension, title: 'Browser',
    cwd: '/task', agentId: 'main', permissionMode: 'ask', modelRef: 'provider/vision',
    nativeSessionKey: retry ? 'agent:main:justdo:browser-thread' : 'native-key' };
  const binding = { sessionKey: session.nativeSessionKey, nativeSessionId: 'physical', lifecycleRevision: 'revision', clientGeneration: 3 };
  const native: ApprovalRequest = { id: 'approval', kind: ApprovalKind.Exec, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    request: { sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId, runId: 'actual-root', command: 'read file', allowedDecisions: ['allow-once', 'deny'] } };
  const waits = new Map<string, Record<string, unknown>>();
  const nativeRequest = vi.fn(async (method: string, params?: { runId?: string }) => method === 'sessions.describe'
    ? { session: { key: binding.sessionKey, sessionId: binding.nativeSessionId, lifecycleRevision: binding.lifecycleRevision } }
    : method === 'models.list' ? { models: [{ id: 'vision', provider: 'provider', name: 'Vision', input: ['text', 'image'] }] }
      : method === 'agent.wait' ? waits.get(params?.runId ?? '') ?? {} : {});
  const client = { request: nativeRequest } as unknown as GatewayClientLike;
  const routing = new ExternalApprovalRouting(() => client);
  const runs = new Map<string, SessionRunTiming>();
  let owner: CoworkStartOptions['automaticErrorRetryOwner'];
  let classify!: (code: string) => void;
  const classification = new Promise<string>(resolve => { classify = resolve; });
  const successor = 'technical-run';
  const launched = vi.fn(async ({ predecessorRunId, runId, attempt }) => {
    const row: SessionRunTiming = { id: 'successor-timing', sessionId: session.id, clientTurnId: runId,
      rootRunId: runId, startedAt: 3_000, state: 'running' };
    runs.set(runId, row);
    owner?.prepareSuccessor({ ...binding, predecessorRunId, runId, attempt });
    owner?.confirmSuccessor(runId);
    return { status: 'accepted' as const };
  });
  const coordinator = new AutomaticErrorRetryCoordinator({
    readFailureCode: () => classification, isCurrent: () => owner?.isCurrent() === true,
    reserveSuccessor: () => true, releaseSuccessor: () => {}, launchSuccessor: launched,
    createRunId: () => successor, retryDelayMs: 0,
    onChanged: presentation => {
      for (const { runId: _runId, clientTurnId, ...metadata } of presentation.runs) {
        const row = runs.get(clientTurnId);
        if (row) row.automaticErrorRetry = metadata;
      }
    },
    onUnclaimedSettled: () => {},
  });
  let settled = false;
  const runtime = {
    getGatewayClient: () => client, getGatewayClientGeneration: () => 3,
    getSessionKeysForSession: () => [binding.sessionKey], claimExternalApprovalOwner: routing.claim.bind(routing),
    getRunTerminalReceipt: () => settled ? { runId: 'actual-root', sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId,
      clientGeneration: 3, executionSettled: true, status: 'completed', endedAt: 2_000, agentSeq: 1 } : null,
    getAutomaticErrorRetryTurn: coordinator.getTurn.bind(coordinator),
    observeAutomaticErrorRetryWait: coordinator.observeWaitSettled.bind(coordinator),
    cancelAutomaticErrorRetryTurn: coordinator.cancelTurn.bind(coordinator),
  };
  const store = {
    getSession: () => session, getSessionRunByClientTurnId: (runId: string) => runs.get(runId),
    beginSessionRun: vi.fn(value => {
      const timing: SessionRunTiming = { id: 'timing', state: 'running', ...value };
      runs.set(timing.clientTurnId, timing);
      return timing;
    }),
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
      runs.get(logicalId)!.rootRunId = 'actual-root';
      owner = options.automaticErrorRetryOwner;
      if (owner) coordinator.arm({ ...binding, sessionId: session.id, clientTurnId: logicalId,
        runId: 'actual-root', maxContinuations: 1 });
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
  const trusted = { assertCurrent: vi.fn(), approvals: { context, signal: peer.signal },
    ...(retry ? { automaticErrorRetry: true as const } : {}) };
  return { controller, request, routing, nativeRequest, native, router, trusted, store,
    waits, successor, launched, classify: () => classify(CONTEXT_OVERFLOW_ERROR_CODE),
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

  it('keeps one browser turn and changes the exact approval owner only after a settled failed attempt', async () => {
    const h = fixture(false, true);
    await h.controller.sendMessage({ sessionId: 'browser-thread', clientTurnId: logicalId, message: 'Input' }, h.trusted);
    h.waits.set('actual-root', { runId: 'actual-root', status: 'error', pendingError: true, endedAt: 2_000 });
    await expect(h.controller.getTurnState('browser-thread', logicalId)).resolves.toMatchObject({
      id: logicalId, nativeRunId: 'actual-root', executionSettled: false,
    });
    expect(h.launched).not.toHaveBeenCalled();

    h.waits.set('actual-root', { runId: 'actual-root', status: 'error', endedAt: 2_000, error: 'First attempt failed' });
    await expect(h.controller.getTurnState('browser-thread', logicalId)).resolves.toMatchObject({
      id: logicalId, retryWaiting: true, executionSettled: false,
    });
    expect(h.routing.owns(h.native)).toBe(true);
    h.classify();
    await vi.waitFor(() => expect(h.launched).toHaveBeenCalledOnce());
    const successor = { ...h.native, id: 'retry-approval', request: { ...h.native.request, runId: h.successor } };
    const stale = { ...h.native, id: 'stale-approval' };
    h.routing.route(stale);
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledWith('exec.approval.resolve', {
      id: stale.id, decision: 'deny',
    }));
    expect(h.routing.owns(successor)).toBe(true);
    h.routing.route(successor);
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledWith('exec.approval.resolve', {
      id: successor.id, decision: 'allow-once',
    }));
    expect(h.request).toHaveBeenLastCalledWith('item/commandExecution/requestApproval',
      expect.objectContaining({ turnId: logicalId }), expect.anything());
    h.waits.set(h.successor, { runId: h.successor, status: 'ok', endedAt: 4_000 });
    await expect(h.controller.getTurnState('browser-thread', logicalId)).resolves.toMatchObject({
      id: logicalId, nativeRunId: h.successor, retryAttempt: 1, status: 'completed', executionSettled: true,
    });
    expect(h.routing.owns(successor)).toBe(false);
    expect(h.router.startSession).toHaveBeenCalledOnce();
  });

  it('stops during the retry decision without aborting the settled predecessor or dispatching a successor', async () => {
    const h = fixture(false, true);
    await h.controller.sendMessage({ sessionId: 'browser-thread', clientTurnId: logicalId, message: 'Input' }, h.trusted);
    h.waits.set('actual-root', { runId: 'actual-root', status: 'error', endedAt: 2_000, error: 'First attempt failed' });
    await expect(h.controller.getTurnState('browser-thread', logicalId)).resolves.toMatchObject({ retryWaiting: true });
    await h.controller.interruptThread('browser-thread', logicalId);
    h.classify();
    const stopped = await h.controller.getTurnState('browser-thread', logicalId);
    expect(stopped).toMatchObject({ id: logicalId, status: 'interrupted', executionSettled: true });
    expect(stopped?.error).toBeUndefined();
    expect(h.launched).not.toHaveBeenCalled();
    expect(h.nativeRequest.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(false);
    expect(h.store.finishSessionRun).toHaveBeenCalledWith('timing', 'failed', 2_000);
  });
});
