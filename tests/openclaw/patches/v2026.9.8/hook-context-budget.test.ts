import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const { transform, CONTRACT } = require('../../../../scripts/patches/v2026.9.8/035-hook-context-budget.cjs').__testing;
const fixture = `async function prepareEmbeddedAttemptPromptAssembly(input) {
  const { attempt } = input;
  const hookCtx = {
    ...buildEmbeddedAgentHookContext(attempt),
    modelProviderId: attempt.model.provider,
    modelId: attempt.model.id,
    inputProvenance: attempt.inputProvenance
  };
  return resolvePromptBuildHookResult({ hookCtx });
}`;

describe('native prompt hook context budget', () => {
  it.each([4000, 8000, 16000, 131072, undefined])('passes the actual resolved attempt budget %s without inventing a model window', async budget => {
    const context = vm.createContext({ buildEmbeddedAgentHookContext: () => ({ sessionKey: 'native-session' }), resolvePromptBuildHookResult: (value: unknown) => value });
    vm.runInContext(transform(fixture), context);
    const result = await context.prepareEmbeddedAttemptPromptAssembly({ attempt: { contextTokenBudget: budget, model: { provider: 'native', id: 'selected', contextWindow: 999999 } } });
    expect(result.hookCtx.contextTokenBudget).toBe(budget);
    expect(result.hookCtx.sessionKey).toBe('native-session');
    expect(result.hookCtx.modelId).toBe('selected');
  });

  it('is idempotent only for the current exact shape', () => {
    const patched = transform(fixture);
    expect(transform(patched)).toBe(patched);
    expect(() => transform(patched.replace('attempt.contextTokenBudget', 'attempt.model.contextWindow'))).toThrow('partial');
    expect(() => transform(patched.replace('contextTokenBudget: attempt.contextTokenBudget,', ''))).toThrow('partial');
    expect(() => transform(patched.replace(CONTRACT, CONTRACT.replace('9_8', '9_6')))).toThrow('historical');
    expect(() => transform(patched.replace('// ' + CONTRACT, ''))).toThrow('missing');
  });

  it('verifies the markerless production bundle after local binding renaming', () => {
    const bundled = transform(fixture).replace('// ' + CONTRACT, '').replaceAll('attempt', 'nativeAttempt');
    expect(transform(bundled, 'gateway-bundle.mjs')).toBe(bundled);
    expect(() => transform(bundled.replace('nativeAttempt.contextTokenBudget', '131072'), 'gateway-bundle.mjs')).toThrow('partial');
  });

  it('fails closed on ambiguous or changed native identities', () => {
    expect(() => transform(fixture.replace('attempt.model.id', 'other.model.id'))).toThrow('identity');
    expect(() => transform(fixture + fixture)).toThrow('topology');
    expect(() => transform(fixture.replace('modelProviderId:', 'provider:'))).toThrow('context changed');
  });
});
