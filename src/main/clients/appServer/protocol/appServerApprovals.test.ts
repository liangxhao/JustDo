import { describe, expect, it, vi } from 'vitest';

import { ApprovalKind, type ApprovalRequest } from '../../../../shared/security/approvals';
import { t } from '../../../core/i18n';
import type { GatewayClientLike } from '../../../engine/gateway/types';
import { ExternalApprovalRouting } from '../../../openclaw/permissions/externalApprovalRouting';
import { createAppServerApprovalPresenter as createCodexApprovalPresenter } from './appServerApprovals';
import { AppServerConnection } from './appServerConnection';
import { type AppServerConnectionContext, AppServerErrorStyle, AppServerRequestMethod } from './appServerProtocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function approval(kind: ApprovalRequest['kind'] = ApprovalKind.Exec): ApprovalRequest {
  const base = { id: 'native-approval', createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 };
  const identity = { runId: 'turn', sessionKey: 'private-native-key', toolCallId: 'native-tool', allowedDecisions: ['allow-once', 'deny'] as const };
  return kind === ApprovalKind.Exec
    ? { ...base, kind, request: { ...identity, allowedDecisions: [...identity.allowedDecisions], command: 'read file.txt', cwd: '/workspace', sessionId: 'private-native-sid' } }
    : { ...base, kind, request: { ...identity, allowedDecisions: [...identity.allowedDecisions], title: 'Tool permission', description: 'Read the selected resource', detail: 'Only this call.' } };
}

function fixture(experimental = true) {
  let closed = false;
  const request = vi.fn<NonNullable<AppServerConnectionContext['request']>>(async () => ({ decision: 'accept' }));
  const context: AppServerConnectionContext = {
    notify: vi.fn(),
    isClosed: () => closed,
    request,
    isExperimentalApiEnabled: () => experimental,
  };
  const run = new AbortController();
  const pending = new AbortController();
  const cancel = vi.fn();
  return {
    context, request, run, pending, cancel,
    present: createCodexApprovalPresenter(context, 'external-thread', 'turn', run.signal, cancel),
    close: () => { closed = true; },
  };
}

