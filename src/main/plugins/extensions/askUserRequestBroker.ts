import crypto from 'crypto';

import type {
  AskUserQuestion,
  AskUserRequest,
  AskUserResponse,
  AskUserWaitPolicy,
} from '../../../shared/openclaw/extensions';
import {
  AskUserTimeoutBehavior,
  AskUserWaitMode,
  buildAskUserDefaultAnswers,
} from '../../../shared/openclaw/extensions';

type PendingRequest = {
  request: AskUserRequest;
  resolve: (response: AskUserResponse) => void;
  timeout?: NodeJS.Timeout;
};

export type AskUserPendingRequest = {
  requestId: string;
  response: Promise<AskUserResponse>;
};

export class AskUserRequestBroker {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private requestCallback: ((request: AskUserRequest) => void) | null = null;
  private dismissCallback: ((requestId: string) => void) | null = null;

  onRequest(callback: (request: AskUserRequest) => void): void {
    this.requestCallback = callback;
  }

  onDismiss(callback: (requestId: string) => void): void {
    this.dismissCallback = callback;
  }

  resolve(requestId: string, response: AskUserResponse): boolean {
    return this.settle(requestId, response, false);
  }

  cancel(requestId: string): boolean {
    return this.settle(requestId, { behavior: 'deny' }, true);
  }

  get(requestId: string): AskUserRequest | null {
    return this.pendingRequests.get(requestId)?.request ?? null;
  }

  list(): AskUserRequest[] {
    return Array.from(this.pendingRequests.values(), pending => pending.request);
  }

  cancelAll(): void {
    for (const requestId of Array.from(this.pendingRequests.keys())) this.cancel(requestId);
  }

  request(
    questions: AskUserQuestion[],
    waitPolicy: AskUserWaitPolicy,
    sessionKey?: string,
  ): AskUserPendingRequest {
    const requestId = crypto.randomUUID();
    const expiresAt =
      waitPolicy.mode === AskUserWaitMode.TIMEOUT
        ? Date.now() + waitPolicy.timeoutMinutes * 60_000
        : undefined;
    const request: AskUserRequest = {
      requestId,
      sessionKey,
      questions,
      waitPolicy,
      ...(expiresAt ? { expiresAt } : {}),
    };

    const response = new Promise<AskUserResponse>(resolve => {
      const pending: PendingRequest = { request, resolve };
      if (waitPolicy.mode === AskUserWaitMode.TIMEOUT) {
        pending.timeout = setTimeout(() => {
          const answers =
            waitPolicy.onTimeout === AskUserTimeoutBehavior.USE_DEFAULTS
              ? buildAskUserDefaultAnswers(questions)
              : null;
          this.settle(
            requestId,
            answers
              ? { behavior: 'allow', answers, timedOut: true }
              : { behavior: 'timeout', timedOut: true },
            true,
          );
        }, waitPolicy.timeoutMinutes * 60_000);
        pending.timeout.unref();
      }
      this.pendingRequests.set(requestId, pending);

      if (this.requestCallback) {
        try {
          this.requestCallback(request);
        } catch (error) {
          console.error(
            '[AskUserRequestBroker] Failed to publish request:',
            error instanceof Error ? error.message : String(error),
          );
          this.settle(requestId, { behavior: 'deny' }, true);
        }
        return;
      }

      this.settle(requestId, { behavior: 'deny' }, false);
    });

    return { requestId, response };
  }

  private settle(requestId: string, response: AskUserResponse, dismiss: boolean): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;

    this.pendingRequests.delete(requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.resolve(response);
    if (dismiss) {
      try {
        this.dismissCallback?.(requestId);
      } catch (error) {
        console.error(
          '[AskUserRequestBroker] Failed to publish dismissal:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return true;
  }
}
