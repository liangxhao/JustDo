import { readBrowserPromptBoundary } from '@shared/browser/browserMessageContext';
import {
  type CoworkAttachmentPayload,
  type GatewayAttachmentPayload,
  toGatewayAttachment,
} from '@shared/cowork/attachments';
import { normalizeMessageSessionKey } from '@shared/openclaw/messageDomain';
import { QUEUED_INPUT_RUN_ID_PREFIX } from '@shared/openclaw/pendingInputs';
import { type PermissionMode, toOpenClawSessionPermissionMode } from '@shared/security/approvals';

import { readCommittedUserInputKey } from '@/libs/openclaw-chat/model/history/session-message-apply';
import { i18nService } from '@/services/i18n';

import { asRecord, type ChatState } from '../chat-controller-support';

const FOLLOWUP_QUEUE_MODE = 'followup';
type Admission = {
  runId: string;
  permissionMode: PermissionMode | undefined;
  direct?: true;
  browserBoundaryId?: string;
  wireFingerprint?: string;
  sending: boolean;
  recovered?: 'accepted' | 'cancelled';
  isDraftCurrent?: () => boolean;
};
type DraftAdmissions = Map<string, Admission>;
export type RetainedDirectInput = {
  sessionKey: string;
  sessionId: string;
  fingerprint: string;
  runId: string;
  isDraftCurrent?: () => boolean;
};
// Retain draft fingerprints and native identities until the submitting UI has a result.
const admissions = new WeakMap<object, Map<string, DraftAdmissions>>();
const admissionOwners = new WeakMap<ChatState, object>();
const restagedAudioDirectives = new Map<string, string>();

/** Keep pending draft identities when the same composer remounts its chat controller. */
export function bindChatInputAdmissionOwner(state: ChatState, owner: object): void {
  admissionOwners.set(state, owner);
}

/** A replacement copy keeps the initial draft identity for the same audio version. */
export function recordRestagedAudioDirective(directive: string, original: string): void {
  restagedAudioDirectives.set(directive, original);
}

function admissionScope(sessionKey: string, sessionId: string | null): string {
  return JSON.stringify([normalizeMessageSessionKey(sessionKey), sessionId]);
}

function toGatewayAttachments(attachments: readonly CoworkAttachmentPayload[]): GatewayAttachmentPayload[] {
  return attachments.filter(item => item.base64Data).map(toGatewayAttachment);
}

