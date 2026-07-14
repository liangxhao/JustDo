import { BrowserWindow } from 'electron';

import { CoworkInteractionKind, OpenClawToolName } from '../../../shared/openclaw/extensions';
import type { AskUserExtensionConfig } from '../../openclaw/config/openclawConfigSync';
import { parseManagedSessionKey } from '../../openclaw/sessions/openclawChannelSessionSync';
import { OpenClawExtensionHostController } from './openclawExtensionHostController';

type OpenClawExtensionHostLifecycleDeps = {
  askUserSessionByRequestId: Map<string, string>;
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
          const managedSession = parseManagedSessionKey(request.sessionKey);
          const requestSessionId = managedSession?.sessionId ?? '__askuser__';
          this.deps.askUserSessionByRequestId.set(request.requestId, requestSessionId);
          BrowserWindow.getAllWindows().forEach(win => {
            if (win.isDestroyed()) return;
            win.webContents.send('cowork:stream:interaction', {
              sessionId: requestSessionId,
              request: {
                requestId: request.requestId,
                toolName: OpenClawToolName.ASK_USER_QUESTION,
                interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
                toolInput: {
                  questions: request.questions,
                  sessionKey: request.sessionKey,
                  sessionId: requestSessionId,
                },
              },
            });
          });
        },
        onAskUserDismiss: requestId => {
          this.deps.askUserSessionByRequestId.delete(requestId);
          BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
              win.webContents.send('cowork:stream:interactionDismiss', { requestId });
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
}
