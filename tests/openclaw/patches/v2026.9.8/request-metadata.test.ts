import vm from 'node:vm';

import { afterEach, expect, test, vi } from 'vitest';

const { __testing: { WRAPPER } } = require('../../../../scripts/patches/v2026.9.8/006-agent-request-metadata.cjs');
const { __testing: { REVIEWER_SESSION_BLOCK } } = require('../../../../scripts/patches/v2026.9.8/007-request-purpose-metadata.cjs');

afterEach(() => vi.restoreAllMocks());

test('reads parent metadata through the worker and consumes human initiation once', async () => {
  const read = vi.fn(async (_scope, assertCurrent, consume) => {
    assertCurrent();
    return consume({ ok: true, value: { sessionId: 'child', parentSessionId: 'parent' } });
  });
  const context = vm.createContext({
    loadJustDoSessionEntry: read,
    streamWithPayloadPatch: (_stream: unknown, _model: unknown, _context: unknown, _options: unknown, patch: (payload: object) => void) => {
      const payload = { metadata: { keep: 'value' } };
      patch(payload);
      return payload;
    },
  });
  vm.runInContext('globalThis[Symbol.for("justdo.builtin-models.human-runs")] = new Set(["run"]);', context);
  const wrap = vm.runInContext(`${WRAPPER}\nwrapJustDoAgentRequestMetadata`, context);
  const assertCurrent = vi.fn();
  const stream = await wrap(() => {}, {
    sessionId: 'child', sessionKey: 'agent:main:child', agentId: 'main', runId: 'run',
    modelProvider: 'builtin_models', modelApi: 'openai-completions', assertCurrent,
  });
  expect(read).toHaveBeenCalledOnce();
  expect(assertCurrent).toHaveBeenCalledTimes(2);
  expect(stream().metadata).toEqual({ keep: 'value', session_id: 'child', parent_session_id: 'parent', request_purpose: 'agent', user_initiated: true });
  expect(stream().metadata).toEqual({ keep: 'value', session_id: 'child', parent_session_id: 'parent', request_purpose: 'agent' });
});

test('does not disclose a stale parent and rejects authority revoked during the worker read', async () => {
  const context = vm.createContext({
    loadJustDoSessionEntry: async (_scope: unknown, _assert: unknown, consume: (value: object) => unknown) => consume({ ok: true, value: { sessionId: 'old', parentSessionId: 'private-parent' } }),
    streamWithPayloadPatch: (_stream: unknown, _model: unknown, _context: unknown, _options: unknown, patch: (payload: object) => void) => {
      const payload = {};
      patch(payload);
      return payload;
    },
  });
  const wrap = vm.runInContext(`${WRAPPER}\nwrapJustDoAgentRequestMetadata`, context);
  const params = { sessionId: 'child', sessionKey: 'agent:main:child', modelProvider: 'builtin_models', modelApi: 'openai-completions', assertCurrent: () => {} };
  const stream = await wrap(() => {}, params);
  expect(stream().metadata).not.toHaveProperty('parent_session_id');
  await expect(wrap(() => {}, { ...params, assertCurrent: () => { throw new Error('revoked'); } })).rejects.toThrow('revoked');
});

test('third-party model streams do not read or attach built-in metadata', async () => {
  const read = vi.fn();
  const context = vm.createContext({ loadJustDoSessionEntry: read });
  const wrap = vm.runInContext(`${WRAPPER}\nwrapJustDoAgentRequestMetadata`, context);
  const stream = () => {};
  expect(await wrap(stream, { modelProvider: 'external', modelApi: 'openai-completions' })).toBe(stream);
  expect(read).not.toHaveBeenCalled();
});

test('reviewer awaits the native read worker and tolerates missing session identities', async () => {
  const read = vi.fn(async (_scope, _assert, consume) => consume({ ok: true, value: { sessionId: ' session ' } }));
  const resolve = vm.runInNewContext(`${REVIEWER_SESSION_BLOCK}\nresolveJustDoReviewerSessionId`, { loadJustDoReviewerSessionEntry: read });
  expect(await resolve({ agent: { sessionKey: 'agent:main:test' } }, 'main')).toBe('session');
  expect(await resolve({}, 'main')).toBeUndefined();
  expect(read).toHaveBeenCalledOnce();
});
