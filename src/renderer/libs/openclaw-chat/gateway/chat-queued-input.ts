import { type CoworkAttachmentPayload, toGatewayAttachment } from '@shared/cowork/attachments';
import { QUEUED_INPUT_RUN_ID_PREFIX } from '@shared/openclaw/pendingInputs';

import { i18nService } from '@/services/i18n';

import { asRecord, type ChatState } from './chat-controller-support';

const FOLLOWUP_QUEUE_MODE = 'followup';
type Admission = { signature: string; runId: string; sending: boolean };
// Only unresolved transport admissions are retained, never a second execution queue.
const admissions = new WeakMap<ChatState, Map<string, Admission>>();

export function hasUnconfirmedQueuedInput(state: ChatState): boolean {
  const admission = admissions.get(state)?.get(JSON.stringify([state.sessionKey, state.currentSessionId]));
  return Boolean(admission && !admission.sending);
}

export async function sendQueuedInput(
  state: ChatState,
  message: string,
  attachments: CoworkAttachmentPayload[],
  expectedSessionKey: string,
): Promise<void> {
  const client = state.client;
  const sessionKey = state.sessionKey;
  const sessionId = state.currentSessionId;
  if (!client || !state.connected || !sessionId || sessionKey !== expectedSessionKey)
    throw new Error(i18nService.t('coworkQueueUnavailable'));
  if (state.historyReadFailed || state.compactionInFlight)
    throw new Error(i18nService.t('coworkQueueUnavailable'));
  const gatewayAttachments = attachments.filter(item => item.base64Data).map(toGatewayAttachment);
  const signature = JSON.stringify([sessionId, message, gatewayAttachments]);
  const scope = JSON.stringify([sessionKey, sessionId]);
  let sessionAdmissions = admissions.get(state);
  if (!sessionAdmissions) {
    sessionAdmissions = new Map();
    admissions.set(state, sessionAdmissions);
  }
  const previous = sessionAdmissions.get(scope);
  if (previous && (previous.sending || previous.signature !== signature))
    throw new Error(i18nService.t('coworkQueueOutcomeUnknown'));
  const admission = previous ?? {
    signature,
    runId: `${QUEUED_INPUT_RUN_ID_PREFIX}${crypto.randomUUID()}`,
    sending: false,
  };
  sessionAdmissions.set(scope, admission);
  admission.sending = true;
  try {
    await client.request('chat.send', {
      sessionKey,
      sessionId,
      message,
      queueMode: FOLLOWUP_QUEUE_MODE,
      // Queued text must not execute /stop, /new, or inline directives immediately.
      suppressCommandInterpretation: true,
      deliver: false,
      justdoUserInitiated: true,
      idempotencyKey: admission.runId,
      ...(gatewayAttachments.length ? { attachments: gatewayAttachments } : {}),
    });
    sessionAdmissions.delete(scope);
  } catch (error) {
    if (typeof asRecord(error)?.gatewayCode === 'string') {
      sessionAdmissions.delete(scope);
      throw error;
    }
    // Retrying the unchanged draft reuses the identity after a lost acknowledgement.
    throw new Error(i18nService.t('coworkQueueOutcomeUnknown'));
  } finally {
    admission.sending = false;
  }
}
