export interface AutomaticErrorRetryRule {
  readonly id: string;
  readonly errorCodes: readonly string[];
  readonly fixedPrompt: string;
}

export const REPEATED_TOOL_ERROR_CODE = 'openclaw_repeated_tool_error';
export const CONTEXT_OVERFLOW_ERROR_CODE = 'context_overflow';
export const SESSION_READER_FAILURE_CODE = 'session_reader_not_current';
export const SESSION_READER_RETRY_RULE_ID = 'session-reader-not-current';

export const AUTOMATIC_ERROR_RETRY_RULES: readonly AutomaticErrorRetryRule[] = [
  {
    id: 'repeated-tool-error',
    errorCodes: [REPEATED_TOOL_ERROR_CODE],
    fixedPrompt: [
      'The previous tool action repeatedly returned the same error.',
      'Do not repeat the failed call unchanged. Review the existing tool results, correct the arguments or choose another currently available method, and continue the original task.',
      'If you cannot continue, explain what is complete, what remains, and the blocker.',
      'Do not assume the failed operation had no side effects. Work on the original task without repeating this feedback.',
    ].join(' '),
  },
  {
    id: 'context-overflow',
    errorCodes: [CONTEXT_OVERFLOW_ERROR_CODE],
    fixedPrompt: [
      'Continue the original task from the saved conversation and workspace state after the context limit interrupted the previous run.',
      'Review completed work and existing results before acting. Verify the outcome of any prior action that might have had side effects before retrying it.',
      'Read only relevant portions of files and limit command output to the details needed for the next step.',
      'If you cannot continue, explain what is complete, what remains, and the blocker.',
    ].join(' '),
  },
  {
    id: SESSION_READER_RETRY_RULE_ID,
    errorCodes: [SESSION_READER_FAILURE_CODE],
    fixedPrompt: [
      'Continue the task requested in the saved user message from the current conversation and workspace state.',
      'Review completed work and verify the outcome of previous actions before deciding what needs to run next.',
      'If you cannot continue, explain what is complete, what remains, and the blocker.',
    ].join(' '),
  },
];

export function createAutomaticErrorRetryRuleIndex(
  rules: readonly AutomaticErrorRetryRule[] = AUTOMATIC_ERROR_RETRY_RULES,
): ReadonlyMap<string, AutomaticErrorRetryRule> {
  const ids = new Set<string>();
  const index = new Map<string, AutomaticErrorRetryRule>();
  for (const rule of rules) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(rule.id) || ids.has(rule.id) || !rule.fixedPrompt.trim() || !rule.errorCodes.length)
      throw new Error('Invalid or duplicate automatic error retry rule');
    ids.add(rule.id);
    for (const code of rule.errorCodes) {
      if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(code) || index.has(code)) throw new Error('Invalid or duplicate automatic error retry code');
      index.set(code, Object.freeze({ ...rule, errorCodes: Object.freeze([...rule.errorCodes]) }));
    }
  }
  return index;
}
