import { describe, expect, test, vi } from 'vitest';

const agentPatch = require('../../../../scripts/patches/v2026.7.1-2/027-agent-request-metadata.cjs') as {
  patchAgentStream: (content: string, filePath: string) => string;
};
const purposePatch = require('../../../../scripts/patches/v2026.7.1-2/028-request-purpose-metadata.cjs') as {
  patchNativeCompaction: (content: string, filePath: string) => string;
  patchSafeguardSummaryPipeline: (content: string, filePath: string) => string;
  patchSimpleCompletion: (content: string, filePath: string) => string;
};
const parentIdentityPatch =
  require('../../../../scripts/patches/v2026.7.1-2/026-parent-session-identity.cjs') as {
    transform: (content: string, filePath: string) => string;
  };

function agentMetadataWrapper(
  options: {
    logError?: (...args: unknown[]) => unknown;
    loadSessionEntry?: (params: Record<string, unknown>) => unknown;
    payloadMetadata?: Record<string, unknown>;
    resolveSessionAgentIds?: (params: {
      sessionKey?: string;
      config?: unknown;
    }) => { defaultAgentId: string; sessionAgentId: string };
    updateSessionEntry?: (...args: unknown[]) => unknown;
  } = {},
) {
  const transformed = agentPatch.patchAgentStream(
    `const streamWithPayloadPatch = () => {};
async function loadAttemptSessionEntryAfterQuotaMaintenance(params) { return params; }
function install(params) {
  activeSession.agent.streamFn = resolveEmbeddedAgentStreamFn({
    authStorage: params.authStorage
  });
  const providerTextTransforms = [];
  const nativeWebSearchPolicyContext = {};
  applyExtraParamsToAgent(activeSession.agent, params.config, params.provider, params.modelId, {}, "high", "main", ".", params.model, ".", undefined, {
    nativeWebSearchPolicyContext
  });
  if (codeModeControlsEnabledForRun) activeSession.agent.streamFn = createCodexNativeWebSearchWrapper(activeSession.agent.streamFn, {});
}
`,
    'agent-fixture.js',
  );
  const start = transformed.indexOf('const justDoLiteLLMMetadataApis');
  const end = transformed.indexOf(
    'async function loadAttemptSessionEntryAfterQuotaMaintenance',
    start,
  );
  const source = transformed.slice(start, end);
  const streamWithPayloadPatch = vi.fn(
    (
      _stream: unknown,
      _model: unknown,
      _context: unknown,
      _options: unknown,
      patchPayload: (payload: Record<string, unknown>) => void,
    ) => {
      const payload = { metadata: { retained: true, ...options.payloadMetadata } };
      patchPayload(payload);
      return payload;
    },
  );
  const factory = new Function(
    'log$2',
    'streamWithPayloadPatch',
    'resolveSessionAgentIds',
    'resolveStorePath',
    'loadSessionEntry',
    'updateSessionEntry',
    `${source}; return wrapJustDoAgentRequestMetadata;`,
  );
  return factory(
    { error: options.logError ?? vi.fn() },
    streamWithPayloadPatch,
    options.resolveSessionAgentIds ??
      (() => ({ defaultAgentId: 'main', sessionAgentId: 'main' })),
    () => 'sessions.json',
    options.loadSessionEntry ?? (() => undefined),
    options.updateSessionEntry ?? (() => Promise.resolve()),
  ) as (
    stream: () => unknown,
    params: Record<string, unknown>,
  ) => (model?: unknown, context?: unknown, options?: unknown) => unknown;
}

function simpleCompletionMetadataHelper() {
  const transformed = purposePatch.patchSimpleCompletion(
    `async function completeWithPreparedSimpleCompletionModel(params) {
\tconst completionModel = prepareModelForSimpleCompletion({
\t\tmodel: params.model,
\t\tcfg: params.cfg
\t});
  return completionModel;
}
function ensureCustomApiRegistered() {}
`,
    'simple-fixture.js',
  );
  const start = transformed.indexOf('const justDoLiteLLMSimpleCompletionProviders');
  const end = transformed.indexOf(
    'async function completeWithPreparedSimpleCompletionModel',
    start,
  );
  const source = transformed.slice(start, end);
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  const factory = new Function(
    'getApiProvider',
    'streamWithPayloadPatch',
    'ensureCustomApiRegistered',
    `${source}; return prepareJustDoMetadataSimpleCompletionModel;`,
  );
  const helper = factory(
    () => ({ streamSimple: () => undefined }),
    (
      _stream: unknown,
      _model: unknown,
      _context: unknown,
      _options: unknown,
      patchPayload: (payload: Record<string, unknown>) => void,
    ) => {
      const payload = { metadata: { retained: true, user_initiated: true } };
      patchPayload(payload);
      return payload;
    },
    (api: string, stream: (...args: unknown[]) => unknown) => registered.set(api, stream),
  ) as (
    model: Record<string, unknown>,
    purpose: string,
    sessionId: string,
  ) => Record<string, unknown>;
  return { helper, registered };
}

