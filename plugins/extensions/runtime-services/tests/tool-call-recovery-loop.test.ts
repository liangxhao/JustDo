import { describe, expect, it, vi } from 'vitest';

import { observeToolCallRecoveryResponse } from '../tool-call-recovery/facts.mjs';
import {
  assertToolCallValidationModel,
  createToolCallValidationRecovery,
  installToolCallValidationRecovery,
  prepareToolCallValidationHandoff,
  readToolCallValidationRecovery,
} from '../tool-call-recovery/loop.mjs';
import { resolveToolCallRecovery } from '../tool-call-recovery/policy.mjs';

const model = { api: 'openai-completions', provider: 'fixture', id: 'model' };
const message = () => ({ role: 'assistant', stopReason: 'error', errorCode: 'malformed_tool_call_arguments',
  errorMessage: 'Provider returned an incomplete or malformed tool call', content: [], usage: { totalTokens: 17 },
  responseId: 'original-response', diagnostics: [{ type: 'tool_call_pre_dispatch_rejection', timestamp: 1,
    details: { batchRejected: true, streamComplete: true, dispatchCount: 0 } }] });
const facts = () => ({ model, executedCount: 0, committedCount: 0, batchCount: 0, aborted: false });
const owner = () => ({ state: { attempts: 0, claimed: false }, observe: observeToolCallRecoveryResponse,
  resolve: resolveToolCallRecovery, isInitialModel: (current: unknown) => current === model,
  isAborted: () => false, hasBudget: () => true, assertActive: vi.fn(), consumeBudget: vi.fn(),
  onDecision: vi.fn(), onRetry: vi.fn() });

