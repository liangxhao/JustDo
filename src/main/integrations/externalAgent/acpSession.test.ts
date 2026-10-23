import { randomUUID } from 'node:crypto';
import os from 'node:os';

import {
  type AnyMessage,
  client,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { expect, test, vi } from 'vitest';

import { ApprovalKind, type ApprovalRequest } from '../../../shared/security/approvals';
import type { GatewayClientLike } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import { ExternalApprovalRouting } from '../../openclaw/permissions/externalApprovalRouting';
import { acpPromptText, AcpSession, type AcpSessionResources, acpStdioServers } from './acpSession';
import type { ExternalAgentBackend } from './externalAgentBackend';
import {
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
} from './externalAgentBackend';
import { ExternalAgentResources } from './externalAgentResources';
import type { ExternalAgentNativeBinding } from './externalAgentTypes';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => {
    resolve = value;
  });
  return { promise, resolve };
};

function setup(
  overrides: Partial<ExternalAgentBackend> = {},
  resources?: AcpSessionResources,
  permission: () => RequestPermissionResponse | Promise<RequestPermissionResponse> = () => ({
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  }),
) {
  const backend: ExternalAgentBackend = {
    models: () => [{ id: 'provider/model', name: 'Model', isDefault: true }],
    start: vi.fn(async params => ({
      id: randomUUID(),
      cwd: params.cwd,
      agentId: 'main',
      modelRef: 'provider/model',
    })),
    resume: vi.fn(async (id, params) => ({
      id,
      cwd: params.cwd!,
      agentId: 'main',
      modelRef: params.model,
    })),
    run: vi.fn(async () => 'answer'),
    ...overrides,
  };
  const owned = resources ?? { prepare: vi.fn(async () => () => {}), close: vi.fn(async () => {}) };
  let output!: ReadableStreamDefaultController<AnyMessage>;
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      output = controller;
    },
  });
  const session = new AcpSession(backend, message => output.enqueue(message as AnyMessage), owned);
  const updates: SessionNotification[] = [];
  const peer = client({ name: 'cli-acceptance' })
    .onNotification('session/update', ({ params }) => {
      updates.push(params);
    })
    .onRequest('session/request_permission', permission)
    .connect({
      readable,
      writable: new WritableStream<AnyMessage>({ write: message => session.receive(message) }),
    });
  return {
    backend,
    owned,
    session,
    peer,
    updates,
    async initialize() {
      return peer.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    },
    async start(cwd = os.tmpdir()) {
      return peer.agent.request('session/new', { cwd, mcpServers: [] });
    },
    async close() {
      peer.close();
      await session.close();
    },
  };
}

test('negotiates real SDK v1 and creates distinct sessions using each requested cwd', async () => {
  const harness = setup();
  try {
    const initialized = await harness.initialize();
    expect(initialized.protocolVersion).toBe(1);
    expect(initialized.agentCapabilities?.loadSession).toBe(false);
    const first = await harness.start();
    const second = await harness.start(process.cwd());
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(harness.backend.start).toHaveBeenNthCalledWith(2, { cwd: process.cwd() });
    const response = await harness.peer.agent.request('session/prompt', {
      sessionId: first.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(vi.mocked(harness.backend.run).mock.calls[0][5]?.interactiveApprovals).toBe(true);
    expect(harness.updates.map(item => item.update)).toContainEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'answer' },
    });
  } finally {
    await harness.close();
  }
});

test('cancel is processed during a long prompt and response waits for native settlement', async () => {
  const started = deferred<void>();
  const cancelled = deferred<void>();
  const settled = deferred<void>();
  const harness = setup({
    run: async (_thread, _id, _text, _event, signal) => {
      signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      started.resolve();
      await settled.promise;
      throw new ExternalAgentCancelledError('Native execution cancelled.');
    },
  });
  try {
    await harness.initialize();
    const thread = await harness.start();
    let replied = false;
    const result = harness.peer.agent
      .request('session/prompt', {
        sessionId: thread.sessionId,
        prompt: [{ type: 'text', text: 'work' }],
      })
      .then(value => {
        replied = true;
        return value;
      });
    await started.promise;
    await harness.peer.agent.notify('session/cancel', { sessionId: thread.sessionId });
    await cancelled.promise;
    expect(replied).toBe(false);
    settled.resolve();
    expect(await result).toEqual({ stopReason: 'cancelled' });
  } finally {
    settled.resolve();
    await harness.close();
  }
});