function compactionMetadataWrapper(createStream?: () => unknown) {
  const transformed = purposePatch.patchNativeCompaction(
    `import { i as streamSimple } from "./stream-fixture.js";
/** Converts agent-core Result values back to the legacy session compaction API shape. */
function unwrapCompactionResult(result) { return result; }
async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn) {
\treturn unwrapCompactionResult(await generateSummary$1(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, openClawAgentCoreRuntime));
}
var AgentSession = class {
  async compact(preparation, auth, options) {
    let compactionResult;
    compactionResult ??= unwrapCoreResult(await compact$1(preparation, this.model, auth.apiKey, auth.headers, options.customInstructions, options.signal, this.thinkingLevel, this.agent.streamFn));
  }
};
`,
    'native-fixture.js',
  );
  const start = transformed.indexOf('const justDoLiteLLMCompactionProviders');
  const end = transformed.indexOf('/** Converts agent-core Result', start);
  const source = transformed.slice(start, end);
  const factory = new Function(
    'streamSimple',
    'streamWithPayloadPatch',
    `${source}; return wrapJustDoCompactionRequestMetadata;`,
  );
  return factory(
    () => undefined,
    (
      _stream: unknown,
      _model: unknown,
      _context: unknown,
      _options: unknown,
      patchPayload: (payload: Record<string, unknown>) => void,
    ) => {
      const payload = { metadata: { user_initiated: true } };
      patchPayload(payload);
      return createStream?.() ?? payload;
    },
  ) as (
    stream: () => unknown,
    model: Record<string, unknown>,
    sessionId: string,
  ) => (model?: unknown, context?: unknown, options?: unknown) => unknown;
}

