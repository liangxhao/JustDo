import crypto from 'crypto';

import type {
  AskUserQuestion,
  AskUserRequest,
  AskUserResponse,
} from '../../../shared/openclawExtensions';

const ASK_USER_TIMEOUT_MS = 120_000;

type PendingRequest = {
  resolve: (response: AskUserResponse) => void;
  timer: ReturnType<typeof setTimeout>;
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

    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.resolve(response);
    return true;
  }

  request(questions: AskUserQuestion[], sessionKey?: string): Promise<AskUserResponse> {
    const requestId = crypto.randomUUID();

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.dismissCallback?.(requestId);
        resolve({ behavior: 'deny' });
      }, ASK_USER_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, timer });

      if (this.requestCallback) {
        this.requestCallback({ requestId, sessionKey, questions });
        return;
      }

      clearTimeout(timer);
      this.pendingRequests.delete(requestId);
      resolve({ behavior: 'deny' });
    });
  }
}
