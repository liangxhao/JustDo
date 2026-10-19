export const TOOL_CALL_RECOVERY_LIMIT = 2;
export const TOOL_CALL_RECOVERY_REASON = 'tool_call_format';

/** Project only the exact native owner's already-redacted terminal diagnostic. */
export function projectToolCallRecoveryFailureSummary(result, terminalError, suppressed) {
  try {
    if (suppressed !== false || result?.meta?.modelFallbackStopReason !== 'tool_call_format_recovery' ||
      result.meta.aborted === true || result.meta.stopReason === 'timeout' ||
      typeof terminalError !== 'string') return 'failed';
    const characters = [];
    let bytes = 2; // JSON string quotes; reserve three more bytes for the omission marker.
    for (const character of terminalError) {
      const literal = JSON.stringify(character);
      const code = character.codePointAt(0);
      // JSON escapes are ASCII; otherwise count the character's actual UTF-8 width.
      const width = literal.length !== character.length + 2 ? literal.length - 2
        : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (bytes + width > 2048 - 3) {
        const text = characters.join('').trim();
        return text ? text + '…' : 'failed';
      }
      characters.push(character);
      bytes += width;
    }
    return characters.join('').trim() || 'failed';
  } catch { return 'failed'; }
}

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

// Defensive second whitelist at the prompt boundary. Only fixed labels and numbers are emitted.
function toolCallRecoveryPolicyFeedbackInstruction(value) {
  const kinds = {
    missing_tool_name: 'missing tool name', empty_arguments: 'missing or blank arguments',
    non_object_arguments: 'arguments must be a JSON object', invalid_json: 'invalid JSON',
    native_rejected: 'arguments rejected by the native JSON object validator',
  };
  const details = {
    xml_like_input: 'XML-like input; use a JSON object', unterminated_string: 'unterminated JSON string',
    invalid_escape: 'invalid JSON escape', unexpected_token: 'unexpected JSON token or missing delimiter',
  };
  try {
    if (!value || value.version !== 1 || !toolCallRecoveryPolicyIsNonNegativeSafeInteger(value.batchCallCount) ||
      !value.batchCallCount || !Array.isArray(value.issues) || value.issues.length > 3 ||
      typeof value.omitted !== 'boolean' || value.localization !== (value.issues.length ? 'located' : 'unlocalized')) return '';
    let previous = -1;
    const issues = value.issues.map(issue => {
      if (!issue || !toolCallRecoveryPolicyIsNonNegativeSafeInteger(issue.callIndex) ||
        issue.callIndex <= previous || issue.callIndex >= value.batchCallCount || !Object.hasOwn(kinds, issue.kind) ||
        !toolCallRecoveryPolicyIsNonNegativeSafeInteger(issue.argumentChars) ||
        (issue.detail !== undefined && (issue.kind !== 'invalid_json' || !Object.hasOwn(details, issue.detail))) ||
        (issue.position !== undefined && (issue.kind !== 'invalid_json' ||
          !toolCallRecoveryPolicyIsNonNegativeSafeInteger(issue.position) || issue.position > issue.argumentChars))) throw new Error();
      previous = issue.callIndex;
      return `Call ${issue.callIndex + 1}: ${kinds[issue.kind]}` +
        (issue.detail === undefined ? '' : ` (${details[issue.detail]})`) +
        `; argument length ${issue.argumentChars} UTF-16 units` +
        (issue.position === undefined ? '.' : `; error offset ${issue.position} (zero-based UTF-16).`);
    });
    return ` Rejected batch: all ${value.batchCallCount} calls were withheld, including valid siblings. ` +
      (issues.length ? issues.join(' ') : 'The failing call could not be localized within the diagnostic budget.') +
      (value.omitted ? ' Some diagnostics were omitted.' : '') +
      ' Reassess the entire rejected batch and generate complete calls for operations still needed; do not append only a missing suffix.';
  } catch { return ''; }
}

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
        : '') + toolCallRecoveryPolicyFeedbackInstruction(input.feedback),
  };
}
