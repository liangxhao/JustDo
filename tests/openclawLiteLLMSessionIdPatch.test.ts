import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

const { applyPatch, __testing } =
  require('../scripts/patches/v2026.6.11/016-litellm-session-id.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    __testing: Record<string, string>;
  };

const BUNDLE_FIXTURE = `function resolveEmbeddedAgentStreamFn(params) {
  return params.streamFn;
}
function wrapEmbeddedAgentStreamFn(inner, params) {
  return inner;
}
function generateSummary3(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary) {
  if (generateSummary2.length >= 8) return generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary);
  return generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, signal, customInstructions, previousSummary);
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
    expect(patched).toContain('JUSTDO_LITELLM_SESSION_ID');
    expect(patched).toContain('resolveEmbeddedAgentStreamFnWithoutLiteLLMSessionId(params)');
    expect(patched).toContain('session_id: normalizedSessionId');
    expect(patched).toContain('JUSTDO_LITELLM_COMPACTION_SESSION_ID');
    expect(patched).toContain('sessionId: runtime3?.sessionId');
    expect(patched).toContain(
      'createLiteLLMSessionSummaryStreamFn(sessionId, model.api)',
    );
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('injects session_id while preserving existing OpenAI-compatible metadata', async () => {
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
export { wrapStreamFnWithLiteLLMSessionId };
`,
      'utf8',
    );
    const harness = (await import(`${pathToFileURL(harnessPath).href}?test=${Date.now()}`)) as {
      wrapStreamFnWithLiteLLMSessionId: (
        streamFn: (...args: unknown[]) => unknown,
        sessionId: string,
        modelApi: string,
      ) => (...args: unknown[]) => unknown;
    };
    let payload: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      metadata: { tenant: 'team-a', session_id: 'stale-session' },
    };
    const streamFn = (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
      const onPayload = options.onPayload as ((value: Record<string, unknown>) => void) | undefined;
      onPayload?.(payload);
    };

    harness.wrapStreamFnWithLiteLLMSessionId(
      streamFn,
      ' openclaw-session-123 ',
      'openai-completions',
    )({}, {}, {});

    expect(payload.metadata).toEqual({
      tenant: 'team-a',
      session_id: 'openclaw-session-123',
    });

    payload = { model: 'claude' };
    harness.wrapStreamFnWithLiteLLMSessionId(
      streamFn,
      'openclaw-session-123',
      'anthropic-messages',
    )({}, {}, {});
    expect(payload).not.toHaveProperty('metadata');
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
    );

    expect(payload.metadata).toEqual({
      tenant: 'team-a',
      session_id: 'gateway-session-123',
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
      /\nfunction createLiteLLMSessionSummaryStreamFn[\s\S]*\n}\n$/,
      '\n',
    );
    const chatOnlyBundle = BUNDLE_FIXTURE
      .replace(
        'function resolveEmbeddedAgentStreamFn(params) {',
        `${legacyHelperSource}
function resolveEmbeddedAgentStreamFnWithoutLiteLLMSessionId(params) {`,
      )
      .replace(
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
