import crypto from 'crypto';

import type {
  AskUserRequest,
  AskUserResponse,
} from '../../../shared/openclaw/extensions';
import {
  parseAskUserAnswers,
} from '../../../shared/openclaw/extensions';
import type { AskUserExtensionConfig } from '../../openclaw/config/openclawConfigSync';
import {
  type ExtensionInteractionResponse,
  type ExtensionInteractionResult,
  ExtensionInteractionRouter,
} from './extensionInteractionRouter';
import { OpenClawExtensionCallbackServer } from './openclawExtensionCallbackServer';

type OpenClawExtensionHostControllerDeps = {
  onAskUser: (request: AskUserRequest) => void;
  onAskUserDismiss: (requestId: string) => void;
};

export class OpenClawExtensionHostController {
  private readonly deps: OpenClawExtensionHostControllerDeps;
  private bridgeServer: OpenClawExtensionCallbackServer | null = null;
  private secret: string | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private readonly interactionRouter = new ExtensionInteractionRouter();

  constructor(deps: OpenClawExtensionHostControllerDeps) {
    this.deps = deps;
    this.interactionRouter.register((requestId, result) => {
      const request = this.getPendingAskUserRequest(requestId);
      const answers = result.behavior === 'allow' && request
        ? parseAskUserAnswers(result.updatedInput?.answers, request.questions)
        : null;
      const behavior = result.behavior === 'allow' && answers ? 'allow' : 'deny';
      const handled = this.resolveAskUser(requestId, {
        behavior,
        ...(answers ? { answers } : {}),
      });
      return {
        handled,
        behavior,
        ...(answers ? { answers } : {}),
        ...(request ? { questions: request.questions } : {}),
      };
    });
  }

  get config(): AskUserExtensionConfig | null {
    const askUserCallbackUrl = this.bridgeServer?.askUserCallbackUrl;
    if (!askUserCallbackUrl || !this.secret) return null;

    return {
      askUserCallbackUrl,
      secret: this.secret,
    };
  }

  start(): Promise<AskUserExtensionConfig | null> {
    return this.enqueueLifecycle(() => this.startInternal());
  }

  resolveAskUser(requestId: string, response: AskUserResponse): boolean {
    return this.bridgeServer?.resolveAskUser(requestId, response) ?? false;
  }

  getPendingAskUserRequest(requestId: string): AskUserRequest | null {
    return this.bridgeServer?.getPendingAskUserRequest(requestId) ?? null;
  }

  listPendingAskUserRequests(): AskUserRequest[] {
    return this.bridgeServer?.listPendingAskUserRequests() ?? [];
  }

  respondToInteraction(
    requestId: string,
    result: ExtensionInteractionResult,
  ): ExtensionInteractionResponse {
    return this.interactionRouter.respond(requestId, result);
  }

  stop(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      await this.bridgeServer?.stop();
    });
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  private async startInternal(): Promise<AskUserExtensionConfig | null> {
    try {
      this.secret ??= crypto.randomUUID();

      if (!this.bridgeServer) {
        this.bridgeServer = new OpenClawExtensionCallbackServer(this.secret);
        this.bridgeServer.onAskUser(this.deps.onAskUser);
        this.bridgeServer.onAskUserDismiss(this.deps.onAskUserDismiss);
      }
      if (!this.bridgeServer.port) {
        await this.bridgeServer.start();
      }

      return this.config;
    } catch (error) {
      console.error(
        '[OpenClawExtensionHost] startup error:',
        error instanceof Error ? error.stack || error.message : String(error),
      );
      return null;
    }
  }
}
