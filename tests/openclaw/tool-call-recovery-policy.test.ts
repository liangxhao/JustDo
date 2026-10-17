import { describe, expect, it } from 'vitest';

import {
  resolveToolCallRecovery,
  TOOL_CALL_RECOVERY_LIMIT,
  TOOL_CALL_RECOVERY_REASON,
} from '../../openclaw-extensions/runtime-services/tool-call-recovery/policy.mjs';

const eligibleFacts = () => ({
  rejected: true,
  streamComplete: true,
  initialCandidate: true,
  dispatchCount: 0,
  allToolsSettled: true,
  excluded: false,
  hasVisibleText: false,
  commentaryOnly: false,
  aborted: false,
  attempts: 0,
});

describe('tool-call format recovery policy', () => {
  it.each([0, 1])('permits correction after %i consumed opportunities', attempts => {
    const decision = resolveToolCallRecovery({ ...eligibleFacts(), attempts });

    expect(decision).toMatchObject({ action: 'retry', reason: 'retry' });
    expect(decision.instruction).toContain('No tool calls from that response were executed.');
    expect(decision.instruction).toContain('preserving completed work and recorded tool results');
    expect(decision.instruction).toContain('a complete JSON object');
    expect(decision.instruction).toContain('grants no additional authority');
  });

  it('retains explicit commentary while requesting an entirely new tool call', () => {
    const decision = resolveToolCallRecovery({
      ...eligibleFacts(),
      hasVisibleText: true,
      commentaryOnly: true,
    });

    expect(decision.action).toBe('retry');
    expect(decision.instruction).toContain('Previously displayed commentary is preserved');
    expect(decision.instruction).toContain('generate a complete JSON object');
  });

  it('leaves responses without a producer rejection to their existing owner', () => {
    const decision = resolveToolCallRecovery({ ...eligibleFacts(), rejected: false });

    expect(decision).toEqual({ action: 'not_applicable', reason: 'not_rejected' });
  });

  it.each([
    [{ aborted: true }, 'aborted'],
    [{ streamComplete: false }, 'incomplete_stream'],
    [{ initialCandidate: false }, 'not_initial_candidate'],
    [{ dispatchCount: 1 }, 'already_dispatched'],
    [{ allToolsSettled: false }, 'tools_unsettled'],
    [{ excluded: true }, 'excluded'],
    [{ hasVisibleText: true, commentaryOnly: false }, 'visible_final_output'],
  ])('declines an unsafe recovery boundary: %j', (overrides, reason) => {
    const decision = resolveToolCallRecovery({ ...eligibleFacts(), ...overrides });

    expect(decision).toEqual({ action: 'finalize', reason });
  });

  it('does not let commentary or an empty current batch bypass earlier activity', () => {
    const decision = resolveToolCallRecovery({
      ...eligibleFacts(),
      hasVisibleText: true,
      commentaryOnly: true,
      excluded: true,
    });

    expect(decision).toEqual({ action: 'finalize', reason: 'excluded' });
  });

  it.each([2, 3, Number.MAX_SAFE_INTEGER])(
    'ends correction after %i consumed opportunities',
    attempts => {
      const decision = resolveToolCallRecovery({ ...eligibleFacts(), attempts });

      expect(decision).toEqual({ action: 'finalize', reason: 'budget_exhausted' });
      expect(TOOL_CALL_RECOVERY_LIMIT).toBe(2);
      expect(TOOL_CALL_RECOVERY_REASON).toBe('tool_call_format');
    },
  );

  it.each([
    'rejected',
    'streamComplete',
    'initialCandidate',
    'allToolsSettled',
    'excluded',
    'hasVisibleText',
    'commentaryOnly',
    'aborted',
  ])('requires an explicit native boolean for %s', key => {
    const decision = resolveToolCallRecovery({ ...eligibleFacts(), [key]: undefined });

    expect(decision).toEqual({ action: 'finalize', reason: 'invalid_facts' });
  });

  it.each([null, 0, 1, 'true', [], {}])('does not coerce uncertain boolean facts: %j', value => {
    const decision = resolveToolCallRecovery({ ...eligibleFacts(), initialCandidate: value });

    expect(decision).toEqual({ action: 'finalize', reason: 'invalid_facts' });
  });

  it.each(['dispatchCount', 'attempts'])('requires a nonnegative safe integer for %s', key => {
    for (const value of [
      undefined,
      null,
      '0',
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const decision = resolveToolCallRecovery({ ...eligibleFacts(), [key]: value });

      expect(decision).toEqual({ action: 'finalize', reason: 'invalid_facts' });
    }
  });

  it.each([undefined, null, false, 0, 'rejected', []])(
    'rejects absent or malformed fact snapshots: %j',
    input => {
      const decision = resolveToolCallRecovery(input);

      expect(decision).toEqual({ action: 'finalize', reason: 'invalid_facts' });
    },
  );

  it('does not use inherited facts as proof', () => {
    const decision = resolveToolCallRecovery(Object.create(eligibleFacts()));

    expect(decision).toEqual({ action: 'finalize', reason: 'invalid_facts' });
  });

  it('does not retain state or consume the native budget', () => {
    const facts = Object.freeze(eligibleFacts());
    const first = resolveToolCallRecovery(facts);
    const second = resolveToolCallRecovery(facts);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(facts.attempts).toBe(0);
    expect(first.action).toBe('retry');
  });

  it('never includes unrelated payloads in the correction instruction', () => {
    const decision = resolveToolCallRecovery({
      ...eligibleFacts(),
      rawArguments: '<id>private-tool-argument</id>',
      providerError: 'private-provider-body',
    });

    expect(decision.action).toBe('retry');
    expect(decision.instruction).not.toContain('private-tool-argument');
    expect(decision.instruction).not.toContain('private-provider-body');
  });
});
