import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import runtimeBridgePlugin from '../../../../openclaw-extensions/justdo-runtime-bridge/index';

const sdk = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
  loadTranscriptEventsSync: vi.fn(),
  readVisibleSessionTranscriptMessageEntries: vi.fn(),
  redactSensitiveText: vi.fn((text: string) =>
    text.replace(/Bearer secret-token/g, 'Bearer [REDACTED]'),
  ),
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: vi.fn(() => ({ allowedHostnames: ['example.test'] })),
}));

vi.mock('openclaw/plugin-sdk/logging-core', () => ({
  redactSensitiveText: sdk.redactSensitiveText,
}));

vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: sdk.getSessionEntry,
  loadTranscriptEventsSync: sdk.loadTranscriptEventsSync,
}));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({
  readVisibleSessionTranscriptMessageEntries: sdk.readVisibleSessionTranscriptMessageEntries,
}));
vi.mock('openclaw/plugin-sdk/ssrf-runtime', () => ({
  fetchWithSsrFGuard: sdk.fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: sdk.ssrfPolicyFromHttpBaseUrlAllowedHostname,
}));

type HookContext = {
  runId?: string;
  sessionKey?: string;
  modelProviderId?: string;
  modelId?: string;
};
type Hook = (event: Record<string, unknown>, context: HookContext) => void;
type EmbeddingAdapter = {
  create: (options: { model: string; remote: { baseUrl: string } }) => Promise<{
    provider: {
      embedBatch: (inputs: string[], options?: { signal?: AbortSignal }) => Promise<number[][]>;
    };
  }>;
};
type HistoryHandler = (request: {
  params: Record<string, unknown>;
  respond: ReturnType<typeof vi.fn>;
}) => Promise<void>;

function registerPlugin() {
  const hooks = new Map<string, Hook>();
  const emitAgentEvent = vi.fn((_event: { data: { stage: string } }) => ({ emitted: true }));
  const registerGatewayMethod = vi.fn();
  const registerEmbeddingProvider = vi.fn();
  runtimeBridgePlugin.register({
    config: { memory: { search: { enabled: false } } },
    on: (name: string, hook: Hook) => hooks.set(name, hook),
    agent: { events: { emitAgentEvent } },
    registerGatewayMethod,
    registerEmbeddingProvider,
    logger: { info: vi.fn() },
  } as never);
  return { hooks, emitAgentEvent, registerGatewayMethod, registerEmbeddingProvider };
}

async function createEmbeddingProvider(data: unknown, ok = true) {
  const release = vi.fn();
  sdk.fetchWithSsrFGuard.mockResolvedValue({
    response: { ok, status: ok ? 200 : 503, json: async () => data },
    release,
  });
  const { registerEmbeddingProvider } = registerPlugin();
  const adapter = registerEmbeddingProvider.mock.calls[0][0] as EmbeddingAdapter;
  const { provider } = await adapter.create({
    model: 'test-embedding',
    remote: { baseUrl: 'https://example.test/v1/' },
  });
  return { provider, release };
}

beforeEach(() => vi.clearAllMocks());

describe('runtime bridge startup and progress', () => {
  test('declares unconditional startup and registers history with memory search disabled', () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'openclaw-extensions/justdo-runtime-bridge/openclaw.plugin.json'),
        'utf8',
      ),
    );
    expect(manifest.activation.onStartup).toBe(true);
    const { registerGatewayMethod } = registerPlugin();
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      'justdoRuntimeBridge.historyDetails',
      expect.any(Function),
      { scope: 'operator.read' },
    );
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      'justdoRuntimeBridge.historyMessage',
      expect.any(Function),
      { scope: 'operator.read' },
    );
  });

  test('keeps successful tool-loop model calls in waiting state without inventing retries', () => {
    const { hooks, emitAgentEvent } = registerPlugin();
    const context = {
      runId: 'run-1',
      sessionKey: 'agent:main:justdo:session-1',
      modelProviderId: 'provider',
      modelId: 'model',
    };
    hooks.get('before_agent_reply')?.({}, context);
    hooks.get('model_call_started')?.({ callId: 'call-1' }, context);
    hooks.get('model_call_started')?.({ callId: 'call-2' }, context);

    expect(emitAgentEvent.mock.calls.map(([event]) => event.data.stage)).toEqual([
      'preparing',
      'waiting_model',
      'waiting_model',
    ]);
    expect(emitAgentEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: context.runId,
        sessionKey: context.sessionKey,
        stream: 'lifecycle',
        data: expect.objectContaining({ provider: 'provider', model: 'model' }),
      }),
    );
  });

  test('does not emit progress for unrelated sessions or incomplete run identity', () => {
    const { hooks, emitAgentEvent } = registerPlugin();
    for (const context of [
      { runId: 'run-1', sessionKey: 'agent:main:other:session-1' },
      { sessionKey: 'agent:main:justdo:session-1' },
      { runId: 'run-1' },
    ]) {
      hooks.get('before_agent_reply')?.({}, context);
      hooks.get('model_call_started')?.({}, context);
    }
    expect(emitAgentEvent).not.toHaveBeenCalled();
  });
});

