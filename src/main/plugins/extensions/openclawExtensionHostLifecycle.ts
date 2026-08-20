import { BrowserWindow } from 'electron';

import {
  type AskUserRequest,
  CoworkInteractionIpc,
  CoworkInteractionKind,
  OpenClawToolName,
} from '../../../shared/openclaw/extensions';
import type { AskUserExtensionConfig } from '../../openclaw/config/openclawConfigSync';
import { parseManagedSessionKey } from '../../openclaw/sessions/openclawChannelSessionSync';
import { OpenClawExtensionHostController } from './openclawExtensionHostController';

type OpenClawExtensionHostLifecycleDeps = {
  askUserSessionByRequestId: Map<string, string>;
};

export type AskUserInteractionEnvelope = {
  sessionId: string;
  request: {
    requestId: string;
    toolName: typeof OpenClawToolName.ASK_USER_QUESTION;
    interactionKind: typeof CoworkInteractionKind.STRUCTURED_QUESTION;
    toolInput: {
      questions: AskUserRequest['questions'];
      waitPolicy: AskUserRequest['waitPolicy'];
      expiresAt?: number;
      sessionKey?: string;
      sessionId: string;
    };
  };
};

export class OpenClawExtensionHostLifecycle {
  private readonly deps: OpenClawExtensionHostLifecycleDeps;
  private controller: OpenClawExtensionHostController | null = null;

  constructor(deps: OpenClawExtensionHostLifecycleDeps) {
    this.deps = deps;
  }

  get currentController(): OpenClawExtensionHostController | null {
    return this.controller;
  }

  get config(): AskUserExtensionConfig | null {
    return this.controller?.config ?? null;
  }

  getController(): OpenClawExtensionHostController {
    if (!this.controller) {
      this.controller = new OpenClawExtensionHostController({
        onAskUser: request => {
          const interaction = this.toInteractionEnvelope(request);
          BrowserWindow.getAllWindows().forEach(win => {
            if (win.isDestroyed() || win.webContents.isDestroyed()) return;
            win.webContents.send(CoworkInteractionIpc.Stream, interaction);
          });
        },
        onAskUserDismiss: requestId => {
          this.deps.askUserSessionByRequestId.delete(requestId);
          BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
              win.webContents.send(CoworkInteractionIpc.Dismiss, { requestId });
            }
          });
        },
      });
    }
    return this.controller;
  }

  start(): Promise<AskUserExtensionConfig | null> {
    return this.getController().start();
  }

  listPendingInteractions(): AskUserInteractionEnvelope[] {
    return (
      this.controller
        ?.listPendingAskUserRequests()
        .map(request => this.toInteractionEnvelope(request)) ?? []
    );
  }

  async stop(): Promise<void> {
    try {
      await this.controller?.stop();
    } catch (error) {
      console.error(
        '[OpenClawExtensionHost] shutdown error:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private toInteractionEnvelope(request: AskUserRequest): AskUserInteractionEnvelope {
    const managedSession = parseManagedSessionKey(request.sessionKey);
    const sessionId = managedSession?.sessionId ?? '__askuser__';
    this.deps.askUserSessionByRequestId.set(request.requestId, sessionId);
    return {
      sessionId,
      request: {
        requestId: request.requestId,
        toolName: OpenClawToolName.ASK_USER_QUESTION,
        interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
        toolInput: {
          questions: request.questions,
          waitPolicy: request.waitPolicy,
          ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
          sessionKey: request.sessionKey,
          sessionId,
        },
      },
    };
  }
}
