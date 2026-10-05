import vm from 'node:vm';

import { afterEach, expect, test, vi } from 'vitest';

const { patchFollowupInitiation, patchChatRegistration, __testing: { WRAPPER, ADMISSION_MARKER, FOLLOWUP_TRANSFER } } = require('../../../../scripts/patches/v2026.9.8/006-agent-request-metadata.cjs');
const { __testing: { REVIEWER_SESSION_BLOCK } } = require('../../../../scripts/patches/v2026.9.8/007-request-purpose-metadata.cjs');

afterEach(() => vi.restoreAllMocks());

test.each([true, false])('queued execution preserves human initiation evidence only when admitted: %s', async human => {
  const context = vm.createContext({
    loadJustDoSessionEntry: async (_scope: unknown, _assert: unknown, consume: (value: object) => unknown) => consume({ ok: true, value: { sessionId: 'session' } }),
    streamWithPayloadPatch: (_stream: unknown, _model: unknown, _context: unknown, _options: unknown, patch: (payload: object) => void) => {
      const payload = {};
      patch(payload);
      return payload;
    },
    replyRunRegistry: { bindSourceTurnId: vi.fn() },
  });
  vm.runInContext(`globalThis[Symbol.for("justdo.builtin-models.human-runs")] = new Set(${human ? '["queued-admission"]' : '[]'});`, context);
  const source = `async function executeFollowupTurn(turn, sourceTurnId) {
    replyRunRegistry.bindSourceTurnId(turn.operation, sourceTurnId);
    return wrapJustDoAgentRequestMetadata(() => {}, {
      runId: turn.runId, sessionId: 'session', sessionKey: 'agent:main:session',
      modelProvider: 'builtin_models', modelApi: 'openai-completions', assertCurrent: () => {}
    });
  }`;
  const patched = patchFollowupInitiation(source, 'native.mjs');
  expect(patchFollowupInitiation(patched, 'native.mjs')).toBe(patched);
  const execute = vm.runInContext(`${WRAPPER}\n${patched}\nexecuteFollowupTurn`, context);
  const turn = { runId: 'native-execution', operation: {} };
  const stream = await execute(turn, 'queued-admission');
  expect(stream().metadata.user_initiated).toBe(human ? true : undefined);
  expect(stream().metadata).not.toHaveProperty('user_initiated');
  expect(turn.runId).toBe('native-execution');
  expect(vm.runInContext('globalThis[Symbol.for("justdo.builtin-models.human-runs")].size', context)).toBe(0);
});

test('rejects previous admission markers and partial queue transfers instead of upgrading them', () => {
  const oldRegistration = `// ${ADMISSION_MARKER.replace('queued-input revision ', '')}
    if (p.justdoUserInitiated === true) { humanRuns.add(clientRunId); }`;
  expect(() => patchChatRegistration(oldRegistration, 'native.mjs')).toThrow(/historical or partial/);
  expect(() => patchFollowupInitiation(`replyRunRegistry.bindSourceTurnId(turn.operation, sourceTurnId);\n${FOLLOWUP_TRANSFER.replace('.add(turn.runId)', '.add("wrong")')}`, 'native.mjs')).toThrow(/partial/);
});

test('preserves the embedded worker comma-expression source binding', () => {
  const source = 'function executeFollowupTurn(Kt,kn){return kn&&(replyRunRegistry.bindSourceTurnId(Kt.operation,kn),42)}';
  const patched = patchFollowupInitiation(source, 'worker.mjs');
  const context = vm.createContext({ replyRunRegistry: { bindSourceTurnId: vi.fn() } });
  vm.runInContext('globalThis[Symbol.for("justdo.builtin-models.human-runs")] = new Set(["source"]);', context);
  const execute = vm.runInContext(`${patched};executeFollowupTurn`, context);
  expect(execute({ runId: 'execution', operation: {} }, 'source')).toBe(42);
  expect(vm.runInContext('[...globalThis[Symbol.for("justdo.builtin-models.human-runs")]]', context)).toEqual(['execution']);
  expect(patchFollowupInitiation(patched, 'worker.mjs')).toBe(patched);
});

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
