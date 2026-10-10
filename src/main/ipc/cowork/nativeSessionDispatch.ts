import { randomUUID } from 'node:crypto';

import type { IpcMainInvokeEvent, WebContents } from 'electron';

import {
  NativeSessionDispatchIpc,
  type NativeSessionDispatchRequest,
  type NativeSessionDispatchResponse,
} from '../../../shared/cowork/nativeSessionDispatch';
import { isChatSendStopReceipt } from '../../../shared/openclaw/chatSendReceipt';
import { t } from '../../core/i18n';

const DISPATCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

/** Captured before preparation awaits; even a same-URL reload revokes this document. */
export function captureInitialDispatchLease(
  event: IpcMainInvokeEvent,
  onInvalidated?: () => void,
): { isCurrent: () => boolean; dispose: () => void } {
  const owner = event.sender;
  const frame = event.senderFrame;
  const url = frame?.url;
  let valid = true;
  const invalidate = () => {
    if (!valid) return;
    valid = false;
    onInvalidated?.();
  };
  const navigated = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame) invalidate();
  };
  owner.once('destroyed', invalidate);
  owner.once('render-process-gone', invalidate);
  owner.on('did-start-navigation', navigated);
  return {
    isCurrent: () =>
      valid &&
      !owner.isDestroyed() &&
      Boolean(frame && frame === owner.mainFrame && frame.url === url),
    dispose: () => {
      valid = false;
      owner.removeListener('destroyed', invalidate);
      owner.removeListener('render-process-gone', invalidate);
      owner.removeListener('did-start-navigation', navigated);
    },
  };
}

function uncertainDispatchError(): Error {
  return Object.assign(new Error(t('coworkInitialDispatchUncertain')), {
    code: 'CLIENT_TIMEOUT',
    requestSent: true,
  });
}

/** One-shot window/frame-bound handoff, with no fallback send or uncertain retry. */
export class NativeSessionDispatcher {
  private readonly pending = new Map<
    string,
    {
      owner: WebContents;
      frame: NonNullable<IpcMainInvokeEvent['senderFrame']>;
      url: string;
      clientTurnId: string;
      settle: (response?: NativeSessionDispatchResponse) => void;
    }
  >();

  dispatch(
    event: IpcMainInvokeEvent,
    input: Omit<NativeSessionDispatchRequest, 'requestId'>,
    lease?: { isCurrent: () => boolean },
  ): Promise<unknown> {
    const owner = event.sender;
    const frame = event.senderFrame;
    if (
      owner.isDestroyed() ||
      !frame ||
      frame !== owner.mainFrame ||
      (lease && !lease.isCurrent())
    ) {
      return Promise.reject(
        Object.assign(new Error(t('coworkInitialDispatchUnavailable')), {
          requestSent: false,
        }),
      );
    }
    if (
      input.params.idempotencyKey !== input.clientTurnId ||
      input.params.sessionKey !== input.sessionKey
    ) {
      return Promise.reject(
        Object.assign(new Error(t('coworkInitialDispatchInvalid')), {
          requestSent: false,
        }),
      );
    }
    const requestId = randomUUID();
    const url = frame.url;
    return new Promise((resolve, reject) => {
      let settled = false;
      const disconnected = () => settle();
      const navigated = (
        _event: unknown,
        _url: string,
        _inPlace: boolean,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame) settle();
      };
      const settle = (response?: NativeSessionDispatchResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(requestId);
        owner.removeListener('destroyed', disconnected);
        owner.removeListener('render-process-gone', disconnected);
        owner.removeListener('did-start-navigation', navigated);
        if (!response) return reject(uncertainDispatchError());
        if (response.success) return resolve(response.payload);
        const error = Object.assign(new Error(response.error || t('coworkInitialDispatchFailed')), {
          ...(response.gatewayCode ? { gatewayCode: response.gatewayCode } : {}),
          requestSent: response.requestSent,
          ...(response.requestSent !== false && !response.gatewayCode
            ? { code: 'CLIENT_TIMEOUT' }
            : {}),
        });
        reject(error);
      };
      const timer = setTimeout(disconnected, DISPATCH_TIMEOUT_MS);
      this.pending.set(requestId, { owner, frame, url, clientTurnId: input.clientTurnId, settle });
      owner.once('destroyed', disconnected);
      owner.once('render-process-gone', disconnected);
      owner.on('did-start-navigation', navigated);
      try {
        owner.send(NativeSessionDispatchIpc.Request, { ...input, requestId });
      } catch {
        settle();
      }
    });
  }

  respond(event: IpcMainInvokeEvent, value: unknown): { success: boolean } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { success: false };
    const response = value as NativeSessionDispatchResponse;
    const pending = this.pending.get(response.requestId);
    if (
      !pending ||
      event.sender !== pending.owner ||
      event.sender.isDestroyed() ||
      !event.senderFrame ||
      event.senderFrame !== pending.frame ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== pending.url ||
      response.clientTurnId !== pending.clientTurnId ||
      typeof response.success !== 'boolean' ||
      (response.error !== undefined &&
        (typeof response.error !== 'string' || response.error.length > 2000)) ||
      (response.gatewayCode !== undefined &&
        (typeof response.gatewayCode !== 'string' || response.gatewayCode.length > 100)) ||
      (response.requestSent !== undefined && typeof response.requestSent !== 'boolean')
    ) {
      return { success: false };
    }
    try {
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESPONSE_BYTES)
        return { success: false };
      if (
        response.success &&
        !isChatSendStopReceipt(response.payload) &&
        (!response.payload ||
          typeof response.payload !== 'object' ||
          Array.isArray(response.payload) ||
          typeof (response.payload as { runId?: unknown }).runId !== 'string' ||
          (response.payload as { runId: string }).runId !== pending.clientTurnId)
      )
        return { success: false };
    } catch {
      return { success: false };
    }
    pending.settle(response);
    return { success: true };
  }
}