describe('runtime bridge embeddings', () => {
  test('restores request order for indexed responses while retaining proxy and abort support', async () => {
    const { provider, release } = await createEmbeddingProvider({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    });
    const signal = new AbortController().signal;

    await expect(provider.embedBatch(['first', 'second'], { signal })).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(sdk.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.test/v1/embeddings',
        policy: { allowedHostnames: ['example.test'] },
        useEnvProxyForEligibleUrls: true,
        signal,
        init: expect.objectContaining({
          body: JSON.stringify({ model: 'test-embedding', input: ['first', 'second'] }),
          signal,
        }),
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  test('accepts positional responses when every entry omits index', async () => {
    const { provider } = await createEmbeddingProvider({
      data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
    });
    await expect(provider.embedBatch(['first', 'second'])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  test.each([
    ['duplicate', [0, 0]],
    ['out of range', [0, 2]],
    ['negative', [-1, 1]],
    ['fractional', [0, 0.5]],
    ['mixed indexed and positional', [0, undefined]],
    ['mixed positional and indexed', [undefined, 1]],
    ['non-numeric', [0, '1']],
  ])('rejects %s indexes and releases the response', async (_name, indexes) => {
    const { provider, release } = await createEmbeddingProvider({
      data: (indexes as unknown[]).map(index => ({ index, embedding: [1, 0] })),
    });
    await expect(provider.embedBatch(['first', 'second'])).rejects.toThrow('malformed');
    expect(release).toHaveBeenCalledOnce();
  });

  test.each([
    { data: [{ embedding: [1] }] },
    { data: [{ embedding: [] }, { embedding: [1] }] },
    { data: [{ embedding: [NaN] }, { embedding: [1] }] },
  ])('rejects malformed batches before memory indexing', async payload => {
    const { provider, release } = await createEmbeddingProvider(payload);
    await expect(provider.embedBatch(['first', 'second'])).rejects.toThrow('malformed');
    expect(release).toHaveBeenCalledOnce();
  });

  test('releases guarded responses on HTTP failure', async () => {
    const { provider, release } = await createEmbeddingProvider({}, false);
    await expect(provider.embedBatch(['first'])).rejects.toThrow('HTTP 503');
    expect(release).toHaveBeenCalledOnce();
  });
});

test('reads only requested history details from the specified native session', async () => {
  sdk.getSessionEntry.mockReturnValue({ sessionId: 'native-session-1' });
  sdk.readVisibleSessionTranscriptMessageEntries.mockResolvedValue([
    {
      entryId: 'message-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
          { type: 'toolCall', id: 'other-call', name: 'read', arguments: { path: 'other.md' } },
        ],
      },
    },
  ]);
  sdk.loadTranscriptEventsSync.mockReturnValue([
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
          { type: 'toolCall', id: 'other-call', name: 'read', arguments: { path: 'other.md' } },
        ],
      },
    },
    { type: 'compaction', id: 'compact-1', summary: 'Earlier work', tokensBefore: 1000 },
  ]);
  const { registerGatewayMethod } = registerPlugin();
  const handler = registerGatewayMethod.mock.calls[0][1] as HistoryHandler;
  const respond = vi.fn();
  const sessionKey = 'agent:main:justdo:session-1';

  await handler({
    params: { sessionKey, toolCallIds: ['call-1'], compactionEntryIds: ['compact-1'] },
    respond,
  });

  expect(sdk.loadTranscriptEventsSync).toHaveBeenCalledWith({
    sessionKey,
    sessionId: 'native-session-1',
  });
  expect(respond).toHaveBeenCalledWith(true, {
    toolInputs: { 'call-1': { name: 'read', input: { path: 'README.md' } } },
    compactionDetails: { 'compact-1': { summary: 'Earlier work', tokensBefore: 1000 } },
    failureDetails: {},
  });
});

test('batches exact visible failure details with tool inputs and redacts only error text', async () => {
  sdk.getSessionEntry.mockReturnValue({ sessionId: 'native-session-1' });
  sdk.readVisibleSessionTranscriptMessageEntries.mockResolvedValue([
    {
      entryId: 'failure-1',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: ' Connection error. ',
        diagnostics: 'private',
        errorBody: 'private',
      },
    },
    {
      entryId: 'failure-2',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'Bearer secret-token' },
    },
    {
      entryId: 'other',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'Not requested' },
    },
    {
      entryId: 'user',
      message: { role: 'user', stopReason: 'error', errorMessage: 'Not assistant' },
    },
    {
      entryId: 'success',
      message: { role: 'assistant', stopReason: 'stop', errorMessage: 'Not failure' },
    },
    {
      entryId: 'tool',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
        ],
      },
    },
  ]);
  const { registerGatewayMethod } = registerPlugin();
  const handler = registerGatewayMethod.mock.calls[0][1] as HistoryHandler;
  const respond = vi.fn();
  await handler({
    params: {
      sessionKey: 'session-1',
      failureMessageIds: ['failure-1', 'failure-2', 'user', 'success', 'missing'],
      toolCallIds: ['call-1'],
    },
    respond,
  });
  expect(sdk.readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledExactlyOnceWith({
    sessionKey: 'session-1',
    sessionId: 'native-session-1',
  });
  expect(sdk.loadTranscriptEventsSync).not.toHaveBeenCalled();
  expect(sdk.redactSensitiveText).toHaveBeenCalledWith('Bearer secret-token', { mode: 'tools' });
  expect(respond).toHaveBeenCalledWith(true, {
    toolInputs: { 'call-1': { name: 'read', input: { path: 'README.md' } } },
    compactionDetails: {},
    failureDetails: {
      'failure-1': { errorMessage: 'Connection error.' },
      'failure-2': { errorMessage: 'Bearer [REDACTED]' },
    },
  });
});