function describeInputMessage(
  message: string,
  boundary: ReturnType<typeof readBrowserPromptBoundary>,
): { wire: string; draft: string } {
  const wire = boundary?.replace('') ?? message;
  if (!restagedAudioDirectives.size) return { wire, draft: wire };
  const textStart = boundary ? boundary.userTextStart - 2 * boundary.id.length : 0;
  const draft = wire.slice(0, textStart) + wire.slice(textStart).replace(
    /^MEDIA:[^\r\n]+$/gm, line => restagedAudioDirectives.get(line) ?? line,
  );
  return { wire, draft };
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function fingerprintGatewayInput(
  message: string,
  attachments: readonly GatewayAttachmentPayload[],
  hasBrowserBoundary: boolean,
): Promise<string> {
  return digest(JSON.stringify([hasBrowserBoundary, message, attachments]));
}

export function fingerprintChatInput(
  message: string,
  attachments: readonly CoworkAttachmentPayload[],
): Promise<string> {
  const boundary = readBrowserPromptBoundary(message);
  const { draft } = describeInputMessage(message, boundary);
  return fingerprintGatewayInput(draft, toGatewayAttachments(attachments), boundary !== null);
}

function selectedDraftAdmissions(state: ChatState): DraftAdmissions | undefined {
  return admissions.get(admissionOwners.get(state) ?? state)?.get(admissionScope(state.sessionKey, state.currentSessionId));
}

function getSessionDraftAdmissions(state: ChatState, scope: string) {
  const owner = admissionOwners.get(state) ?? state;
  let sessionAdmissions = admissions.get(owner);
  if (!sessionAdmissions) {
    sessionAdmissions = new Map();
    admissions.set(owner, sessionAdmissions);
  }
  let drafts = sessionAdmissions.get(scope);
  if (!drafts) {
    drafts = new Map();
    sessionAdmissions.set(scope, drafts);
  }
  return { sessionAdmissions, drafts };
}

function readDraftAdmission(drafts: DraftAdmissions, fingerprint: string): Admission | undefined {
  const admission = drafts.get(fingerprint);
  if (admission && !admission.sending && admission.isDraftCurrent?.() === false) {
    drafts.delete(fingerprint);
    return undefined;
  }
  return admission;
}

/** Keep the original input identity after Main retires its session-level receipt. */
export function rememberDirectInput(
  state: ChatState,
  { sessionKey, sessionId, fingerprint, runId, isDraftCurrent }: RetainedDirectInput,
): void {
  const { drafts } = getSessionDraftAdmissions(state, admissionScope(sessionKey, sessionId));
  if (readDraftAdmission(drafts, fingerprint)) return;
  drafts.set(fingerprint, { runId, direct: true, permissionMode: undefined, sending: false, isDraftCurrent });
  if (state.transcript.sessionId === sessionId && selectedDraftAdmissions(state) === drafts) {
    recoverQueuedInputsFromMessages(state, sessionId, state.chatMessages);
  }
}

export function hasUnconfirmedQueuedInput(state: ChatState): boolean {
  const drafts = selectedDraftAdmissions(state);
  return Boolean(drafts && [...drafts.keys()].some(fingerprint => {
    const admission = readDraftAdmission(drafts, fingerprint);
    return admission && !admission.direct && !admission.sending && !admission.recovered;
  }));
}

export function matchInputForRecovery(
  state: ChatState,
  message: string,
  attachments: readonly CoworkAttachmentPayload[],
  expectedSessionKey: string,
): Promise<boolean> | null {
  if (state.sessionKey !== expectedSessionKey) return null;
  const drafts = selectedDraftAdmissions(state);
  if (!drafts) return null;
  const canRecover = (fingerprint: string) => {
    const admission = readDraftAdmission(drafts, fingerprint);
    return Boolean(admission?.recovered || admission?.direct);
  };
  if (![...drafts.keys()].some(canRecover)) return null;
  return fingerprintChatInput(message, attachments).then(fingerprint =>
    state.sessionKey === expectedSessionKey && selectedDraftAdmissions(state) === drafts && canRecover(fingerprint),
  );
}

export function unconfirmedQueuedInputRunIds(state: ChatState): string[] {
  return [...(selectedDraftAdmissions(state)?.values() ?? [])].flatMap(admission =>
    admission.sending || admission.recovered ? [] : [admission.runId],
  );
}

/** Receipt rows must already have passed the native batch and physical session checks. */
export function recoverQueuedInputAdmissions(state: ChatState, receipts: readonly unknown[]): void {
  const drafts = selectedDraftAdmissions(state);
  if (!drafts?.size) return;
  const recovered = new Map<string, NonNullable<Admission['recovered']>>();
  for (const value of receipts) {
    const receipt = asRecord(value);
    if (typeof receipt?.runId === 'string') {
      recovered.set(receipt.runId, receipt.cancelled === true ? 'cancelled' : 'accepted');
    }
  }
  for (const admission of drafts.values()) {
    const outcome = recovered.get(admission.runId);
    if (outcome) admission.recovered = outcome;
  }
}

/** Native consumption may remove the receipt once the durable user message owns the input. */
export function recoverQueuedInputsFromMessages(
  state: ChatState,
  sessionId: unknown,
  messages: readonly unknown[],
): void {
  if (!state.currentSessionId || state.currentSessionId !== sessionId) return;
  const drafts = selectedDraftAdmissions(state);
  if (!drafts?.size) return;
  const acceptedKeys = new Set(messages.map(readCommittedUserInputKey));
  for (const admission of drafts.values()) {
    if (!admission.recovered && acceptedKeys.has(`${admission.runId}:user`)) admission.recovered = 'accepted';
  }
}

export async function sendQueuedInput(
  state: ChatState,
  message: string,
  attachments: CoworkAttachmentPayload[],
  expectedSessionKey: string,
  permissionMode?: PermissionMode,
  assertCurrent?: () => void,
  isDraftCurrent?: () => boolean,
): Promise<void> {
  const { client, sessionKey, currentSessionId: sessionId, transcript } = state;
  if (!client || !state.connected || !sessionId || sessionKey !== expectedSessionKey)
    throw new Error(i18nService.t('coworkQueueUnavailable'));
  const requireHistoryReady = () => {
    if (state.historyReadFailed || state.historyPreparationPending || state.compactionInFlight)
      throw new Error(i18nService.t(state.historyPreparationPending || state.historyPreparationTimedOut
        ? 'storageHistoryPreparationPending' : 'coworkQueueUnavailable'));
  };
  requireHistoryReady();
  const generation = client.generation;
  const historyGeneration = transcript.historyGeneration;
  const gatewayAttachments = toGatewayAttachments(attachments);
  const boundary = readBrowserPromptBoundary(message);
  const { draft, wire } = describeInputMessage(message, boundary);
  const fingerprint = await fingerprintGatewayInput(draft, gatewayAttachments, boundary !== null);
  const wireFingerprint = wire === draft ? undefined : await digest(wire);
  if (!state.connected || state.client !== client || client.generation !== generation ||
      state.sessionKey !== sessionKey || state.currentSessionId !== sessionId ||
      state.transcript !== transcript || transcript.historyGeneration !== historyGeneration) {
    throw new Error(i18nService.t('coworkQueueUnavailable'));
  }
  requireHistoryReady();
  assertCurrent?.();

  const scope = admissionScope(sessionKey, sessionId);
  const { sessionAdmissions, drafts } = getSessionDraftAdmissions(state, scope);
  const previous = readDraftAdmission(drafts, fingerprint);
  // Only exact native input evidence can confirm a direct send. Its wire request cannot be replayed as a follow-up.
  if (previous?.direct && !previous.recovered) throw new Error(i18nService.t('coworkSendOutcomeUnknown'));
  if (previous?.sending || (previous && !previous.recovered &&
      (previous.permissionMode !== permissionMode || previous.wireFingerprint !== wireFingerprint)))
    throw new Error(i18nService.t('coworkQueueOutcomeUnknown'));
  const admission = previous ?? {
    runId: `${QUEUED_INPUT_RUN_ID_PREFIX}${crypto.randomUUID()}`,
    permissionMode,
    browserBoundaryId: boundary?.id,
    wireFingerprint,
    sending: false,
    isDraftCurrent,
  };
  drafts.set(fingerprint, admission);
  const forget = () => {
    drafts.delete(fingerprint);
    if (drafts.size === 0) sessionAdmissions.delete(scope);
  };
  if (!previous?.recovered) {
    admission.sending = true;
    try {
      const result = asRecord(await client.request('chat.send', {
        sessionKey,
        sessionId,
        message: boundary && admission.browserBoundaryId ? boundary.replace(admission.browserBoundaryId) : message,
        queueMode: FOLLOWUP_QUEUE_MODE,
        // Queued text must not execute /stop, /new, or inline directives immediately.
        suppressCommandInterpretation: true,
        deliver: false,
        justdoUserInitiated: true,
        idempotencyKey: admission.runId,
        ...(permissionMode ? { expectedPermissionMode: toOpenClawSessionPermissionMode(permissionMode) } : {}),
        ...(gatewayAttachments.length ? { attachments: gatewayAttachments } : {}),
      }));
      if (result?.runId === admission.runId) {
        if ((result.status === 'started' || result.status === 'ok') && !admission.recovered)
          admission.recovered = 'accepted';
        if (result.status === 'timeout' && result.summary === 'aborted' &&
            typeof result.endedAt === 'number' && Number.isFinite(result.endedAt))
          admission.recovered = 'cancelled';
      }
    } catch (error) {
      const reason = asRecord(error);
      if (!previous && !admission.recovered && (reason?.requestSent === false || typeof reason?.gatewayCode === 'string')) {
        forget();
        throw error;
      }
    } finally {
      admission.sending = false;
    }
  }
  if (!admission.recovered) {
    // An in-flight response or transport failure leaves the exact identity available for unchanged retries.
    throw new Error(i18nService.t('coworkQueueOutcomeUnknown'));
  }
  forget();
  if (admission.recovered === 'cancelled') throw new Error(i18nService.t('coworkQueueUnavailable'));
}
