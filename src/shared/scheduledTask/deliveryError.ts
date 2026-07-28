/**
 * OpenClaw emits this routing error when announce delivery is requested but
 * there is no external channel to target. JustDo's in-app result retention is
 * independent of announce delivery, so this is not actionable for in-app-only
 * users and should not be surfaced as a result warning.
 */
export function isMissingExternalChannelError(error: unknown): boolean {
  return typeof error === 'string' && /^Channel is required\b/i.test(error.trim());
}
