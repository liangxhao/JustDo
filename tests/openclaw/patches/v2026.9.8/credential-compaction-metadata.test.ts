import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { expect, test } from 'vitest';

const { patchAgentStream } = require('../../../../scripts/patches/v2026.9.8/006-agent-request-metadata.cjs');
const { __testing: { COMPACTION_BLOCK } } = require('../../../../scripts/patches/v2026.9.8/007-request-purpose-metadata.cjs');

test.each(['gateway-bundle.mjs', 'worker.mjs', 'sqlite-store.worker.mjs', 'package-update-activation-recovery.mjs'])(
  'retains compaction purpose after the native credential wrapper in %s',
  async name => {
    const compact = name !== 'gateway-bundle.mjs';
    const source = `
async function prepareEmbeddedAttemptTransport(input) {
  const attempt = input.attempt;
  const session = input.session;
  const assertRunCurrent = resolveAdmittedRunActiveAssertion();
  ${compact
    ? 'return session.agent.streamFn=wrapApiKey(session.agent.streamFn),{serverToolClearingEnabled:false};'
    : 'session.agent.streamFn = wrapApiKey(session.agent.streamFn); return { serverToolClearingEnabled: false };'}
}`;
    const patched = patchAgentStream(source, 'unused-runtime', path.join('dist', name));
    expect(() => transformSync(patched, { target: 'node24' })).not.toThrow();
    expect(patchAgentStream(patched, 'unused-runtime', path.join('dist', name))).toBe(patched);
    const runtime = vm.createContext({
      withSessionEntryReadOnlyInWorker: async (_scope: unknown, _assert: unknown, consume: (read: object) => unknown) =>
        consume({ ok: true, value: { sessionId: 'child', parentSessionId: 'parent' } }),
      resolveAdmittedRunActiveAssertion: () => () => {},
      wrapApiKey: (inner: (model: unknown, context: unknown, options: object) => unknown) =>
        async (model: unknown, context: unknown, options: object) => inner(model, context, { ...options, apiKey: 'test-only-key' }),
      streamWithPayloadPatch: (
        inner: (model: unknown, context: unknown, options: object) => unknown,
        model: unknown,
        context: unknown,
        options: { onPayload?: (payload: object) => unknown } | undefined,
        patch: (payload: object) => void,
      ) => inner(model, context, {
        ...options,
        onPayload: (payload: object) => { patch(payload); return options?.onPayload?.(payload); },
      }),
    });
    vm.runInContext(`${patched}\n${COMPACTION_BLOCK}
      globalThis[Symbol.for('justdo.builtin-models.human-runs')] = new Set(['run']);
    `, runtime);
    const session = { agent: { streamFn: (_model: unknown, _context: unknown, options: { apiKey?: string; onPayload?: (payload: object) => unknown }) => {
      const payload = { metadata: { keep: 'value' } };
      options.onPayload?.(payload);
      return { payload, apiKey: options.apiKey };
    } } };
    await runtime.prepareEmbeddedAttemptTransport({
      session, sessionAgentId: 'main',
      attempt: { sessionId: 'child', sessionKey: 'agent:main:child', runId: 'run', model: { provider: 'builtin_models', api: 'openai-completions' } },
    });
    const compactStream = runtime.wrapJustDoCompactionRequestMetadata(session.agent.streamFn);
    const result = await compactStream({}, {}, {});
    expect(result.apiKey).toBe('test-only-key');
    expect(result.payload.metadata).toEqual({ keep: 'value', session_id: 'child', parent_session_id: 'parent', request_purpose: 'context_compaction' });
    expect(result.payload.metadata).not.toHaveProperty('user_initiated');
  },
);
