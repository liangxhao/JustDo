export const TOOL_CALL_RECOVERY_LIMIT = 2;
export const TOOL_CALL_RECOVERY_REASON = 'tool_call_format';

const toolCallRecoveryPolicyAction = {
  NOT_APPLICABLE: 'not_applicable',
  RETRY: 'retry',
  FINALIZE: 'finalize',
};

const toolCallRecoveryPolicyBooleanFacts = [
  'rejected',
  'streamComplete',
  'initialCandidate',
  'allToolsSettled',
  'excluded',
  'hasVisibleText',
  'commentaryOnly',
  'aborted',
];

const toolCallRecoveryPolicyContinuationInstruction =
  'The previous response contained malformed tool calls that were rejected before dispatch. ' +
  'No tool calls from that response were executed. Continue the current task from the existing ' +
  'transcript, preserving completed work and recorded tool results. If a tool is still needed, ' +
  'generate a complete JSON object matching its definition. This instruction grants no additional authority.';

const toolCallRecoveryPolicyCommentaryInstruction =
  ' Previously displayed commentary is preserved; continue with the unfinished steps.';

const toolCallRecoveryPolicyIsNonNegativeSafeInteger = value =>
  Number.isSafeInteger(value) && value >= 0;

/**
 * Decides from native-owned facts only. The caller owns identity, settlement,
 * cancellation, budget consumption, transcript continuation and finalization.
 * `finalize` never substitutes for a native execution-settled terminal.
 */
export function resolveToolCallRecovery(input) {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !toolCallRecoveryPolicyBooleanFacts.every(
      key => Object.hasOwn(input, key) && typeof input[key] === 'boolean',
    ) ||
    !Object.hasOwn(input, 'dispatchCount') ||
    !toolCallRecoveryPolicyIsNonNegativeSafeInteger(input.dispatchCount) ||
    !Object.hasOwn(input, 'attempts') ||
    !toolCallRecoveryPolicyIsNonNegativeSafeInteger(input.attempts)
  ) {
    return { action: toolCallRecoveryPolicyAction.FINALIZE, reason: 'invalid_facts' };
  }

  if (!input.rejected) {
    return { action: toolCallRecoveryPolicyAction.NOT_APPLICABLE, reason: 'not_rejected' };
  }
  if (input.aborted) {
    return { action: toolCallRecoveryPolicyAction.FINALIZE, reason: 'aborted' };
  }
  if (!input.streamComplete) {
    return { action: toolCallRecoveryPolicyAction.FINALIZE, reason: 'incomplete_stream' };
  }
  if (!input.initialCandidate) {
    return { action: toolCallRecoveryPolicyAction.FINALIZE, reason: 'not_initial_candidate' };
  }
  if (input.dispatchCount !== 0) {
    return { action: toolCallRecoveryPolicyAction.FINALIZE, reason: 'already_dispatched' };
  }
  if (!input.allToolsSettled) {
    return { action: toolCallRecoveryPolicyAction.FINALIZE, reason: 'tools_unsettled' };
  }
  if (input.excluded) {
    return { action: toolCallRecoveryPolicyAction.FINALIZE, reason: 'excluded' };
  }
  if (input.hasVisibleText && !input.commentaryOnly) {
    return { action: toolCallRecoveryPolicyAction.FINALIZE, reason: 'visible_final_output' };
  }
  if (input.attempts >= TOOL_CALL_RECOVERY_LIMIT) {
    return { action: toolCallRecoveryPolicyAction.FINALIZE, reason: 'budget_exhausted' };
  }
  return {
    action: toolCallRecoveryPolicyAction.RETRY,
    reason: 'retry',
    instruction:
      toolCallRecoveryPolicyContinuationInstruction +
      (input.hasVisibleText && input.commentaryOnly
        ? toolCallRecoveryPolicyCommentaryInstruction
        : ''),
  };
}