describe('Codex native approval presenter', () => {
  it('presents exact command context and maps only accept to native allow-once', async () => {
    const h = fixture(false);
    const native = approval();
    expect(await h.present(native, h.pending.signal)).toBe('allow-once');
    expect(h.request).toHaveBeenCalledExactlyOnceWith(AppServerRequestMethod.CommandExecutionApproval, {
      threadId: 'external-thread', turnId: 'turn', itemId: 'native-tool',
      approvalId: native.id, startedAtMs: native.createdAtMs, kind: 'command',
      command: 'read file.txt', cwd: '/workspace', reason: null,
      commandActions: null, networkApprovalContext: null,
      proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null,
    }, { signal: expect.any(AbortSignal), timeoutMs: expect.any(Number) });
    expect(JSON.stringify(h.request.mock.calls[0][1])).not.toMatch(/private-native/);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it.each([
    'decline',
    'acceptForSession',
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['read'] } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'allow' } } },
    'allow-once',
    undefined,
  ])('denies unsupported or broader decisions without changing policy: %j', async decision => {
    const h = fixture();
    h.request.mockResolvedValue({ decision });
    expect(await h.present(approval(), h.pending.signal)).toBe('deny');
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('maps cancel to denial plus cancellation of the captured turn', async () => {
    const h = fixture();
    h.request.mockResolvedValue({ decision: 'cancel' });
    expect(await h.present(approval(), h.pending.signal)).toBe('deny');
    expect(h.cancel).toHaveBeenCalledOnce();
  });

  it('advertises a real session-grant decision only with an installed safe scope', async () => {
    const h = fixture();
    h.request.mockResolvedValue({ decision: 'acceptForSession' });
    const present = createCodexApprovalPresenter(h.context, 'external-thread', 'turn', h.run.signal, h.cancel, { allowSession: true });
    expect(await present(approval(), h.pending.signal)).toBe('allow-session');
    expect(h.request.mock.calls[0][1].availableDecisions).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
    const unsafe = approval();
    if (unsafe.kind !== ApprovalKind.Exec) throw new Error('Invalid fixture.');
    unsafe.request.envKeys = ['SECRET'];
    expect(await present(unsafe, h.pending.signal)).toBe('deny');
    expect(h.request.mock.calls[1][1].availableDecisions).toEqual(['accept', 'decline', 'cancel']);
  });

  it('keeps a command without its own incarnation eligible only for a single approval', async () => {
    const h = fixture();
    const present = createCodexApprovalPresenter(h.context, 'external-thread', 'turn', h.run.signal, h.cancel, { allowSession: true });
    const native = approval();
    if (native.kind !== ApprovalKind.Exec) throw new Error('Invalid fixture.');
    delete native.request.sessionId;

    expect(await present(native, h.pending.signal)).toBe('allow-once');
    expect(h.request.mock.calls[0][1].availableDecisions).toEqual(['accept', 'decline', 'cancel']);
    h.request.mockResolvedValue({ decision: 'acceptForSession' });
    expect(await present(native, h.pending.signal)).toBe('deny');
  });

  it('preserves argv-only command data instead of inventing shell quoting', async () => {
    const h = fixture();
    const native = approval();
    if (native.kind !== ApprovalKind.Exec) throw new Error('Invalid fixture.');
    delete native.request.command;
    native.request.commandArgv = ['program.exe', 'argument with spaces', '$literal'];
    expect(await h.present(native, h.pending.signal)).toBe('allow-once');
    expect(h.request.mock.calls[0][1].command).toBe(JSON.stringify(native.request.commandArgv));
  });

  it('fails closed for missing command context, foreign runs and forbidden decisions', async () => {
    const h = fixture();
    const missing = approval();
    if (missing.kind !== ApprovalKind.Exec) throw new Error('Invalid fixture.');
    delete missing.request.command;
    const foreign = approval();
    foreign.request.runId = 'other-turn';
    const forbidden = approval();
    forbidden.request.allowedDecisions = ['deny'];
    for (const native of [missing, foreign, forbidden, { ...approval(), expiresAtMs: Date.now() - 1 }])
      expect(await h.present(native, h.pending.signal)).toBe('deny');
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each(['native-approval', 'run', 'connection'] as const)('denies an accept reply after %s is withdrawn', async owner => {
    const h = fixture();
    const reply = deferred<unknown>();
    h.request.mockReturnValue(reply.promise);
    const result = h.present(approval(), h.pending.signal);
    const authority = h.request.mock.calls[0][2]!.signal!;
    if (owner === 'native-approval') h.pending.abort();
    if (owner === 'run') h.run.abort();
    if (owner === 'connection') h.close();
    reply.resolve({ decision: 'accept' });
    expect(await result).toBe('deny');
    if (owner !== 'connection') expect(authority.aborted).toBe(true);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('denies unavailable clients and failed or timed-out server requests', async () => {
    const h = fixture();
    h.request.mockRejectedValue(new Error('Client request timed out.'));
    expect(await h.present(approval(), h.pending.signal)).toBe('deny');
    delete h.context.request;
    expect(await h.present(approval(), h.pending.signal)).toBe('deny');
    expect(h.request).toHaveBeenCalledOnce();
  });

  it('requires experimental opt-in for generic plugin confirmation', async () => {
    const h = fixture(false);
    expect(await h.present(approval(ApprovalKind.Plugin), h.pending.signal)).toBe('deny');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('uses real plugin context and requires one exact advertised affirmative answer', async () => {
    const h = fixture();
    h.request.mockImplementation(async (method, params) => {
      expect(method).toBe(AppServerRequestMethod.ToolUserInput);
      expect(params).toMatchObject({ threadId: 'external-thread', turnId: 'turn', itemId: 'native-tool', isBlocking: true });
      const question = (params.questions as Array<{ id: string; question: string; isOther: boolean; options: Array<{ label: string }> }>)[0];
      expect(question.question).toContain('Read the selected resource');
      expect(question.isOther).toBe(false);
      return { answers: { [question.id]: { answers: [question.options[0].label] } } };
    });
    expect(await h.present(approval(ApprovalKind.Plugin), h.pending.signal)).toBe('allow-once');
    expect(h.request.mock.calls[0][0]).not.toBe(AppServerRequestMethod.FileChangeApproval);
  });

  it('offers the native persistent App grant only for its explicit bundle-mcp action', async () => {
    const h = fixture();
    const native = approval(ApprovalKind.Plugin);
    if (native.kind !== ApprovalKind.Plugin) throw new Error('Invalid fixture.');
    native.request.pluginId = 'bundle-mcp';
    native.request.allowedDecisions = ['allow-always', 'deny'];
    native.request.actions = [{ kind: 'decision', decision: 'allow-always', command: 'allow-always', label: 'Native App action' }];
    h.request.mockImplementation(async (_method, params) => {
      const options = (params.questions as Array<{ options: Array<{ label: string; description: string }> }>)[0].options;
      expect(options).toEqual([
        { label: t('appServerAllowApp'), description: t('appServerAllowAppDescription') },
        { label: t('externalAgentReject'), description: t('externalAgentReject') },
      ]);
      return { answers: { permission: { answers: [options[0].label] } } };
    });
    expect(await h.present(native, h.pending.signal)).toBe('allow-always');
    expect(h.request.mock.calls[0][0]).toBe(AppServerRequestMethod.ToolUserInput);
  });

  it.each(['another-plugin', 'missing-action', 'withdrawn'] as const)(
    'cannot grant App persistence for an unoffered or withdrawn choice: %s', async invalid => {
      const h = fixture();
      const native = approval(ApprovalKind.Plugin);
      if (native.kind !== ApprovalKind.Plugin) throw new Error('Invalid fixture.');
      native.request.pluginId = invalid === 'another-plugin' ? 'other' : 'bundle-mcp';
      native.request.allowedDecisions = ['allow-once', 'allow-always', 'deny'];
      if (invalid !== 'missing-action')
        native.request.actions = [{ kind: 'decision', decision: 'allow-always', command: 'allow-always', label: 'Native action' }];
      h.request.mockImplementation(async () => {
        if (invalid === 'withdrawn') h.pending.abort();
        return { answers: { permission: { answers: [t('appServerAllowApp')] } } };
      });
      expect(await h.present(native, h.pending.signal)).toBe('deny');
      if (invalid !== 'withdrawn') {
        const options = (h.request.mock.calls[0][1].questions as Array<{ options: Array<{ label: string }> }>)[0].options;
        expect(options.some(option => option.label === t('appServerAllowApp'))).toBe(false);
      }
    },
  );

  it.each(['extra-question', 'multiple-answers', 'unadvertised-answer', 'decline', 'missing-answer'])('rejects malformed plugin confirmation: %s', async scenario => {
    const h = fixture();
    h.request.mockImplementation(async (_method, params) => {
      const question = (params.questions as Array<{ id: string; options: Array<{ label: string }> }>)[0];
      const allow = question.options[0].label;
      const answers = scenario === 'multiple-answers' ? [allow, allow]
        : scenario === 'unadvertised-answer' ? ['yes']
          : scenario === 'decline' ? [question.options[1].label] : [allow];
      return { answers: scenario === 'missing-answer' ? {}
        : { [question.id]: { answers }, ...(scenario === 'extra-question' ? { other: { answers: [allow] } } : {}) } };
    });
    expect(await h.present(approval(ApprovalKind.Plugin), h.pending.signal)).toBe('deny');
  });
});

it.each([ApprovalKind.Exec, ApprovalKind.Plugin])('routes a real %s server response through native identity rechecks', async kind => {
  const output: Array<Record<string, unknown>> = [];
  const run = new AbortController();
  let context!: AppServerConnectionContext;
  const connection = new AppServerConnection(value => {
    context = value;
    return {
      initialization: { result: {}, requireInitializedNotification: true, executeNotifications: false, errorStyle: AppServerErrorStyle.Codex },
      threads: { start: () => ({}) },
      turns: { start: () => ({}), interrupt: () => ({}) },
      onDisconnect: () => { run.abort(); },
    };
  }, value => output.push(value as Record<string, unknown>));
  const identity = { key: 'private-native-key', sessionId: 'private-native-sid', lifecycleRevision: 'current' };
  const nativeRequest = vi.fn(async (method: string) => method === 'sessions.describe' ? { session: identity } : {});
  const nativeClient = { request: nativeRequest } as unknown as GatewayClientLike;
  const routing = new ExternalApprovalRouting(() => nativeClient);
  const release = routing.claim({
    sessionKey: identity.key, sessionId: identity.sessionId, lifecycleRevision: identity.lifecycleRevision,
    runId: 'turn', client: nativeClient,
  }, createCodexApprovalPresenter(context, 'external-thread', 'turn', run.signal, () => run.abort()), run.signal);
  try {
    await connection.receive({ id: 1, method: 'initialize', params: { clientInfo: { name: 'peer', version: '1' }, capabilities: { experimentalApi: true } } });
    await connection.receive({ method: 'initialized', params: null });
    expect(routing.route(approval(kind))).toBe(true);
    const method = kind === ApprovalKind.Exec ? AppServerRequestMethod.CommandExecutionApproval : AppServerRequestMethod.ToolUserInput;
    await vi.waitFor(() => expect(output.some(message => message.method === method)).toBe(true));
    const wire = output.find(message => message.method === method)!;
    const params = wire.params as { questions?: Array<{ id: string; options: Array<{ label: string }> }> };
    const question = params.questions?.[0];
    const result = question ? { answers: { [question.id]: { answers: [question.options[0].label] } } } : { decision: 'accept' };
    await connection.receive({ id: wire.id, result });
    await vi.waitFor(() => expect(nativeRequest).toHaveBeenCalledWith(
      kind === ApprovalKind.Exec ? 'exec.approval.resolve' : 'plugin.approval.resolve',
      { id: 'native-approval', decision: 'allow-once' },
    ));
    expect(nativeRequest.mock.calls.filter(([requestMethod]) => requestMethod === 'sessions.describe').length).toBeGreaterThanOrEqual(2);
    expect(output).toContainEqual({ method: 'serverRequest/resolved', params: { threadId: 'external-thread', requestId: wire.id } });
  } finally {
    release();
    await connection.close();
  }
});
