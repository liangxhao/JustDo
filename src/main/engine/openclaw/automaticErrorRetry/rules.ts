export interface AutomaticErrorRetryRule {
  readonly id: string;
  readonly errorCodes: readonly string[];
  readonly fixedPrompt: string;
}

export const REPEATED_TOOL_ERROR_CODE = 'openclaw_repeated_tool_error';

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
