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
}`;

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
