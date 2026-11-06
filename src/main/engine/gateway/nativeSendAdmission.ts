import type { CoworkNativeSendBinding, CoworkStartOptions } from '../types';
import type { GatewayClientLike } from './types';

const notSent = (message: string): Error => Object.assign(new Error(message), { requestSent: false });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Read-only preparation; the caller performs the final check synchronously afterwards. */
export async function prepareNativeSendBinding(context: {
  client: GatewayClientLike;
  isCurrent: () => boolean;
  sessionKey: string;
  nativeSessionId: string;
  clientGeneration: number;
}): Promise<CoworkNativeSendBinding> {
  const response = await context.client.request<unknown>('sessions.describe', { key: context.sessionKey });
  if (!context.isCurrent()) throw notSent('The prepared native connection changed.');
  const session = isRecord(response) && isRecord(response.session) ? response.session : undefined;
  if (session?.key !== context.sessionKey || session.sessionId !== context.nativeSessionId ||
    typeof session.lifecycleRevision !== 'string' || !session.lifecycleRevision ||
    session.lifecycleRevision.trim() !== session.lifecycleRevision) {
    throw notSent('The prepared native identity could not be confirmed.');
  }
  return Object.freeze({
    sessionKey: context.sessionKey,
    nativeSessionId: context.nativeSessionId,
    lifecycleRevision: session.lifecycleRevision,
    clientGeneration: context.clientGeneration,
  });
}

/** A promise-returning admission would reopen the race this boundary closes. */
export function admitNativeSend(
  binding: CoworkNativeSendBinding,
  admission: CoworkStartOptions['finalSyncAdmission'],
): void {
  const result: unknown = admission?.(binding);
  if (isRecord(result) && typeof result.then === 'function') {
    void Promise.resolve(result).catch((): void => undefined);
    throw notSent('Final native admission must be synchronous.');
  }
}

export function notifyNativeAccepted(context: {
  binding: CoworkNativeSendBinding;
  receipt: unknown;
  clientTurnId: string;
  isCurrent: () => boolean;
  onAccepted: CoworkStartOptions['onNativeAccepted'];
}): boolean {
  const receipt = context.receipt;
  if (!context.isCurrent() || !isRecord(receipt) || typeof receipt.runId !== 'string' ||
    !receipt.runId || receipt.runId.trim() !== receipt.runId ||
    (receipt.sessionId !== undefined && receipt.sessionId !== context.binding.nativeSessionId) ||
    (receipt.sessionKey !== undefined && receipt.sessionKey !== context.binding.sessionKey) ||
    (receipt.lifecycleRevision !== undefined && receipt.lifecycleRevision !== context.binding.lifecycleRevision)) return false;
  context.onAccepted?.(Object.freeze({
    ...context.binding,
    clientTurnId: context.clientTurnId,
    nativeRunId: receipt.runId,
  }));
  return true;
}
