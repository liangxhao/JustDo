import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test, vi } from 'vitest';

const { applyPatch, verifyPatch, __testing } =
  require('../../../../scripts/patches/v2026.6.11/016-litellm-session-id.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => boolean;
    __testing: Record<string, string>;
  };

const BUNDLE_FIXTURE = `function resolveEmbeddedAgentStreamFn(params) {
  return params.streamFn;
}
function wrapEmbeddedAgentStreamFn(inner, params) {
  return inner;
}
const ChatSendParamsSchema = typebox_exports.Object({
      systemInputProvenance: typebox_exports.Optional(InputProvenanceSchema),
      systemProvenanceReceipt: typebox_exports.Optional(typebox_exports.String()),
});
function handleChatSend(p4, clientRunId, sessionKey) {
          context.addChatRun(clientRunId, {
            sessionKey,
  return p4;
}
function configureAttemptStream(params) {
  return resolveEmbeddedAgentStreamFn({
        sessionId: params.sessionId,
        promptCacheKey: params.promptCacheKey,
  });
}
function configureCompactionStream(params) {
  return resolveEmbeddedAgentStreamFn({
    providerStreamFn: params.providerStreamFn,
    sessionId: params.sessionId,
    signal: params.signal,
  });
}
function configureBtwStream(params, sessionId, runtimeModel) {
  return resolveEmbeddedAgentStreamFn({
    sessionId,
    signal: params.opts?.abortSignal,
    model: runtimeModel,
  });
}
function buildDirectChildSessionPatch(patch) {
  const entry = {};
  if (typeof patch.spawnedBy === "string" && patch.spawnedBy.trim()) entry.spawnedBy = patch.spawnedBy.trim();
  return entry;
}
async function spawnSubagentFixture(requesterInternalKey) {
  const spawnedByKey = requesterInternalKey;
  const childCapabilities = resolveSubagentCapabilities({
    depth: 1
  });
  const spawnLineagePatchError = await patchChildSession({
    spawnedBy: spawnedByKey,
  });
  return { childCapabilities, spawnLineagePatchError };
}
async function completeWithPreparedSimpleCompletionModel(params) {
  const completionModel = params.model;
  const { reasoning: rawReasoning, ...options2 } = params.options ?? {};
  const reasoning = rawReasoning;
  return await completeSimple(completionModel, params.context, {
    ...options2,
    ...reasoning ? { reasoning } : {},
    apiKey: params.auth.apiKey
  });
}
async function createModelExecAutoReviewer(params) {
  return completeWithPreparedSimpleCompletionModel({
        options: {
          maxTokens: EXEC_REVIEWER_MAX_TOKENS,
          temperature: 0,
          signal: completionController.signal
        }
  });
}
function createExecTool(defaults4, agentId) {
  const autoReviewer = defaults4?.autoReviewer ?? createModelExecAutoReviewer({
    cfg: defaults4?.config,
    agentId,
    reviewer: resolveExecReviewerDefaults({
  });
}
function generateSummary3(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary) {
  if (generateSummary2.length >= 8) return generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary);
  return generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, signal, customInstructions, previousSummary);
}
async function runCompactionWork(preparation, compactionModel, auth2, options2) {
        compactionResult ??= unwrapCoreResult(await compact(preparation, this.model, auth2.apiKey, auth2.headers, options2.customInstructions, options2.signal, this.thinkingLevel, this.agent.streamFn));
}
generateSummary3(chunk, params.model, params.reserveTokens, params.apiKey, params.headers, params.signal, effectiveInstructions, summary);
compactionSafeguardDeps.summarizeInStages({
    summarizationInstructions: params.summarizationInstructions,
    previousSummary: void 0
});
setCompactionSafeguardRuntime(params.sessionManager, {
      model: params.model,
      recentTurnsPreserve:
});
buildEmbeddedExtensionFactories({
          cfg: params.config,
          sessionManager,
          provider: params.provider,
});
buildEmbeddedExtensionFactories({
          cfg: params.config,
          sessionManager,
          provider,
          modelId,
});
summarizeViaLLM({
            model,
            apiKey,
            headers,
            signal,
                summarizationInstructions,
                previousSummary: preparation.previousSummary
});
summarizeViaLLM({
            model,
            apiKey,
            headers,
            signal,
            summarizationInstructions,
            previousSummary: effectivePreviousSummary
});
summary = \`\${await summarizeViaLLM({
            model,
            apiKey,
            headers,
            signal,
              summarizationInstructions,
              previousSummary: void 0
            })}\`;`;