test.each([false, true])(
  'transport closure preserves native drain when resource failure is %s',
  async resourceFailure => {
    const started = deferred<void>();
    const cancelled = deferred<void>();
    const nativeSettled = deferred<void>();
    let executionEnded = false;
    const resources: AcpSessionResources = {
      prepare: async () => () => {},
      close: async () => {
        if (resourceFailure) throw new Error('MCP cleanup failed before native settlement.');
      },
    };
    const harness = setup(
      {
        run: async (_thread, _runId, _text, _event, signal) => {
          signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
          started.resolve();
          await nativeSettled.promise;
          executionEnded = true;
          throw new ExternalAgentCancelledError('Exact native cancellation was confirmed.');
        },
      },
      resources,
    );
    try {
      await harness.initialize();
      const thread = await harness.start();
      const prompt = harness.peer.agent
        .request('session/prompt', {
          sessionId: thread.sessionId,
          prompt: [{ type: 'text', text: 'work' }],
        })
        .catch(() => {});
      await started.promise;

      const closing = harness.session.close();
      await harness.session.transportClosed;
      await cancelled.promise;
      const repeatedClose = harness.session.close();
      expect(repeatedClose).toBe(closing);
      let drained = false;
      void repeatedClose.then(() => {
        drained = true;
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(drained).toBe(false);
      expect(executionEnded).toBe(false);
      // The bridge consumes this notification to close the physical peer.
      harness.peer.close();

      nativeSettled.resolve();
      await Promise.all([closing, repeatedClose]);
      await prompt;
      expect(executionEnded).toBe(true);
    } finally {
      nativeSettled.resolve();
      await harness.close();
    }
  },
);

test('resource links survive conversion without reading or fetching the resource', () => {
  const value = acpPromptText([
    { type: 'text', text: 'inspect' },
    {
      type: 'resource_link',
      name: 'source.ts',
      uri: 'file:///private/source.ts',
      mimeType: 'text/plain',
    },
  ]);
  expect(value).toContain('file:///private/source.ts');
  expect(value).toContain('source.ts');
  expect(() => acpPromptText([{ type: 'image', data: 'x', mimeType: 'image/png' }])).toThrow(
    'Unsupported',
  );
});

test('rejects unsupported session MCP before preparing a native session', () => {
  const servers = [{ name: 'local', command: 'server', args: [], env: [] }];
  expect(() => acpStdioServers(servers, 'darwin')).toThrow('process-tree cleanup');
  expect(acpStdioServers([], 'darwin')).toEqual([]);
  for (const platform of ['win32', 'linux'])
    expect(acpStdioServers(servers, platform)).toEqual(servers);
});

test('stdio MCP definitions are retained and installed before the first native prompt', async () => {
  let prepared = false;
  const owned: AcpSessionResources = {
    prepare: vi.fn(async (_thread, servers) => {
      expect(servers).toEqual([
        { name: 'workspace', command: process.execPath, args: ['server.js'], env: [] },
      ]);
      prepared = true;
      return () => {};
    }),
    close: vi.fn(async () => {}),
  };
  const harness = setup(
    {
      run: async (thread, _id, _text, _event, _signal, hooks) => {
        expect(hooks?.interactiveApprovals).toBe(true);
        await hooks?.onPrepared?.({
          localSessionId: 'local',
          sessionKey: 'native-key',
          sessionId: 'native-id',
          lifecycleRevision: '1',
          runId: _id,
          client: {} as never,
        });
        expect(prepared).toBe(true);
        return thread.id;
      },
    },
    owned,
  );
  try {
    await harness.initialize();
    const thread = await harness.peer.agent.request('session/new', {
      cwd: os.tmpdir(),
      mcpServers: [{ name: 'workspace', command: process.execPath, args: ['server.js'], env: [] }],
    });
    await harness.peer.agent.request('session/prompt', {
      sessionId: thread.sessionId,
      prompt: [{ type: 'text', text: 'MCP' }],
    });
    await harness.peer.agent.request('session/close', { sessionId: thread.sessionId });
    expect(owned.close).toHaveBeenCalledWith(thread.sessionId);
  } finally {
    await harness.close();
  }
});

test('unknown native results stay errors after cancellation and cannot become cancelled success', async () => {
  const started = deferred<AbortSignal>();
  const finish = deferred<void>();
  const harness = setup({
    run: async (_thread, _id, _text, _event, signal) => {
      started.resolve(signal);
      await finish.promise;
      throw new ExternalAgentOutcomeUnknownError('Unconfirmed native execution.');
    },
  });
  try {
    await harness.initialize();
    const thread = await harness.start();
    const request = harness.peer.agent.request('session/prompt', {
      sessionId: thread.sessionId,
      prompt: [{ type: 'text', text: 'work' }],
    });
    const expected = expect(request).rejects.toThrow('Unconfirmed');
    const signal = await started.promise;
    await harness.peer.agent.notify('session/cancel', { sessionId: thread.sessionId });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    finish.resolve();
    await expected;
  } finally {
    finish.resolve();
    await harness.close();
  }
});

test('a native success racing with cancel keeps the successful stop reason', async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  const harness = setup({
    run: async () => {
      started.resolve();
      await finish.promise;
      return 'finished';
    },
  });
  try {
    await harness.initialize();
    const thread = await harness.start();
    const result = harness.peer.agent.request('session/prompt', {
      sessionId: thread.sessionId,
      prompt: [{ type: 'text', text: 'work' }],
    });
    await started.promise;
    await harness.peer.agent.notify('session/cancel', { sessionId: thread.sessionId });
    finish.resolve();
    expect(await result).toEqual({ stopReason: 'end_turn' });
    expect(harness.updates.map(item => item.update)).toContainEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'finished' },
    });
  } finally {
    finish.resolve();
    await harness.close();
  }
});

