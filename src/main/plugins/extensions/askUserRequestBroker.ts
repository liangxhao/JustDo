import crypto from 'crypto';

import type {
  AskUserQuestion,
  AskUserRequest,
  AskUserResponse,
} from '../../../shared/openclaw/extensions';

type PendingRequest = {
  request: AskUserRequest;
  resolve: (response: AskUserResponse) => void;
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
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;

    this.pendingRequests.delete(requestId);
    pending.resolve(response);
    return true;
  }

  cancel(requestId: string): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;

    this.pendingRequests.delete(requestId);
    this.dismissCallback?.(requestId);
    pending.resolve({ behavior: 'deny' });
    return true;
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

  request(questions: AskUserQuestion[], sessionKey?: string): AskUserPendingRequest {
    const requestId = crypto.randomUUID();
    const request = { requestId, sessionKey, questions };

    const response = new Promise<AskUserResponse>(resolve => {
      this.pendingRequests.set(requestId, { request, resolve });

      if (this.requestCallback) {
        this.requestCallback(request);
        return;
      }

      this.pendingRequests.delete(requestId);
      resolve({ behavior: 'deny' });
    });

    return { requestId, response };
  }
}