test('patches the OpenClaw stream resolver idempotently', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-litellm-session-patch-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');
    expect(patched).toContain('JUSTDO_LITELLM_REQUEST_METADATA_V9');
    expect(patched).toContain('JUSTDO_LITELLM_USER_INITIATED_SCHEMA_V1');
    expect(patched).toContain('JUSTDO_LITELLM_USER_INITIATED_REGISTER_V1');
    expect(patched).toContain(
      'justdoUserInitiated: typebox_exports.Optional(typebox_exports.Boolean())',
    );
    expect(patched).toContain('registerLiteLLMUserChatRunFromChatSend(p4, clientRunId)');
    expect(patched).toContain('JUSTDO_LITELLM_PARENT_SESSION_ID');
    expect(patched).toContain('resolveEmbeddedAgentStreamFnWithoutLiteLLMSessionId(params)');
    expect(patched).toContain('session_id: normalizedSessionId');
    expect(patched).toContain('payload.metadata.parent_session_id = normalizedParentSessionId');
    expect(patched).toContain('request_purpose: normalizedRequestPurpose');
    expect(patched).toContain('runId: params.runId');
    expect(patched).toContain('payload.metadata.user_initiated = true');
    expect(patched).toContain('let userInitiationPending = Boolean(normalizedRunId)');
    expect(patched).toContain('JUSTDO_LITELLM_COMPACTION_SESSION_ID');
    expect(patched).toContain('JUSTDO_LITELLM_NATIVE_COMPACTION_REQUEST_METADATA');
    expect(patched).toContain('sessionId: runtime3?.sessionId');
    expect(patched).toContain(
      'createLiteLLMRequestMetadataStreamFn(sessionId, "context_compaction", model.api, parentSessionId)',
    );
    expect(patched).toContain('JUSTDO_LITELLM_EXEC_REVIEW_REQUEST_METADATA');
    expect(patched).toContain('JUSTDO_LITELLM_EXEC_REVIEW_SESSION_ID');
    expect(patched).toContain('sessionId: defaults4?.sessionId');
    expect(patched).toContain('parentSessionId: resolveLiteLLMParentSessionId({');
    expect(patched).toContain('entry.parentSessionId = patch.parentSessionId.trim()');
    expect(verifyPatch(runtimeDir)).toBe(true);
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('patches native compaction after the emergency fallback patch has run', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-litellm-post-019-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    const postEmergencyFallbackBundle = BUNDLE_FIXTURE.replace(
      '        compactionResult ??= unwrapCoreResult(await compact(preparation, this.model, auth2.apiKey, auth2.headers, options2.customInstructions, options2.signal, this.thinkingLevel, this.agent.streamFn));',
      '          compactionResult = unwrapCoreResult(await compact(preparation, compactionModel, auth2.apiKey, auth2.headers, options2.customInstructions, options2.signal, this.thinkingLevel, this.agent.streamFn));',
    );
    fs.writeFileSync(bundlePath, postEmergencyFallbackBundle, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');
    expect(patched).toContain('JUSTDO_LITELLM_NATIVE_COMPACTION_REQUEST_METADATA');
    expect(patched).toContain('compactionModel.api');
    expect(patched).toContain('this.thinkingLevel, compactionStreamFn));');
    expect(verifyPatch(runtimeDir)).toBe(true);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('threads the authoritative Gateway UUID through the standard exec reviewer factory', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-litellm-review-factory-'));
  try {
    const harnessPath = path.join(runtimeDir, 'review-factory.mjs');
    fs.writeFileSync(
      harnessPath,
      `let capturedParams;
function createModelExecAutoReviewer(params) {
  capturedParams = params;
  return () => ({ decision: "ask" });
}
function resolveExecReviewerDefaults({ defaults }) {
  return defaults.reviewer;
}
function resolveLiteLLMParentSessionId(params) {
  return params.sessionKey === "agent:main:subagent:child" ? "gateway-parent-123" : undefined;
}
function createExecTool(defaults4, agentId) {
${__testing.PATCHED_EXEC_REVIEWER_FACTORY}
      defaults: defaults4,
      agentId
    })
  });
  return { autoReviewer, capturedParams };
}
export { createExecTool };
`,
      'utf8',
    );
    const harness = (await import(`${pathToFileURL(harnessPath).href}?test=${Date.now()}`)) as {
      createExecTool: (
        defaults: Record<string, unknown>,
        agentId: string,
      ) => { capturedParams: Record<string, unknown> };
    };
    const reviewer = { model: 'review-provider/review-model' };

    const result = harness.createExecTool(
      {
        config: { tools: { exec: { reviewer } } },
        reviewer,
        sessionId: 'gateway-session-789',
        sessionKey: 'agent:main:subagent:child',
      },
      'main',
    );

    expect(result.capturedParams).toMatchObject({
      agentId: 'main',
      sessionId: 'gateway-session-789',
      parentSessionId: 'gateway-parent-123',
      reviewer,
    });
    expect(result.capturedParams.sessionId).not.toBe('agent:main:local-key-must-not-be-used');

    const missingUuidResult = harness.createExecTool(
      {
        config: { tools: { exec: { reviewer } } },
        reviewer,
        sessionKey: 'agent:main:must-not-be-used-as-a-fallback',
      },
      'main',
    );
    expect(missingUuidResult.capturedParams.sessionId).toBeUndefined();
    expect(missingUuidResult.capturedParams.parentSessionId).toBeUndefined();
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('injects authoritative agent request metadata while preserving existing metadata', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-litellm-session-helper-'));
  try {
    const harnessPath = path.join(runtimeDir, 'helper.mjs');
    fs.writeFileSync(
      harnessPath,
      `function streamWithPayloadPatch(underlying, model, context, options, patchPayload) {
  return underlying(model, context, {
    ...options,
    onPayload(payload) {
      patchPayload(payload);
      return options?.onPayload?.(payload, model);
    }
  });
}
${__testing.HELPER_SOURCE}
export {
  createLiteLLMContextCompactionStreamFn,
  registerLiteLLMUserChatRun,
  registerLiteLLMUserChatRunFromChatSend,
  wrapStreamFnWithLiteLLMRequestMetadata
};
`,
      'utf8',
    );
    const harness = (await import(`${pathToFileURL(harnessPath).href}?test=${Date.now()}`)) as {
      wrapStreamFnWithLiteLLMRequestMetadata: (
        streamFn: (...args: unknown[]) => unknown,
        sessionId: string,
        requestPurpose: string,
        modelApi: string,
        parentSessionId?: string,
        runId?: string,
      ) => (...args: unknown[]) => unknown;
      registerLiteLLMUserChatRun: (runId: string) => void;
      registerLiteLLMUserChatRunFromChatSend: (
        params: Record<string, unknown>,
        runId: string,
      ) => boolean;
      createLiteLLMContextCompactionStreamFn: (
        streamFn: (...args: unknown[]) => unknown,
        modelApi: string,
      ) => (...args: unknown[]) => unknown;
    };
    let payload: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      metadata: {
        tenant: 'team-a',
        session_id: 'stale-session',
        request_purpose: 'stale-purpose',
        parent_session_id: 'stale-parent',
        user_initiated: false,
      },
    };
    let shouldEmitPayload = true;
    const streamFn = (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
      const onPayload = options.onPayload as ((value: Record<string, unknown>) => void) | undefined;
      if (shouldEmitPayload) onPayload?.(payload);
    };

    expect(
      harness.registerLiteLLMUserChatRunFromChatSend(
        { systemProvenanceReceipt: '[system receipt]' },
        'skill-workshop-run',
      ),
    ).toBe(false);
    expect(harness.registerLiteLLMUserChatRunFromChatSend({}, 'talk-consult-run')).toBe(false);
    expect(
      harness.registerLiteLLMUserChatRunFromChatSend(
        { justdoUserInitiated: true },
        'explicit-user-run',
      ),
    ).toBe(true);

    harness.wrapStreamFnWithLiteLLMRequestMetadata(
      streamFn,
      ' openclaw-session-123 ',
      ' agent ',
      'openai-completions',
      ' gateway-parent-123 ',
      'explicit-user-run',
    )({}, {}, {});

    expect(payload.metadata).toEqual({
      tenant: 'team-a',
      session_id: 'openclaw-session-123',
      request_purpose: 'agent',
      parent_session_id: 'gateway-parent-123',
      user_initiated: true,
    });

    payload = {
      model: 'deepseek-v4-flash',
      metadata: { user_initiated: true },
    };
    harness.registerLiteLLMUserChatRun('run-user-456');
    const userInitiatedStream = harness.wrapStreamFnWithLiteLLMRequestMetadata(
      streamFn,
      'openclaw-session-456',
      'agent',
      'openai-completions',
      undefined,
      'run-user-456',
    );
    userInitiatedStream({}, {}, {});
    expect(payload.metadata).toEqual({
      session_id: 'openclaw-session-456',
      request_purpose: 'agent',
      user_initiated: true,
    });
    payload = {
      model: 'deepseek-v4-flash',
      metadata: { user_initiated: true },
    };
    userInitiatedStream({}, {}, {});
    expect(payload.metadata).toEqual({
      session_id: 'openclaw-session-456',
      request_purpose: 'agent',
    });

    harness.registerLiteLLMUserChatRun('run-user-retry');
    const retryingUserStream = harness.wrapStreamFnWithLiteLLMRequestMetadata(
      streamFn,
      'openclaw-session-retry',
      'agent',
      'openai-completions',
      undefined,
      'run-user-retry',
    );
    shouldEmitPayload = false;
    retryingUserStream({}, {}, {});
    shouldEmitPayload = true;
    payload = { model: 'deepseek-v4-flash' };
    retryingUserStream({}, {}, {});
    expect(payload.metadata).toEqual({
      session_id: 'openclaw-session-retry',
      request_purpose: 'agent',
      user_initiated: true,
    });

    payload = { model: 'deepseek-v4-flash' };
    harness.wrapStreamFnWithLiteLLMRequestMetadata(
      streamFn,
      'openclaw-session-456',
      'agent',
      'openai-completions',
      undefined,
      'run-user-456',
    )({}, {}, {});
    expect(payload.metadata).toEqual({
      session_id: 'openclaw-session-456',
      request_purpose: 'agent',
    });

    payload = { model: 'claude' };
    harness.wrapStreamFnWithLiteLLMRequestMetadata(
      streamFn,
      'openclaw-session-123',
      'agent',
      'anthropic-messages',
    )({}, {}, {});
    expect(payload).not.toHaveProperty('metadata');

    payload = {
      model: 'deepseek-v4-flash',
      metadata: { parent_session_id: 'stale-parent', user_initiated: true },
    };
    harness.wrapStreamFnWithLiteLLMRequestMetadata(
      streamFn,
      'openclaw-session-123',
      'agent',
      'openai-completions',
      'openclaw-session-123',
    )({}, {}, {});
    expect(payload.metadata).toEqual({
      session_id: 'openclaw-session-123',
      request_purpose: 'agent',
    });

    harness.registerLiteLLMUserChatRun('run-before-auto-compaction');
    const agentStream = harness.wrapStreamFnWithLiteLLMRequestMetadata(
      streamFn,
      'openclaw-compaction-session',
      'agent',
      'openai-completions',
      'openclaw-parent-session',
      'run-before-auto-compaction',
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      payload = {
        model: 'deepseek-v4-flash',
        metadata: { tenant: 'team-a', user_initiated: true },
      };
      harness.createLiteLLMContextCompactionStreamFn(agentStream, 'openai-completions')({}, {}, {});
      expect(payload.metadata).toEqual({
        tenant: 'team-a',
        session_id: 'openclaw-compaction-session',
        request_purpose: 'context_compaction',
        parent_session_id: 'openclaw-parent-session',
      });
    }

    payload = { model: 'claude' };
    harness.createLiteLLMContextCompactionStreamFn(agentStream, 'anthropic-messages')({}, {}, {});
    expect(payload).toEqual({ model: 'claude' });

    payload = { model: 'deepseek-v4-flash' };
    agentStream({}, {}, {});
    expect(payload.metadata).toEqual({
      session_id: 'openclaw-compaction-session',
      request_purpose: 'agent',
      parent_session_id: 'openclaw-parent-session',
      user_initiated: true,
    });

    expect(harness.createLiteLLMContextCompactionStreamFn(streamFn, 'openai-completions')).toBe(
      streamFn,
    );

    payload = { model: 'deepseek-v4-flash' };
    harness.wrapStreamFnWithLiteLLMRequestMetadata(
      streamFn,
      '   ',
      'exec_review',
      'openai-completions',
    )({}, {}, {});
    expect(payload).not.toHaveProperty('metadata');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('resolves and backfills stable direct-parent UUIDs for legacy nested subagents', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-litellm-lineage-helper-'));
  try {
    const harnessPath = path.join(runtimeDir, 'lineage-helper.mjs');
    fs.writeFileSync(
      harnessPath,
      `const store = {
  "agent:main:root": { sessionId: "stale-root-session", updatedAt: 1 },
  "legacy:root": { sessionId: "root-session", updatedAt: 2 },
  "agent:main:subagent:child": {
    sessionId: "child-session",
    spawnedBy: "agent:main:root",
    updatedAt: 3
  },
  "agent:main:subagent:grandchild": {
    sessionId: "grandchild-session",
    spawnedBy: "agent:main:subagent:child",
    updatedAt: 4
  },
  "agent:main:subagent:failed": {
    sessionId: "failed-child-session",
    spawnedBy: "agent:main:root",
    updatedAt: 5
  },
  "agent:main:subagent:self-parent": {
    sessionId: "self-child-session",
    parentSessionId: "self-child-session",
    spawnedBy: "agent:main:root",
    updatedAt: 6
  }
};
function resolveGatewaySessionStoreTargetWithStore({ key }) {
  return {
    storePath: "sessions.json",
    canonicalKey: key,
    storeKeys: key === "agent:main:root" ? [key, "legacy:root"] : [key],
    store
  };
}
function findFreshestStoreMatch(targetStore, ...keys) {
  let freshest;
  for (const key of keys) {
    const entry = targetStore[key];
    if (entry && (!freshest || (entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0))) {
      freshest = { key, entry };
    }
  }
  return freshest;
}
const pendingUpdates = [];
function updateSubagentSessionStore(_storePath, mutator) {
  return new Promise((resolve, reject) => pendingUpdates.push({ mutator, resolve, reject }));
}
function flushNextUpdate() {
  const pending = pendingUpdates.shift();
  pending?.mutator(store);
  pending?.resolve();
}
function rejectNextUpdate() {
  pendingUpdates.shift()?.reject(new Error("write failed"));
}
function mergeSessionEntry(existing, patch) {
  return { ...existing, ...patch };
}
function streamWithPayloadPatch() {}
${__testing.HELPER_SOURCE}
function getParentSessionCacheSize() {
  return JUSTDO_LITELLM_PARENT_SESSION_CACHE.size;
}
export {
  flushNextUpdate,
  getParentSessionCacheSize,
  rejectNextUpdate,
  resolveLiteLLMParentSessionId,
  resolveLiteLLMSessionIdForKey,
  store
};
`,
      'utf8',
    );
    const harness = (await import(`${pathToFileURL(harnessPath).href}?test=${Date.now()}`)) as {
      store: Record<string, Record<string, unknown>>;
      flushNextUpdate: () => void;
      getParentSessionCacheSize: () => number;
      rejectNextUpdate: () => void;
      resolveLiteLLMParentSessionId: (params: Record<string, unknown>) => string | undefined;
      resolveLiteLLMSessionIdForKey: (config: unknown, sessionKey: string) => string | undefined;
    };
    const config = {};

    expect(
      harness.resolveLiteLLMParentSessionId({
        config,
        sessionKey: 'agent:main:root',
        sessionId: 'root-session',
      }),
    ).toBeUndefined();
    expect(harness.resolveLiteLLMSessionIdForKey(config, 'agent:main:root')).toBe('root-session');
    expect(
      harness.resolveLiteLLMParentSessionId({
        config,
        sessionKey: 'agent:main:subagent:child',
        sessionId: 'child-session',
      }),
    ).toBe('root-session');
    expect(harness.getParentSessionCacheSize()).toBe(1);
    harness.store['legacy:root']!.sessionId = 'rotated-root-session';
    expect(
      harness.resolveLiteLLMParentSessionId({
        config,
        sessionKey: 'agent:main:subagent:child',
        sessionId: 'child-session',
      }),
    ).toBe('root-session');
    harness.flushNextUpdate();
    await Promise.resolve();
    expect(harness.getParentSessionCacheSize()).toBe(0);
    expect(harness.store['agent:main:subagent:child']?.parentSessionId).toBe('root-session');

    expect(
      harness.resolveLiteLLMParentSessionId({
        config,
        sessionKey: 'agent:main:subagent:child',
        sessionId: 'child-session',
      }),
    ).toBe('root-session');
    expect(
      harness.resolveLiteLLMParentSessionId({
        config,
        sessionKey: 'agent:main:subagent:grandchild',
        sessionId: 'grandchild-session',
      }),
    ).toBe('child-session');
    harness.flushNextUpdate();
    await Promise.resolve();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      harness.resolveLiteLLMParentSessionId({
        config,
        sessionKey: 'agent:main:subagent:failed',
        sessionId: 'failed-child-session',
      }),
    ).toBe('rotated-root-session');
    harness.rejectNextUpdate();
    await Promise.resolve();
    expect(harness.getParentSessionCacheSize()).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[JustDoLiteLLMMetadata] Failed to persist parent_session_id for a legacy child session.',
    );
    warn.mockRestore();

    expect(
      harness.resolveLiteLLMParentSessionId({
        config,
        sessionKey: 'agent:main:subagent:self-parent',
        sessionId: 'self-child-session',
      }),
    ).toBe('rotated-root-session');
    harness.flushNextUpdate();
    await Promise.resolve();
    expect(harness.getParentSessionCacheSize()).toBe(1);
    expect(harness.store['agent:main:subagent:self-parent']?.parentSessionId).toBe(
      'rotated-root-session',
    );
    harness.store['legacy:root']!.sessionId = 'second-rotated-root-session';
    expect(
      harness.resolveLiteLLMParentSessionId({
        config,
        sessionKey: 'agent:main:subagent:self-parent',
        sessionId: 'self-child-session',
      }),
    ).toBe('rotated-root-session');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('injects exec_review metadata through the simple-completion transport only', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-litellm-review-helper-'));
  try {
    const harnessPath = path.join(runtimeDir, 'review-helper.mjs');
    fs.writeFileSync(
      harnessPath,
      `function streamWithPayloadPatch(underlying, model, context, options, patchPayload) {
  return underlying(model, context, {
    ...options,
    onPayload(payload) {
      patchPayload(payload);
      return options?.onPayload?.(payload, model);
    }
  });
}
const streamSimple = (model, context, options) => ({
  async result() {
    const payload = { model: model.id, metadata: { tenant: "team-a" } };
    options?.onPayload?.(payload);
    return { payload, context };
  }
});
const completeSimple = (model, context, options) => ({
  transport: "completeSimple",
  model,
  context,
  options
});
const prepareModelForSimpleCompletion = ({ model }) => model;
const normalizeSimpleCompletionReasoning = value => value;
${__testing.HELPER_SOURCE}
async function completeWithPreparedSimpleCompletionModel(params) {
  const completionModel = prepareModelForSimpleCompletion({ model: params.model, cfg: params.cfg });
  const { reasoning: rawReasoning, ...options2 } = params.options ?? {};
  const reasoning = normalizeSimpleCompletionReasoning(rawReasoning);
${__testing.PATCHED_SIMPLE_COMPLETION}
}
export { completeWithPreparedSimpleCompletionModel };
`,
      'utf8',
    );
    const harness = (await import(`${pathToFileURL(harnessPath).href}?test=${Date.now()}`)) as {
      completeWithPreparedSimpleCompletionModel: (params: Record<string, unknown>) => Promise<{
        payload: Record<string, unknown>;
        context: Record<string, unknown>;
      }>;
    };
    const context = {
      systemPrompt: 'Review exactly one pending shell command.',
      messages: [{ role: 'user', content: 'Review command data.' }],
    };

    const result = await harness.completeWithPreparedSimpleCompletionModel({
      model: { id: 'review-model', api: 'openai-completions' },
      auth: { apiKey: 'test-key' },
      context,
      requestMetadata: {
        sessionId: ' gateway-session-456 ',
        requestPurpose: 'exec_review',
        parentSessionId: ' gateway-parent-123 ',
      },
    });

    expect(result.payload.metadata).toEqual({
      tenant: 'team-a',
      session_id: 'gateway-session-456',
      request_purpose: 'exec_review',
      parent_session_id: 'gateway-parent-123',
    });
    expect(result.context).toEqual(context);
    expect(JSON.stringify(result.context)).not.toContain('gateway-session-456');

    const unsupportedResult = await harness.completeWithPreparedSimpleCompletionModel({
      model: { id: 'review-model', api: 'anthropic-messages' },
      auth: { apiKey: 'test-key' },
      context,
      requestMetadata: {
        sessionId: 'gateway-session-456',
        requestPurpose: 'exec_review',
      },
    });
    expect(unsupportedResult).toMatchObject({ transport: 'completeSimple', context });
    expect(JSON.stringify(unsupportedResult)).not.toContain('session_id');
    expect(JSON.stringify(unsupportedResult)).not.toContain('request_purpose');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('injects session_id into safeguard compaction summary payloads', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-litellm-compaction-helper-'));
  try {
    const harnessPath = path.join(runtimeDir, 'compaction-helper.mjs');
    fs.writeFileSync(
      harnessPath,
      `function streamWithPayloadPatch(underlying, model, context, options, patchPayload) {
  return underlying(model, context, {
    ...options,
    onPayload(payload) {
      patchPayload(payload);
      return options?.onPayload?.(payload, model);
    }
  });
}
const streamSimple = (model, _context, options) => {
  const payload = { model: model.id, metadata: { tenant: "team-a" } };
  options?.onPayload?.(payload);
  return payload;
};
function generateSummary2(
  currentMessages,
  model,
  reserveTokens,
  apiKey,
  headers,
  signal,
  customInstructions,
  previousSummary,
  thinkingLevel,
  streamFn
) {
  return streamFn?.(model, { messages: currentMessages }, {});
}
const generateSummaryCompat = generateSummary2;
${__testing.HELPER_SOURCE}
${__testing.PATCHED_SUMMARY_GENERATION}
export { generateSummary3 };
`,
      'utf8',
    );
    const harness = (await import(`${pathToFileURL(harnessPath).href}?test=${Date.now()}`)) as {
      generateSummary3: (...args: unknown[]) => Record<string, unknown>;
    };

    const payload = harness.generateSummary3(
      [],
      { id: 'deepseek-v4-flash', api: 'openai-completions' },
      24_000,
      'test-key',
      {},
      undefined,
      undefined,
      undefined,
      'gateway-session-123',
      'gateway-parent-123',
    );

    expect(payload.metadata).toEqual({
      tenant: 'team-a',
      session_id: 'gateway-session-123',
      request_purpose: 'context_compaction',
      parent_session_id: 'gateway-parent-123',
    });
    expect(
      harness.generateSummary3(
        [],
        { id: 'claude', api: 'anthropic-messages' },
        24_000,
        'test-key',
        {},
        undefined,
        undefined,
        undefined,
        'gateway-session-123',
      ),
    ).toBeUndefined();
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('rejects an earlier chat-only patch revision and requires a pristine bundle', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-litellm-session-revision-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    const legacyHelperSource = __testing.HELPER_SOURCE.replace(
      'JUSTDO_LITELLM_REQUEST_METADATA_V9',
      'JUSTDO_LITELLM_REQUEST_METADATA_V8',
    );
    const chatOnlyBundle = BUNDLE_FIXTURE.replace(
      'function resolveEmbeddedAgentStreamFn(params) {',
      `${legacyHelperSource}
function resolveEmbeddedAgentStreamFnWithoutLiteLLMSessionId(params) {`,
    ).replace(
      'function wrapEmbeddedAgentStreamFn(inner, params) {',
      `${__testing.RESOLVER_WRAPPER}
function wrapEmbeddedAgentStreamFn(inner, params) {`,
    );
    fs.writeFileSync(bundlePath, chatOnlyBundle, 'utf8');

    expect(() => applyPatch(runtimeDir)).toThrow(
      /incomplete or earlier patch revision.*regenerate the pristine runtime/i,
    );
    expect(fs.readFileSync(bundlePath, 'utf8')).toBe(chatOnlyBundle);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('rejects a partially applied current revision instead of treating it as idempotent', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-litellm-session-partial-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');
    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const partiallyPatched = fs
      .readFileSync(bundlePath, 'utf8')
      .replace('JUSTDO_LITELLM_SIMPLE_COMPLETION_REQUEST_METADATA', 'REMOVED_SIMPLE_MARKER');
    fs.writeFileSync(bundlePath, partiallyPatched, 'utf8');

    expect(() => applyPatch(runtimeDir)).toThrow(
      /incomplete or earlier patch revision.*regenerate the pristine runtime/i,
    );
    expect(fs.readFileSync(bundlePath, 'utf8')).toBe(partiallyPatched);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('fails loudly when the upstream resolver patch point changes', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-litellm-session-mismatch-'));
  try {
    fs.writeFileSync(
      path.join(runtimeDir, 'gateway-bundle.mjs'),
      'function changedEmbeddedAgentStreamResolver() {}',
      'utf8',
    );

    expect(() => applyPatch(runtimeDir)).toThrow(/patch target not found/i);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