test('permission responses are handled while the prompt that requested them is still pending', async () => {
  const prepare = vi.fn(async (_thread, _servers, _binding, present) => {
    const answer = await present(
      {
        kind: 'exec',
        id: 'approval',
        request: {
          command: 'read source.ts',
          allowedDecisions: ['allow-once', 'deny'],
        },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      },
      new AbortController().signal,
    );
    expect(answer).toBe('allow-once');
    return () => {};
  });
  const harness = setup(
    {
      run: async (_thread, runId, _text, _event, _signal, hooks) => {
        await hooks?.onPrepared?.({
          localSessionId: 'local',
          sessionKey: 'key',
          sessionId: 'native',
          lifecycleRevision: '1',
          runId,
          client: {} as never,
        });
        return 'approved';
      },
    },
    { prepare, close: async () => {} },
  );
  try {
    await harness.initialize();
    const thread = await harness.start();
    const result = await harness.peer.agent.request('session/prompt', {
      sessionId: thread.sessionId,
      prompt: [{ type: 'text', text: 'work' }],
    });
    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(prepare).toHaveBeenCalledOnce();
  } finally {
    await harness.close();
  }
});

test.each([ApprovalKind.Exec, ApprovalKind.Plugin])(
  'cancellation denies late %s approval replies and retains ownership until native settlement',
  async kind => {
    const prepared = deferred<void>();
    const permissionRequested = deferred<void>();
    const permissionReply = deferred<RequestPermissionResponse>();
    const cancellationObserved = deferred<void>();
    const settled = deferred<void>();
    const row = { key: 'native-key', sessionId: 'native-id', lifecycleRevision: '1' };
    const request = vi.fn(async (method: string, _input?: unknown) =>
      method === 'sessions.describe' ? { session: { ...row } } : {},
    );
    const client = { request } as unknown as GatewayClientLike;
    const routing = new ExternalApprovalRouting(() => client);
    const runtime = {
      getGatewayClient: () => client,
      claimExternalApprovalOwner: routing.claim.bind(routing),
    } as unknown as OpenClawRuntimeAdapter;
    const resources = new ExternalAgentResources(() => runtime);
    let binding!: ExternalAgentNativeBinding;
    const harness = setup(
      {
        run: async (_thread, runId, _text, _event, signal, hooks) => {
          signal.addEventListener('abort', () => cancellationObserved.resolve(), { once: true });
          binding = {
            localSessionId: 'local',
            sessionKey: row.key,
            sessionId: row.sessionId,
            lifecycleRevision: row.lifecycleRevision,
            runId,
            client,
          };
          const cleanup = await hooks?.onPrepared?.(binding);
          try {
            prepared.resolve();
            await settled.promise;
            throw new ExternalAgentCancelledError('Native cancellation was confirmed.');
          } finally {
            if (typeof cleanup === 'function') await cleanup();
          }
        },
      },
      resources,
      () => {
        permissionRequested.resolve();
        return permissionReply.promise;
      },
    );
    try {
      await harness.initialize();
      const thread = await harness.start();
      let promptSettled = false;
      const prompt = harness.peer.agent
        .request('session/prompt', {
          sessionId: thread.sessionId,
          prompt: [{ type: 'text', text: 'work' }],
        })
        .then(response => {
          promptSettled = true;
          return response;
        });
      await prepared.promise;
      const approval: ApprovalRequest = {
        id: 'approval',
        kind,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        request: {
          sessionKey: row.key,
          runId: binding.runId,
          allowedDecisions: ['allow-once', 'deny'],
          ...(kind === ApprovalKind.Exec
            ? { sessionId: row.sessionId, command: 'read source.ts' }
            : { title: 'Read source', description: 'Read source.ts' }),
        },
      } as ApprovalRequest;
      expect(routing.route(approval)).toBe(true);
      await permissionRequested.promise;

      await harness.peer.agent.notify('session/cancel', { sessionId: thread.sessionId });
      await cancellationObserved.promise;
      permissionReply.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
      const resolveMethod =
        kind === ApprovalKind.Exec ? 'exec.approval.resolve' : 'plugin.approval.resolve';
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(resolveMethod, {
          id: approval.id,
          decision: 'deny',
        }),
      );
      expect(
        request.mock.calls.some(
          ([method, input]) =>
            method === resolveMethod && (input as { decision?: string }).decision === 'allow-once',
        ),
      ).toBe(false);
      expect(routing.owns(approval)).toBe(true);
      expect(promptSettled).toBe(false);

      settled.resolve();
      expect(await prompt).toEqual({ stopReason: 'cancelled' });
      expect(routing.owns(approval)).toBe(false);
    } finally {
      permissionReply.resolve({ outcome: { outcome: 'cancelled' } });
      settled.resolve();
      await harness.close();
    }
  },
);

