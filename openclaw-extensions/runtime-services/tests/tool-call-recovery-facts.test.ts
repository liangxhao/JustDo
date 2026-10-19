import { describe, expect, it } from 'vitest';

import { observeToolCallRecoveryResponse } from '../tool-call-recovery/facts.mjs';

const response = (overrides: Record<string, unknown> = {}) => ({ role: 'assistant', stopReason: 'error',
  errorCode: 'malformed_tool_call_arguments', content: [{ type: 'thinking', thinking: 'opaque' }],
  diagnostics: [{ type: 'tool_call_pre_dispatch_rejection', timestamp: 1,
    details: { batchRejected: true, streamComplete: true, dispatchCount: 0 } }], ...overrides });
const text = (phase?: string) => ({ type: 'text', text: 'Continuing inspection.',
  ...(phase ? { textSignature: JSON.stringify({ v: 1, phase }) } : {}) });

describe('current native response rejection projection', () => {
  it('reads the completed current response without retaining or mutating it', () => {
    const original = response();
    const before = structuredClone(original);
    const facts = observeToolCallRecoveryResponse(original);
    expect(facts).toMatchObject({ rejected: true, streamComplete: true, dispatchCount: 0, hasVisibleText: false });
    expect(original).toEqual(before);
    expect(observeToolCallRecoveryResponse({ role: 'assistant', stopReason: 'stop', content: [] }).rejected).toBe(false);
    expect(observeToolCallRecoveryResponse(original)).toEqual(facts);
  });

  it.each([undefined, null, {}, [], response({ role: 'user' }), response({ stopReason: 'stop' }),
    response({ errorCode: 'unknown' }), response({ diagnostics: undefined }), response({ diagnostics: [] }),
    response({ content: [{ type: 'toolCall', id: 'unexecuted', name: 'exec', arguments: {} }] }),
    response({ content: [{ type: 'image', data: 'unknown' }] }), response({ content: [null] }),
    response({ content: [{ type: 'thinking', thinking: 1 }] }), response({ content: [{ type: 'text', text: 1 }] }),
  ])('refuses incomplete or unrelated observations: %j', value => {
    expect(observeToolCallRecoveryResponse(value).rejected).toBe(false);
  });

  it.each([{ batchRejected: false }, { streamComplete: false }, { dispatchCount: 1 },
    { batchRejected: undefined }, { streamComplete: 'true' }, { dispatchCount: '0' },
  ])('requires exact atomic completed zero-dispatch evidence: %j', change => {
    const original = response();
    Object.assign(original.diagnostics[0].details, change);
    expect(observeToolCallRecoveryResponse(original).rejected).toBe(false);
  });

  it('rejects duplicate, unknown, malformed and refusal diagnostics', () => {
    for (const extra of [response().diagnostics[0], null, { type: 'provider_refusal' }, { type: 'unknown' }]) {
      const original = response();
      Object.assign(original, { diagnostics: [...original.diagnostics, extra] });
      expect(observeToolCallRecoveryResponse(original).rejected).toBe(false);
    }
  });

  it.each([-1, NaN, undefined, '1'])('requires the native numeric receipt timestamp: %j', timestamp => {
    const original = response();
    Object.assign(original.diagnostics[0], { timestamp });
    expect(observeToolCallRecoveryResponse(original).rejected).toBe(false);
  });

  it('marks visible content as commentary only when every block has a native signature', () => {
    expect(observeToolCallRecoveryResponse(response({ content: [text('commentary')] }))).toMatchObject({
      rejected: true, hasVisibleText: true, commentaryOnly: true,
    });
    for (const content of [[text()], [text('final')], [text('commentary'), text()]]) {
      expect(observeToolCallRecoveryResponse(response({ content }))).toMatchObject({
        rejected: true, hasVisibleText: true, commentaryOnly: false,
      });
    }
    expect(observeToolCallRecoveryResponse(response({ phase: 'final', content: [text('commentary')] })).commentaryOnly).toBe(false);
  });
});
