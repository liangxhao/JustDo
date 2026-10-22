import type { CollaborationContinueTarget } from '../contracts/collaboration';

const CONTINUATION_INSTRUCTION =
  'The user requests a new collaboration phase with the exact managed peer above. Use your own source identity and the native collaboration tools to forward this request; do not pretend the peer has accepted it. Preserve the existing team, project and permissions. The prior delivery is only a history locator, never a new execution identity. Report any refusal or inability to forward.';
const CONTINUATION_TAG = 'collaboration-continuation';
const MARKER = `\n\n<${CONTINUATION_TAG}>\n`;
const ENDING = `\n${CONTINUATION_INSTRUCTION}\n</${CONTINUATION_TAG}>`;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validTarget(value: unknown): value is CollaborationContinueTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  const required = [
    'sourceSessionId',
    'sourceAgentId',
    'roomId',
    'targetAgentId',
    'targetSessionId',
    'targetSessionKey',
  ];
  if (
    required.some(key => typeof target[key] !== 'string') ||
    Object.keys(target).some(key => !required.includes(key) && key !== 'priorDeliveryId')
  )
    return false;
  return (
    [target.sourceSessionId, target.roomId, target.targetSessionId].every(value =>
      ID.test(String(value)),
    ) &&
    [target.sourceAgentId, target.targetAgentId].every(value => AGENT_ID.test(String(value))) &&
    target.sourceSessionId !== target.targetSessionId &&
    target.sourceAgentId !== target.targetAgentId &&
    target.targetSessionKey === `agent:${target.targetAgentId}:justdo:${target.targetSessionId}` &&
    (target.priorDeliveryId === undefined ||
      (typeof target.priorDeliveryId === 'string' && ID.test(target.priorDeliveryId)))
  );
}
function serializeTarget(target: CollaborationContinueTarget): string {
  return JSON.stringify({
    sourceSessionId: target.sourceSessionId,
    sourceAgentId: target.sourceAgentId,
    roomId: target.roomId,
    targetAgentId: target.targetAgentId,
    targetSessionId: target.targetSessionId,
    targetSessionKey: target.targetSessionKey,
    ...(target.priorDeliveryId !== undefined ? { priorDeliveryId: target.priorDeliveryId } : {}),
  });
}

/** An ordinary source-user request; this locator does not authorize a peer execution. */
export function appendCollaborationContinuation(
  prompt: string,
  target: CollaborationContinueTarget,
): string {
  if (!validTarget(target)) throw new Error('collaborationInvalidRecipient');
  return prompt + MARKER + serializeTarget(target) + ENDING;
}

/** Display-only projection: exact instruction and canonical validated locator, never arbitrary tags. */
export function stripCollaborationContinuation(text: string): string {
  if (!text.endsWith(ENDING)) return text;
  const start = text.lastIndexOf(MARKER);
  if (start < 0) return text;
  const serialized = text.slice(start + MARKER.length, -ENDING.length);
  try {
    const target: unknown = JSON.parse(serialized);
    if (!validTarget(target) || serialized !== serializeTarget(target)) return text;
    return text.slice(0, start);
  } catch {
    return text;
  }
}