test.each(['settled', 'unknown'] as const)(
  'transport close retains cancelled approval ownership until the native result is %s',
  async outcome => {
    const prepared = deferred<void>();
    const finish = deferred<void>();
    const row = { key: 'native-key', sessionId: 'native-id', lifecycleRevision: '1' };
    const request = vi.fn(async (method: string, _input?: unknown) =>
      method === 'sessions.describe' ? { session: row } : {},
    );
    const nativeClient = { request } as unknown as GatewayClientLike;
    const routing = new ExternalApprovalRouting(() => nativeClient);
    const runtime = {
      getGatewayClient: () => nativeClient,
      claimExternalApprovalOwner: routing.claim.bind(routing),
    } as unknown as OpenClawRuntimeAdapter;
    const resources = new ExternalAgentResources(() => runtime);
    let binding!: ExternalAgentNativeBinding;
    let cleanup: void | (() => void | Promise<void>);
    let nativeSignal!: AbortSignal;
    const harness = setup(
      {
        run: async (_thread, runId, _text, _event, signal, hooks) => {
          nativeSignal = signal;
          binding = {
            localSessionId: 'local',
            sessionKey: row.key,
            sessionId: row.sessionId,
            lifecycleRevision: row.lifecycleRevision,
            runId,
            client: nativeClient,
          };
          cleanup = await hooks?.onPrepared?.(binding);
          prepared.resolve();
          await finish.promise;
          if (outcome === 'unknown')
            throw new ExternalAgentOutcomeUnknownError('Native outcome remains unknown.');
          if (typeof cleanup === 'function') await cleanup();
          throw new ExternalAgentCancelledError('Exact native cancellation was confirmed.');
        },
      },
      resources,
    );
    try {
      await harness.initialize();
      const thread = await harness.start();
      const prompt = harness.peer.agent
        .request('session/prompt', {
          sessionId: thread.sessionId,
          prompt: [{ type: 'text', text: 'work' }],
        })
        .catch(() => {});
      await prepared.promise;
      const approval: ApprovalRequest = {
        id: 'after-close',
        kind: ApprovalKind.Exec,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        request: {
          sessionKey: row.key,
          sessionId: row.sessionId,
          runId: binding.runId,
          command: 'read source.ts',
          allowedDecisions: ['allow-once', 'deny'],
        },
      };
      expect(routing.owns(approval)).toBe(true);

      let drained = false;
      const closing = harness.session.close().then(() => {
        drained = true;
      });
      await harness.session.transportClosed;
      harness.peer.close();
      expect(nativeSignal.aborted).toBe(true);
      expect(routing.owns(approval)).toBe(true);
      expect(routing.route(approval)).toBe(true);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
          id: approval.id,
          decision: 'deny',
        }),
      );
      expect(drained).toBe(false);

      finish.resolve();
      await closing;
      await prompt;
      expect(routing.owns(approval)).toBe(outcome === 'unknown');
      if (outcome === 'unknown') {
        const later = { ...approval, id: 'after-unknown' };
        expect(routing.route(later)).toBe(true);
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
            id: later.id,
            decision: 'deny',
          }),
        );
      }
    } finally {
      finish.resolve();
      await harness.close();
      if (typeof cleanup === 'function') await cleanup();
    }
  },
);

