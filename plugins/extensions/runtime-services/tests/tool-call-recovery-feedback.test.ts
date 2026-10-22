import { describe, expect, it, vi } from 'vitest';

import { observeToolCallRecoveryResponse, projectToolCallRecoveryRejectionFeedback } from '../tool-call-recovery/facts.mjs';
import { projectToolCallRecoveryFailureSummary, resolveToolCallRecovery } from '../tool-call-recovery/policy.mjs';

type Call = { name?: unknown; partialArgs?: unknown; arguments?: unknown };
const call = (partialArgs: unknown, name: unknown = 'exec'): Call => ({ name, partialArgs, arguments: {} });
// Pure fixture only. Actual SDK acceptance is separately covered at the transport boundary.
const validator = (calls: Call[], read: (call: Call) => string) => {
  for (const value of calls) {
    try {
      const parsed: unknown = JSON.parse(read(value).replace(/([{,])(\d{16,}):/g, '$1"$2":'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      value.arguments = parsed;
    } catch { throw Object.assign(new Error('Synthetic native rejection'), { errorCode: 'malformed_tool_call_arguments' }); }
  }
};
const project = (calls: Call[], finalize = validator) => projectToolCallRecoveryRejectionFeedback(calls, finalize);
const policyFacts = { rejected: true, streamComplete: true, initialCandidate: true, allToolsSettled: true,
  excluded: false, hasVisibleText: false, commentaryOnly: false, aborted: false, dispatchCount: 0, attempts: 0 };
const decision = (feedback?: unknown) => resolveToolCallRecovery({ ...policyFacts, feedback });
const assistant = (feedback: unknown) => ({ role: 'assistant', stopReason: 'error',
  errorCode: 'malformed_tool_call_arguments', content: [], diagnostics: [{
    type: 'tool_call_pre_dispatch_rejection', timestamp: 1,
    details: { batchRejected: true, streamComplete: true, dispatchCount: 0, feedback },
  }] });
const observe = (feedback: unknown) => observeToolCallRecoveryResponse(assistant(feedback));

describe('claimed recovery terminal error summary', () => {
  const claimed = { meta: { modelFallbackStopReason: 'tool_call_format_recovery' } };
  it('uses only the exact already-redacted native terminal error', () => {
    expect(projectToolCallRecoveryFailureSummary(claimed, 'Service overloaded.', false)).toBe('Service overloaded.');
    expect(projectToolCallRecoveryFailureSummary({ meta: { ...claimed.meta, error: { message: 'private raw error' } } }, undefined, false)).toBe('failed');
  });
  it.each([undefined, null, '', ' \n\t', {}, 42])('retains the native fallback for an absent diagnostic: %j', error => {
    expect(projectToolCallRecoveryFailureSummary(claimed, error, false)).toBe('failed');
  });
  it.each([{}, { meta: {} }, { meta: { modelFallbackStopReason: 'provider_review_continuation' } },
    { meta: { ...claimed.meta, aborted: true } }, { meta: { ...claimed.meta, stopReason: 'timeout' } }])(
    'does not expand the projection to other native outcomes: %j', result => {
      expect(projectToolCallRecoveryFailureSummary(result, 'Private unrelated reason', false)).toBe('failed');
    });
  it.each([true, undefined, null, 0])('suppresses late abort, incognito and unknown privacy state: %j', suppressed => {
    expect(projectToolCallRecoveryFailureSummary(claimed, 'Private reason', suppressed)).toBe('failed');
  });
  it.each(['A', '中', '😀', '\u0000', '"', '\\', '\ud800'])('bounds long JSON-encoded Unicode diagnostics: %j', character => {
    const projected = projectToolCallRecoveryFailureSummary(claimed, character.repeat(100000), false);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(2048);
    expect(projected.endsWith('…')).toBe(true);
    if (character === '😀') expect(projected.slice(0, -1)).toBe('😀'.repeat((projected.length - 1) / 2));
  });
  it('does not scan an arbitrarily long blank diagnostic looking for a later reason', () => {
    expect(projectToolCallRecoveryFailureSummary(claimed, ' '.repeat(100000) + 'later', false)).toBe('failed');
  });
});

describe('bounded tool-call failure feedback', () => {
  it.each([
    [undefined, 'empty_arguments'], ['', 'empty_arguments'], [' \n\t', 'empty_arguments'],
    ['[]', 'non_object_arguments'], ['null', 'non_object_arguments'], ['"text"', 'non_object_arguments'],
    ['<command>private</command>', 'invalid_json'], ['{"x":"unfinished', 'invalid_json'],
    ['{"x":"\\q"}', 'invalid_json'], ['{"x":1 "y":2}', 'invalid_json'],
  ])('classifies %j only after native rejection', (raw, kind) => {
    const result = project([call(raw)]);
    expect(result).toMatchObject({ version: 1, batchCallCount: 1, localization: 'located', omitted: false,
      issues: [{ callIndex: 0, kind, argumentChars: typeof raw === 'string' ? raw.length : 0 }] });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
  });

  it.each([undefined, '', ' \n'])('identifies a missing name without retaining it: %j', name => {
    expect(project([{ name, partialArgs: '{}' }]).issues).toEqual([
      { callIndex: 0, kind: 'missing_tool_name', argumentChars: 2 },
    ]);
  });

  it('provides true UTF-16 error offsets, fixed hints, and whole-batch instructions', () => {
    const raw = '{"字":"😀", "x":1 "y":2}';
    const result = project([call('{}'), call(raw), call('<id>private</id>')]);
    expect(result.issues[0]).toMatchObject({ callIndex: 1, detail: 'unexpected_token', position: raw.indexOf('"y"') });
    expect(result.issues[1]).toMatchObject({ callIndex: 2, detail: 'xml_like_input' });
    const prompt = decision(result).instruction;
    expect(prompt).toContain('all 3 calls were withheld, including valid siblings');
    expect(prompt).toContain('Call 2: invalid JSON');
    expect(prompt).toContain('UTF-16');
    expect(prompt).toContain('preserving completed work');
    expect(prompt).toContain('do not append only a missing suffix');
    expect(prompt).not.toContain('private');
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(3072);
  });

  it('does not blame a native-accepted integer key or mislocate a transformed failure', () => {
    const calls = [call('{9007199254740993:0}'), call('{9007199254740993:0 "x":1}')];
    const before = structuredClone(calls);
    expect(project(calls).issues).toEqual([
      { callIndex: 1, kind: 'native_rejected', argumentChars: 26 },
    ]);
    expect(calls).toEqual(before);
  });

  it('omits every name, value, parser message and structure preview', () => {
    const secretName = 'sk_private_12345';
    const raw = '{"password":"!@#$%^&*()\\q"}';
    const result = project([call(raw, secretName)]);
    const output = JSON.stringify(result) + decision(result).instruction;
    for (const privateText of [secretName, 'password', '!@#$', 'preview', 'stack']) expect(output).not.toContain(privateText);
    expect(result.issues[0]).toMatchObject({ kind: 'invalid_json', detail: 'invalid_escape' });
  });

  it('caps issues and leaves uninspected calls unlocalized without mislabeling siblings', () => {
    expect(project(Array.from({ length: 8 }, () => call('<x>')))).toMatchObject({ issues: expect.any(Array), omitted: true });
    expect(project(Array.from({ length: 8 }, () => call('<x>'))).issues).toHaveLength(3);
    const result = project([...Array.from({ length: 16 }, () => call('{}')), call('<x>')]);
    expect(result).toMatchObject({ issues: [], localization: 'unlocalized', omitted: true, batchCallCount: 17 });
    const inspect = vi.fn(validator);
    const huge = project([call(' '.repeat(20000)), call('<x>')], inspect);
    expect(inspect).toHaveBeenCalledOnce();
    expect(huge.issues).toMatchObject([{ callIndex: 1 }]);
    expect(huge.omitted).toBe(true);
    inspect.mockClear();
    expect(project([call('<x>', 'n'.repeat(20000))], inspect).localization).toBe('unlocalized');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('passes only a disposable local dummy and accepts only the native error code', () => {
    const calls = [call('<private>')];
    const before = structuredClone(calls);
    const mutate = vi.fn((dummies: Call[]) => { dummies[0].arguments = { private: true }; throw new Error('private parser text'); });
    const result = project(calls, mutate as typeof validator);
    expect(result).toMatchObject({ issues: [], localization: 'unlocalized', omitted: true });
    expect(mutate.mock.calls[0][0][0]).not.toBe(calls[0]);
    expect(calls).toEqual(before);
    expect(projectToolCallRecoveryRejectionFeedback(calls, undefined)).toBeUndefined();
    expect(project([call('{"valid":true}')]).issues).toEqual([]);
  });

  it('summarizes oversized errors without scanning or serializing their contents', () => {
    const inspect = vi.fn(validator);
    const raw = '<private>' + '😀'.repeat(500000);
    const result = project([call(raw)], inspect);
    expect(inspect).not.toHaveBeenCalled();
    expect(result).toMatchObject({ issues: [], omitted: true, localization: 'unlocalized' });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
    const prompt = decision(result).instruction;
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(3072);
    expect(prompt).toContain('Some diagnostics were omitted');
    expect(prompt).not.toContain('private');
    expect(prompt).not.toContain('😀');
  });

  it('keeps the output byte limits even with maximum numeric metadata and ignored large fields', () => {
    const feedback = { version: 1, batchCallCount: Number.MAX_SAFE_INTEGER, omitted: true, localization: 'located',
      rawError: 'private'.repeat(100000), issues: [0, 1, 2].map(index => ({ callIndex: Number.MAX_SAFE_INTEGER - 3 + index,
        kind: 'invalid_json', detail: 'invalid_escape', argumentChars: Number.MAX_SAFE_INTEGER,
        position: Number.MAX_SAFE_INTEGER, rawError: 'private'.repeat(100000) })) };
    const accepted = observe(feedback).feedback;
    expect(accepted).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(accepted))).toBeLessThanOrEqual(2048);
    const prompt = decision(accepted).instruction;
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(3072);
    expect(prompt).not.toContain('private');
  });

  it('uses only the completed diagnostic feedback while keeping authority independent', () => {
    const completed = project([call('<x>')]);
    const current = project([call('[]')]);
    const facts = observe(completed, current);
    expect(facts.feedback).toEqual(completed);
    expect(facts).toMatchObject({ rejected: true, dispatchCount: 0 });
    expect(observe({ ...completed, injected: 'private' }).feedback).toEqual(completed);
    expect(assistant(completed).content).toEqual([]);
  });

  it.each([
    null, {}, { version: 2 }, { issues: Array(10000).fill({}) },
    { version: 1, batchCallCount: 1, localization: 'located', omitted: false,
      issues: [{ callIndex: 0, kind: 'private', argumentChars: 4 }] },
  ])('drops malformed feedback without changing retry eligibility: %j', bad => {
    const facts = observe(bad);
    expect(facts).toMatchObject({ feedback: undefined, rejected: true });
    expect(decision(bad)).toEqual(decision());
  });

  it('does not allow feedback to bypass any recovery guard or exhaust another budget', () => {
    const feedback = project([call('<x>')]);
    for (const override of [{ aborted: true }, { initialCandidate: false }, { excluded: true },
      { allToolsSettled: false }, { dispatchCount: 1 }, { streamComplete: false }, { attempts: 2 }]) {
      expect(resolveToolCallRecovery({ ...policyFacts, ...override, feedback }).action).toBe('finalize');
    }
    expect(resolveToolCallRecovery({ ...policyFacts, rejected: false, feedback }).action).toBe('not_applicable');
  });

  it.each(['duplicate', 'position', 'detail', 'count', 'localization'])('drops inconsistent whitelisted metadata: %s', defect => {
    const feedback = project([call('<x>')]);
    if (defect === 'duplicate') feedback.issues.push({ ...feedback.issues[0] });
    if (defect === 'position') feedback.issues[0].position = 100;
    if (defect === 'detail') feedback.issues[0].detail = 'private error';
    if (defect === 'count') feedback.batchCallCount = 0;
    if (defect === 'localization') feedback.localization = 'unlocalized';
    expect(observe(feedback)).toMatchObject({ feedback: undefined, rejected: true });
    expect(decision(feedback)).toEqual(decision());
  });
});