describe('OpenClaw v2026.7.1-2 request metadata isolation', () => {
  test('forwards compaction text deltas only to the matching recovery listener', () => {
    const listener = vi.fn();
    const listenerSymbol = Symbol.for('justdo.compaction-stream-listeners');
    (globalThis as Record<PropertyKey, unknown>)[listenerSymbol] = new Map([
      ['session-1', listener],
    ]);
    const originalPush = vi.fn();
    const wrap = compactionMetadataWrapper(() => ({ push: originalPush, result: vi.fn() }));

    try {
      const stream = wrap(
        vi.fn(),
        { provider: 'builtin_models', api: 'openai-completions' },
        'session-1',
      )() as { push(event: Record<string, unknown>): void };
      stream.push({ type: 'text_delta', delta: 'first ' });
      stream.push({ type: 'thinking_delta', delta: 'private' });
      stream.push({ type: 'text_delta', delta: 'second' });

      expect(listener.mock.calls).toEqual([['first '], ['second']]);
      expect(originalPush).toHaveBeenCalledTimes(3);
    } finally {
      delete (globalThis as Record<PropertyKey, unknown>)[listenerSymbol];
    }
  });

  test('agent metadata is limited to builtin_models openai-completions requests', () => {
    const wrap = agentMetadataWrapper();
    const original = vi.fn();
    const userRuns = new Set(['custom-run', 'responses-run']);
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for('justdo.litellm.user-runs')] = userRuns;

    const custom = wrap(original, {
      sessionId: 'session-custom',
      runId: 'custom-run',
      modelApi: 'openai-completions',
      modelProvider: 'strict-compatible',
    });
    const unsupportedApi = wrap(original, {
      sessionId: 'session-responses',
      runId: 'responses-run',
      modelApi: 'openai-responses',
      modelProvider: 'builtin_models',
    });

    expect(custom).toBe(original);
    expect(unsupportedApi).toBe(original);
    expect(userRuns).toEqual(new Set());
  });

  test('agent metadata keeps the stable session and marks only the first explicit request', () => {
    const wrap = agentMetadataWrapper();
    const userRuns = new Set(['run-1']);
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for('justdo.litellm.user-runs')] = userRuns;
    const stream = wrap(vi.fn(), {
      sessionId: 'session-1',
      runId: 'run-1',
      modelApi: 'openai-completions',
      modelProvider: 'builtin_models',
    });

    expect(stream()).toMatchObject({
      metadata: {
        session_id: 'session-1',
        request_purpose: 'agent',
        user_initiated: true,
      },
    });
    expect(stream()).toMatchObject({
      metadata: { session_id: 'session-1', request_purpose: 'agent' },
    });
    expect((stream() as { metadata: Record<string, unknown> }).metadata).not.toHaveProperty(
      'user_initiated',
    );
  });

  test('uses only the persisted direct parent and never guesses from the current parent entry', () => {
    const config = { session: { store: 'sessions.json' } };
    const resolveSessionAgentIds = vi.fn(() => ({
      defaultAgentId: 'main',
      sessionAgentId: 'main',
    }));
    const persisted = agentMetadataWrapper({
      loadSessionEntry: ({ sessionKey }) =>
        sessionKey === 'child'
          ? { sessionId: 'child-id', parentSessionId: 'persisted-parent' }
          : { sessionId: 'new-parent-generation' },
      resolveSessionAgentIds,
    });
    const persistedStream = persisted(vi.fn(), {
      sessionId: 'child-id',
      sessionKey: 'child',
      spawnedBy: 'parent',
      runId: 'subagent-run',
      modelApi: 'openai-completions',
      modelProvider: 'builtin_models',
      config,
    });

    expect(persistedStream()).toMatchObject({
      metadata: { parent_session_id: 'persisted-parent' },
    });
    expect(resolveSessionAgentIds.mock.calls).toEqual([[{ sessionKey: 'child', config }]]);

    const logError = vi.fn(() => {
      throw new Error('logger unavailable');
    });
    const missingSnapshot = agentMetadataWrapper({
      logError,
      loadSessionEntry: ({ sessionKey }) =>
        sessionKey === 'child'
          ? { sessionId: 'child-id' }
          : { sessionId: 'new-parent-generation' },
    });
    const payload = missingSnapshot(vi.fn(), {
      sessionId: 'child-id',
      sessionKey: 'child',
      spawnedBy: 'parent',
      runId: 'legacy-run',
      modelApi: 'openai-completions',
      modelProvider: 'builtin_models',
      config: {},
    })() as { metadata: Record<string, unknown> };

    expect(payload.metadata).not.toHaveProperty('parent_session_id');
    expect(logError).toHaveBeenCalledOnce();
    expect(logError.mock.calls[0]?.[0]).toContain(
      '[openclaw-agent-request-metadata] missing parent_session_id; continuing without parent metadata',
    );
    expect(logError.mock.calls[0]?.[0]).toContain('runId=legacy-run');
    expect(logError.mock.calls[0]?.[0]).toContain('sessionKey=child');
  });

  test('subagent metadata replaces stale reserved values with exact child and direct-parent IDs', () => {
    const parentSessionId = 'ee889a83-2407-48a7-bb5e-a15aef7ad0c1';
    const childSessionId = '9f52dfaa-5ba5-4c04-9fb6-a37e196e2db9';
    const parentRunId = 'justdo-parent-run';
    const subagentRunId = 'subagent-run';
    const userRuns = new Set([parentRunId]);
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for('justdo.litellm.user-runs')] = userRuns;
    const wrap = agentMetadataWrapper({
      loadSessionEntry: ({ sessionKey }) =>
        sessionKey === 'child'
          ? { sessionId: childSessionId, parentSessionId }
          : { sessionId: parentSessionId },
      payloadMetadata: {
        session_id: 'stale-session',
        parent_session_id: 'stale-parent',
        request_purpose: 'stale-purpose',
        user_initiated: true,
      },
    });

    try {
      expect(
        wrap(vi.fn(), {
          sessionId: childSessionId,
          sessionKey: 'child',
          spawnedBy: 'parent',
          runId: subagentRunId,
          modelApi: 'openai-completions',
          modelProvider: 'builtin_models',
          config: {},
        })(),
      ).toEqual({
        metadata: {
          retained: true,
          session_id: childSessionId,
          parent_session_id: parentSessionId,
          request_purpose: 'agent',
        },
      });
      expect(userRuns).toEqual(new Set([parentRunId]));
    } finally {
      delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for('justdo.litellm.user-runs')];
    }
  });

  test('subagent metadata never guesses a session ID and logs before continuing unmodified', () => {
    const logError = vi.fn(() => {
      throw new Error('logger unavailable');
    });
    const loadSessionEntry = vi.fn(() => {
      throw new Error('store unavailable');
    });
    const storedOnly = agentMetadataWrapper({
      logError,
      loadSessionEntry,
    });
    const original = vi.fn(() => ({ retained: true }));

    const stream = storedOnly(original, {
      sessionKey: 'child',
      spawnedBy: 'parent',
      runId: 'subagent-run',
      modelApi: 'openai-completions',
      modelProvider: 'builtin_models',
      config: {},
    });

    expect(stream).toBe(original);
    expect(stream()).toEqual({ retained: true });
    expect(logError).toHaveBeenCalledOnce();
    expect(logError.mock.calls[0]?.[0]).toContain(
      '[openclaw-agent-request-metadata] missing session_id; continuing without request metadata',
    );
    expect(logError.mock.calls[0]?.[0]).toContain('runId=subagent-run');
    expect(logError.mock.calls[0]?.[0]).toContain('sessionKey=child');
    expect(loadSessionEntry).not.toHaveBeenCalled();
  });

  test('subagent metadata never reads parent identity from a different child generation', () => {
    const activeSessionId = 'active-child-session';
    const wrap = agentMetadataWrapper({
      loadSessionEntry: ({ sessionKey }) =>
        sessionKey === 'child'
          ? { sessionId: 'newer-child-session', parentSessionId: 'stale-parent-session' }
          : { sessionId: 'live-parent-session' },
    });

    const payload = wrap(vi.fn(), {
      sessionId: activeSessionId,
      sessionKey: 'child',
      spawnedBy: 'parent',
      runId: 'active-run',
      modelApi: 'openai-completions',
      modelProvider: 'builtin_models',
      config: {},
    })() as { metadata: Record<string, unknown> };

    expect(payload.metadata).toMatchObject({
      session_id: activeSessionId,
      request_purpose: 'agent',
    });
    expect(payload.metadata).not.toHaveProperty('parent_session_id');
  });

  test('keeps metadata isolated across a large concurrent subagent batch', async () => {
    const identities = Array.from({ length: 128 }, (_, index) => ({
      sessionKey: `child-${index}`,
      sessionId: `child-session-${index}`,
      parentSessionId: `parent-session-${Math.floor(index / 8)}`,
    }));
    const entries = new Map(
      identities.map(identity => [
        identity.sessionKey,
        { sessionId: identity.sessionId, parentSessionId: identity.parentSessionId },
      ]),
    );
    const wrap = agentMetadataWrapper({
      loadSessionEntry: ({ sessionKey }) => entries.get(String(sessionKey)),
    });

    const payloads = await Promise.all(
      identities.map(async identity =>
        wrap(vi.fn(), {
          sessionId: identity.sessionId,
          sessionKey: identity.sessionKey,
          spawnedBy: `parent-${identity.parentSessionId}`,
          runId: `run-${identity.sessionId}`,
          modelApi: 'openai-completions',
          modelProvider: 'builtin_models',
          config: {},
        })(),
      ),
    );

    payloads.forEach((payload, index) => {
      expect(payload).toMatchObject({
        metadata: {
          session_id: identities[index]?.sessionId,
          parent_session_id: identities[index]?.parentSessionId,
          request_purpose: 'agent',
        },
      });
    });
  });

  test('rejects a legacy metadata wrapper and requires a clean runtime rebuild', () => {
    const legacySource = `const justDoLiteLLMMetadataApis = new Set(["openai-completions"]);
const justDoLiteLLMProviderIds = new Set(["builtin_models"]);
function wrapJustDoAgentRequestMetadata(streamFn, params) {
  const userRuns = globalThis[Symbol.for("justdo.litellm.user-runs")];
  if (!params.sessionId || !justDoLiteLLMProviderIds.has(params.modelProvider) || !justDoLiteLLMMetadataApis.has(params.modelApi)) {
    userRuns?.delete(params.runId);
    return streamFn;
  }
  const childAgentId = params.sessionKey ? resolveSessionAgentIds(params.sessionKey).agentId : void 0;
  const childStorePath = childAgentId ? resolveStorePath(params.config?.session?.store, { agentId: childAgentId }) : void 0;
  const childEntry = params.sessionKey && childStorePath ? loadSessionEntry({
    storePath: childStorePath,
    sessionKey: params.sessionKey
  }) : void 0;
  const parentAgentId = params.spawnedBy ? resolveSessionAgentIds(params.spawnedBy).agentId : void 0;
  const parentStorePath = parentAgentId ? resolveStorePath(params.config?.session?.store, { agentId: parentAgentId }) : void 0;
  const parentEntry = params.spawnedBy && parentStorePath ? loadSessionEntry({
    storePath: parentStorePath,
    sessionKey: params.spawnedBy
  }) : void 0;
  const persistedParentSessionId = typeof childEntry?.parentSessionId === "string"
    ? childEntry.parentSessionId
    : void 0;
  const legacyParentSessionId = typeof parentEntry?.sessionId === "string"
    ? parentEntry.sessionId
    : void 0;
  const parentSessionId = (persistedParentSessionId || legacyParentSessionId) !== params.sessionId
    ? persistedParentSessionId || legacyParentSessionId
    : void 0;
  if (!persistedParentSessionId && parentSessionId && params.sessionKey && childStorePath) {
    void updateSessionEntry({ storePath: childStorePath, sessionKey: params.sessionKey }, (entry) => {
      if (entry.sessionId !== params.sessionId || entry.parentSessionId) return null;
      return { parentSessionId };
    }, { skipMaintenance: true, takeCacheOwnership: true });
  }
  let firstRequest = true;
  return (model, context, options) => streamWithPayloadPatch(streamFn, model, context, options, (payload) => {
    const existing = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {};
    payload.metadata = {
      ...existing,
      session_id: params.sessionId,
      request_purpose: "agent"
    };
    if (parentSessionId) payload.metadata.parent_session_id = parentSessionId;
    if (firstRequest && userRuns?.delete(params.runId)) payload.metadata.user_initiated = true;
    firstRequest = false;
  });
}
function install(params) {
  activeSession.agent.streamFn = wrapJustDoAgentRequestMetadata(activeSession.agent.streamFn, {
    sessionId: params.sessionId,
    runId: params.runId,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    storePath: params.storePath,
    config: params.config,
    modelApi: params.model.api,
    modelProvider: params.model.provider
  });
  const nativeWebSearchPolicyContext = {};
  applyExtraParamsToAgent(activeSession.agent, params.config, params.provider, params.modelId, {}, "high", "main", ".", params.model, ".", undefined, {
    nativeWebSearchPolicyContext
  });
  if (codeModeControlsEnabledForRun) activeSession.agent.streamFn = createCodexNativeWebSearchWrapper(activeSession.agent.streamFn, {});
  return { modelProvider: params.model.provider };
}
`;

    expect(() => agentPatch.patchAgentStream(legacySource, 'legacy-agent-metadata.js')).toThrow(
      /legacy agent metadata wrapper requires a clean runtime rebuild/u,
    );
  });

  test('spawn admission snapshots the direct parent UUID into both native child commits', () => {
    const transformed = parentIdentityPatch.transform(
      `function buildDirectChildSessionPatch(patch) {
  const entry = {};
  if (typeof patch.spawnedBy === "string" && patch.spawnedBy.trim()) entry.spawnedBy = patch.spawnedBy.trim();
  return entry;
}
async function spawn() {
  const spawnedByKey = requesterInternalKey;
  const initialPatchError = await patchChildSession({
    spawnDepth: childDepth,
  });
  const spawnLineagePatchError = await patchChildSession({
    spawnedBy: spawnedByKey,
  });
}
`,
      'parent-fixture.js',
    );

    expect(transformed).toContain('resolveGatewaySessionStoreTarget({ cfg, key: spawnedByKey })');
    expect(transformed.match(/parentSessionId: justDoParentSessionId/g)).toHaveLength(2);
    expect(transformed).not.toContain('entry.sessionId =');
  });

  test('compaction metadata is scoped to builtin models and clears agent initiation', () => {
    const wrap = compactionMetadataWrapper();
    const original = vi.fn();
    expect(
      wrap(
        original,
        { provider: 'strict-compatible', api: 'openai-completions' },
        'session-custom',
      ),
    ).toBe(original);
    expect(
      wrap(original, { provider: 'justdo', api: 'openai-completions' }, 'session-legacy'),
    ).toBe(original);
    expect(
      wrap(original, { provider: 'builtin_models', api: 'openai-responses' }, 'session-responses'),
    ).toBe(original);

    const stream = wrap(
      original,
      { provider: 'builtin_models', api: 'openai-completions' },
      'session-compact',
    );
    expect(stream()).toEqual({
      metadata: {
        session_id: 'session-compact',
        request_purpose: 'context_compaction',
      },
    });
  });

  test('leaves older broad metadata allowlists untouched instead of narrowing them', () => {
    const currentNative = purposePatch.patchNativeCompaction(
      `import { i as streamSimple } from "./stream-fixture.js";
/** Converts agent-core Result values back to the legacy session compaction API shape. */
function unwrapCompactionResult(result) { return result; }
async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn) {
\treturn unwrapCompactionResult(await generateSummary$1(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, openClawAgentCoreRuntime));
}
var AgentSession = class {
  async compact(preparation, auth, options) {
    let compactionResult;
    compactionResult ??= unwrapCoreResult(await compact$1(preparation, this.model, auth.apiKey, auth.headers, options.customInstructions, options.signal, this.thinkingLevel, this.agent.streamFn));
  }
};`,
      'native-fixture.js',
    );
    const staleNative = currentNative
      .replace('["builtin_models"]', '["builtin_models", "justdo"]')
      .replace(
        '["openai-completions"]',
        '["openai-completions", "openai-responses", "azure-openai-responses"]',
      );

    expect(purposePatch.patchNativeCompaction(staleNative, 'native-fixture.js')).toBe(staleNative);

    const currentSimple = purposePatch.patchSimpleCompletion(
      `async function completeWithPreparedSimpleCompletionModel(params) {
\tconst completionModel = prepareModelForSimpleCompletion({
\t\tmodel: params.model,
\t\tcfg: params.cfg
\t});
  return completionModel;
}
function ensureCustomApiRegistered() {}`,
      'simple-fixture.js',
    );
    const staleSimple = currentSimple.replace(
      '["builtin_models"]',
      '["builtin_models", "justdo"]',
    );

    expect(purposePatch.patchSimpleCompletion(staleSimple, 'simple-fixture.js')).toBe(staleSimple);
  });

  test('exec-review metadata leaves strict-compatible models untouched', () => {
    const { helper, registered } = simpleCompletionMetadataHelper();
    const custom = { provider: 'custom', api: 'openai-completions', id: 'strict' };
    expect(helper(custom, 'exec_review', 'session-custom')).toBe(custom);
    expect(registered.size).toBe(0);

    const prepared = helper(
      { provider: 'builtin_models', api: 'openai-completions', id: 'reviewer' },
      'exec_review',
      'session-review',
    );
    const stream = registered.get(prepared.api as string);
    expect(stream?.({}, {}, {})).toEqual({
      metadata: { retained: true, session_id: 'session-review', request_purpose: 'exec_review' },
    });
  });

  test('safeguard retries pass session identity through every generated chunk', () => {
    const transformed = purposePatch.patchSafeguardSummaryPipeline(
      `const generateSummaryCompat = generateSummary$1;
async function summarizeChunks(params) {
  let summary;
  const effectiveInstructions = "instructions";
  for (const chunk of params.chunks) summary = await retryAsync(() => generateSummary(chunk, params.model, params.reserveTokens, params.apiKey, params.headers, params.signal, effectiveInstructions, summary), { attempts: 3 });
  return summary;
}
function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary) {
\tif (generateSummary$1.length >= 8) return generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary);
\treturn generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, signal, customInstructions, previousSummary);
}
`,
      'safeguard-fixture.js',
    );

    expect(transformed).toContain('summary, params.justDoCompactionSessionId)');
    expect(transformed).toContain('void 0, void 0, justDoCompactionSessionId)');
  });
});