test('an unknown prompt retains its exact cancellation signal until connection close', async () => {
  let signal!: AbortSignal;
  const harness = setup({
    run: async (_thread, _id, _text, _event, nativeSignal) => {
      signal = nativeSignal;
      throw new ExternalAgentOutcomeUnknownError('Unknown native outcome.');
    },
  });
  try {
    await harness.initialize();
    const thread = await harness.start();
    await expect(
      harness.peer.agent.request('session/prompt', {
        sessionId: thread.sessionId,
        prompt: [{ type: 'text', text: 'work' }],
      }),
    ).rejects.toThrow('Unknown');
    expect(signal.aborted).toBe(false);
    await expect(
      harness.peer.agent.request('session/prompt', {
        sessionId: thread.sessionId,
        prompt: [{ type: 'text', text: 'retry' }],
      }),
    ).rejects.toThrow('busy');
    await harness.session.close();
    expect(signal.aborted).toBe(true);
  } finally {
    await harness.close();
  }
});

test('rejects cross-connection sessions, relative ACP cwd and unsupported MCP transports', async () => {
  const harness = setup();
  try {
    await harness.initialize();
    await expect(harness.start('relative')).rejects.toThrow();
    await expect(
      harness.peer.agent.request('session/prompt', {
        sessionId: randomUUID(),
        prompt: [{ type: 'text', text: 'hi' }],
      }),
    ).rejects.toThrow('owned');
    await expect(
      harness.peer.agent.request('session/new', {
        cwd: os.tmpdir(),
        mcpServers: [{ type: 'http', name: 'remote', url: 'https://example.test', headers: [] }],
      }),
    ).rejects.toThrow('stdio');
  } finally {
    await harness.close();
  }
});