describe('native validation continuation owner', () => {
  it('shares two corrections across new loops and never adds an outer attempt', async () => {
    const run = owner();
    const first = createToolCallValidationRecovery(run);
    const second = createToolCallValidationRecovery(run);
    expect(await first(message(), facts())).toMatchObject({ role: 'custom', customType: 'runtime-services.tool-call-validation',
      display: false });
    expect(await second(message(), facts())).toBeDefined();
    expect(await first(message(), facts())).toBeUndefined();
    expect(run.state).toEqual({ attempts: 2, claimed: true });
    expect(run.consumeBudget).toHaveBeenCalledTimes(2);
    expect(run.onRetry).toHaveBeenCalledTimes(2);
    expect(run.onDecision.mock.calls.map(([decision]) => decision.reason)).toEqual(['retry', 'retry', 'budget_exhausted']);
  });

  it.each(['executedCount', 'committedCount', 'batchCount'])(
    'refuses an executed or committed response: %s', async key => {
      const run = owner();
      for (const value of [1, undefined, -1, NaN]) {
        expect(await createToolCallValidationRecovery(run)(message(), { ...facts(), [key]: value })).toBeUndefined();
      }
      expect(run.consumeBudget).not.toHaveBeenCalled();
    },
  );

  it.each(['provider_refusal', 'unknown_diagnostic'])(
    'does not turn other provider outcomes into format correction: %s', async type => {
      const run = owner();
      const response = message();
      response.diagnostics.push({ ...response.diagnostics[0], type });
      expect(await createToolCallValidationRecovery(run)(response, facts())).toBeUndefined();
      expect(run.state.claimed).toBe(false);
      expect(run.onRetry).not.toHaveBeenCalled();
    },
  );

  it.each(['aborted', 'stream', 'dispatch', 'residual', 'duplicate', 'model', 'budget'])(
    'retains the native guard for %s', async reason => {
      const run = owner();
      const response = message();
      const native = facts();
      if (reason === 'aborted') native.aborted = true;
      if (reason === 'stream') response.diagnostics[0].details.streamComplete = false;
      if (reason === 'dispatch') response.diagnostics[0].details.dispatchCount = 1;
      if (reason === 'residual') Object.assign(response, { content: [{ type: 'toolCall', id: 'unsafe' }] });
      if (reason === 'duplicate') response.diagnostics.push(response.diagnostics[0]);
      if (reason === 'model') Object.assign(native, { model: { ...model, id: 'switched' } });
      if (reason === 'budget') run.hasBudget = () => false;
      expect(await createToolCallValidationRecovery(run)(response, native)).toBeUndefined();
      expect(run.consumeBudget).not.toHaveBeenCalled();
    },
  );

  it('normalizes only a nonterminal core copy, preserving original failure and usage', async () => {
    const original = message();
    const before = structuredClone(original);
    const result = await prepareToolCallValidationHandoff({ model, toolCallRecovery: createToolCallValidationRecovery(owner()) }, original, facts());
    expect(original).toEqual(before);
    expect(result.message).toMatchObject({ stopReason: 'stop', endTurn: false, responseId: original.responseId, usage: original.usage });
    expect(result.message).not.toHaveProperty('errorCode');
    expect(result.message).not.toHaveProperty('errorMessage');
    expect(result.feedback.content).toContain('This instruction grants no additional authority');
    expect(result.model).toEqual(model);
    expect(result.model).not.toBe(model);
  });

  it('checks admission again after an awaited progress callback and preserves its error', async () => {
    const run = owner();
    const expired = new Error('Native generation expired');
    run.onRetry.mockImplementation(async () => { run.assertActive.mockImplementation(() => { throw expired; }); });
    await expect(createToolCallValidationRecovery(run)(message(), facts())).rejects.toBe(expired);
    expect(run.state.attempts).toBe(1);
  });

  it('does not swallow a progress callback failure or a late response abort', async () => {
    const run = owner();
    const failed = new Error('Native callback failed');
    run.onRetry.mockRejectedValue(failed);
    await expect(createToolCallValidationRecovery(run)(message(), facts())).rejects.toBe(failed);
    const controller = new AbortController();
    const recover = vi.fn(async () => { controller.abort(failed); return { content: 'bounded' }; });
    await expect(prepareToolCallValidationHandoff({ model, toolCallRecovery: recover }, message(), {
      ...facts(), signal: controller.signal,
    })).rejects.toBe(failed);
  });

  it('expires exact Agent hooks and never lets an old cleanup retire a successor', async () => {
    const agent = {};
    const first = vi.fn(() => 'first');
    const cleanup = installToolCallValidationRecovery(agent, first);
    const retained = readToolCallValidationRecovery(agent);
    expect(retained()).toBe('first');
    expect(() => installToolCallValidationRecovery(agent, first)).toThrow('already installed');
    cleanup();
    const second = vi.fn(() => 'second');
    const cleanupSecond = installToolCallValidationRecovery(agent, second);
    cleanup();
    expect(retained()).toBeUndefined();
    expect(readToolCallValidationRecovery(agent)()).toBe('second');
    cleanupSecond();
    expect(readToolCallValidationRecovery(agent)).toBeUndefined();
  });
});

describe('validation model custody', () => {
  it('detects mutation of the original model object after accepting a handoff', async () => {
    const current = { ...model };
    const run = owner();
    run.isInitialModel = () => true;
    const handoff = await prepareToolCallValidationHandoff({ model: current, toolCallRecovery: createToolCallValidationRecovery(run) }, message(), facts());
    current.id = 'changed-in-place';
    expect(handoff.model.id).toBe('model');
    expect(() => assertToolCallValidationModel(handoff.model, current)).toThrow('model changed');
  });

  it('requires the same API/provider/model after native turn preparation', () => {
    expect(() => assertToolCallValidationModel({ ...model }, model)).not.toThrow();
    for (const key of ['api', 'provider', 'id']) {
      expect(() => assertToolCallValidationModel(model, { ...model, [key]: 'changed' })).toThrow('model changed');
    }
    expect(() => assertToolCallValidationModel(undefined, model)).toThrow('model changed');
  });
});