test('bounds failure lookup batches and returned error text', async () => {
  sdk.getSessionEntry.mockReturnValue({ sessionId: 'native-session-1' });
  sdk.readVisibleSessionTranscriptMessageEntries.mockResolvedValue([
    {
      entryId: 'failure',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'x'.repeat(3000) },
    },
  ]);
  const { registerGatewayMethod } = registerPlugin();
  const handler = registerGatewayMethod.mock.calls[0][1] as HistoryHandler;
  const respond = vi.fn();
  await handler({
    params: { sessionKey: 'session-1', failureMessageIds: Array(251).fill('failure') },
    respond,
  });
  expect(sdk.readVisibleSessionTranscriptMessageEntries).not.toHaveBeenCalled();
  await handler({ params: { sessionKey: 'session-1', failureMessageIds: ['failure'] }, respond });
  expect(respond.mock.calls[1][1].failureDetails.failure.errorMessage).toHaveLength(2000);
});

test('reads one native transcript message through advancing bounded chunks', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const message = { role: 'toolResult', content: `head:${'x'.repeat(200)}:tail` };
  sdk.getSessionEntry.mockReturnValue({ sessionId: 'native-session-1' });
  sdk.readVisibleSessionTranscriptMessageEntries.mockResolvedValue([
    { entryId: 'message-1', message },
  ]);
  const { registerGatewayMethod } = registerPlugin();
  const handler = registerGatewayMethod.mock.calls.find(
    ([method]) => method === 'justdoRuntimeBridge.historyMessage',
  )?.[1] as HistoryHandler;
  const firstRespond = vi.fn();

  await handler({
    params: { sessionKey, messageId: 'message-1', cursor: 0, maxChars: 80 },
    respond: firstRespond,
  });

  const first = firstRespond.mock.calls[0]?.[1] as {
    chunk: string;
    complete: boolean;
    nextCursor: number;
    transferId: string;
  };
  expect(first.chunk).toHaveLength(80);
  expect(first.complete).toBe(false);
  const secondRespond = vi.fn();
  await handler({
    params: {
      sessionKey,
      messageId: 'message-1',
      cursor: first.nextCursor,
      maxChars: 1_024,
      transferId: first.transferId,
    },
    respond: secondRespond,
  });
  const second = secondRespond.mock.calls[0]?.[1] as { chunk: string; complete: boolean };

  expect(JSON.parse(first.chunk + second.chunk)).toEqual(message);
  expect(second.complete).toBe(true);
  expect(sdk.readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledWith({
    sessionKey,
    sessionId: 'native-session-1',
  });
  expect(sdk.readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledTimes(1);
});
