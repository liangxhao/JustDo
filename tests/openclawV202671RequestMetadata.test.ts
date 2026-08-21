import { describe, expect, test, vi } from 'vitest';

const agentPatch = require('../scripts/patches/v2026.7.1-2/027-agent-request-metadata.cjs') as {
  patchAgentStream: (content: string, filePath: string) => string;
};
const purposePatch = require('../scripts/patches/v2026.7.1-2/028-request-purpose-metadata.cjs') as {
  patchNativeCompaction: (content: string, filePath: string) => string;
  patchSafeguardSummaryPipeline: (content: string, filePath: string) => string;
  patchSimpleCompletion: (content: string, filePath: string) => string;
};
const parentIdentityPatch =
  require('../scripts/patches/v2026.7.1-2/026-parent-session-identity.cjs') as {
    transform: (content: string, filePath: string) => string;
  };

function agentMetadataWrapper(
  options: {
    loadSessionEntry?: (params: Record<string, unknown>) => unknown;
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
      const payload = { metadata: { retained: true } };
      patchPayload(payload);
      return payload;
    },
  );
  const factory = new Function(
    'streamWithPayloadPatch',
    'resolveSessionAgentIds',
    'resolveStorePath',
    'loadSessionEntry',
    'updateSessionEntry',
    `${source}; return wrapJustDoAgentRequestMetadata;`,
  );
  return factory(
    streamWithPayloadPatch,
    () => ({ agentId: 'main' }),
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

  test('agent metadata is LiteLLM-only and consumes rejected one-shot bookkeeping', () => {
    const wrap = agentMetadataWrapper();
    const original = vi.fn();
    const userRuns = new Set(['custom-run']);
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for('justdo.litellm.user-runs')] = userRuns;

    const custom = wrap(original, {
      sessionId: 'session-custom',
      runId: 'custom-run',
      modelApi: 'openai-completions',
      modelProvider: 'strict-compatible',
    });

    expect(custom).toBe(original);
    expect(userRuns.has('custom-run')).toBe(false);
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

  test('persisted direct parent wins and legacy lineage backfills without rewriting stable IDs', () => {
    const updateSessionEntry = vi.fn(() => Promise.resolve());
    const persisted = agentMetadataWrapper({
      loadSessionEntry: ({ sessionKey }) =>
        sessionKey === 'child'
          ? { sessionId: 'child-id', parentSessionId: 'persisted-parent' }
          : { sessionId: 'legacy-parent' },
      updateSessionEntry,
    });
    const persistedStream = persisted(vi.fn(), {
      sessionId: 'child-id',
      sessionKey: 'child',
      spawnedBy: 'parent',
      runId: 'subagent-run',
      modelApi: 'openai-completions',
      modelProvider: 'builtin_models',
      config: {},
    });

    expect(persistedStream()).toMatchObject({
      metadata: { parent_session_id: 'persisted-parent' },
    });
    expect(updateSessionEntry).not.toHaveBeenCalled();

    const backfill = vi.fn(() => Promise.resolve());
    const legacy = agentMetadataWrapper({
      loadSessionEntry: ({ sessionKey }) =>
        sessionKey === 'child' ? { sessionId: 'child-id' } : { sessionId: 'legacy-parent' },
      updateSessionEntry: backfill,
    });
    legacy(vi.fn(), {
      sessionId: 'child-id',
      sessionKey: 'child',
      spawnedBy: 'parent',
      runId: 'legacy-run',
      modelApi: 'openai-completions',
      modelProvider: 'builtin_models',
      config: {},
    });

    expect(backfill).toHaveBeenCalledOnce();
    const updater = backfill.mock.calls[0]?.[1] as (entry: Record<string, unknown>) => unknown;
    expect(updater({ sessionId: 'child-id' })).toEqual({
      parentSessionId: 'legacy-parent',
    });
    expect(updater({ sessionId: 'child-id', parentSessionId: 'already-stable' })).toBeNull();
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
