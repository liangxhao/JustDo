import { createHash } from 'node:crypto';

const FAILURE_REASONS = [
  ['In-process gateway dispatch requires', 'gateway-context-unavailable'],
  ['agent tool caller authority is no longer active', 'caller-authority-expired'],
  ['operator run authority must be issued by the host', 'host-authority-owner-mismatch'],
  ['Gateway client authority closed', 'caller-authority-expired'],
  ['operator tool invocation authority expired', 'caller-authority-expired'],
  [
    'Gateway requests are only available to bundled or trusted official plugins',
    'plugin-trust-unavailable',
  ],
  ['Collaboration service unavailable.', 'service-unavailable'],
  ['Collaboration stopped.', 'service-stopped'],
  ['Native call identity is already bound.', 'duplicate-call-identity'],
  ['Missing native call identity.', 'missing-call-identity'],
  ['The native tool call is no longer active.', 'call-identity-expired'],
  ['The native collaboration receipt is no longer active.', 'receipt-expired'],
  ['Collaboration target is unavailable.', 'target-unavailable'],
  ['Collaboration host did not respond.', 'host-timeout'],
  ['Invalid collaboration admission.', 'invalid-admission'],
  ['Collaboration sending is unavailable in Plan mode.', 'plan-mode'],
  ['teamDiscussionSourcePolicyUnsupported', 'source-policy-unsupported'],
  ['missing scope', 'gateway-scope-unavailable'],
] as const;

/** Project exceptions to closed reasons; never expose task text or credentials. */
export const collaborationCallFailure = (error: unknown) => {
  const message =
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : '';
  const known = FAILURE_REASONS.find(([pattern]) => message.includes(pattern));
  return {
    reason: known?.[1] ?? 'unexpected-failure',
    safeMessage: known && message === known[0] ? known[0] : undefined,
    reference: createHash('sha256').update(message).digest('hex').slice(0, 12),
  };
};

export class CollaborationCallError extends Error {
  constructor(method: string, error: unknown) {
    const failure = collaborationCallFailure(error);
    super(
      `Agent Team ${method} failed (${failure.reason}; reference ${failure.reference}). ${failure.safeMessage ? `${failure.safeMessage} ` : ''}Report this error and stop retrying within this run.`,
    );
    this.name = 'CollaborationCallError';
  }
}
