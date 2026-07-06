import crypto from 'crypto';

import type { AskUserRequest, AskUserResponse } from '../../../../shared/openclawExtensions';
import type { McpServerRecord } from '../../mcp/mcpStore';
import { McpServerManager } from '../../mcp/mcpServerManager';
import type { McpBridgeConfig } from '../config/openclawConfigSync';
import {
  type ExtensionInteractionResponse,
  type ExtensionInteractionResult,
  ExtensionInteractionRouter,
} from './extensionInteractionRouter';
import { OpenClawExtensionCallbackServer } from './openclawExtensionCallbackServer';

type OpenClawExtensionHostControllerDeps = {
  getEnabledMcpServers: () => McpServerRecord[];
  onAskUser: (request: AskUserRequest) => void;
  onAskUserDismiss: (requestId: string) => void;
};

export class OpenClawExtensionHostController {
  private readonly deps: OpenClawExtensionHostControllerDeps;
  private readonly mcpManager = new McpServerManager();
  private bridgeServer: OpenClawExtensionCallbackServer | null = null;
  private secret: string | null = null;
  private startPromise: Promise<McpBridgeConfig | null> | null = null;
  private readonly interactionRouter = new ExtensionInteractionRouter();

  constructor(deps: OpenClawExtensionHostControllerDeps) {
    this.deps = deps;
    this.interactionRouter.register((requestId, result) => {
      const answers =
        result.behavior === 'allow' && result.updatedInput
          ? (result.updatedInput.answers as Record<string, string> | undefined)
          : undefined;
      const handled = this.resolveAskUser(requestId, {
        behavior: result.behavior,
        answers,
      });
      return { handled, answers };
    });
  }

  get config(): McpBridgeConfig | null {
    const callbackUrl = this.bridgeServer?.callbackUrl;
    const askUserCallbackUrl = this.bridgeServer?.askUserCallbackUrl;
    if (!callbackUrl || !askUserCallbackUrl || !this.secret) return null;

    return {
      callbackUrl,
      askUserCallbackUrl,
      secret: this.secret,
      tools: this.mcpManager.toolManifest,
    };
  }

  start(): Promise<McpBridgeConfig | null> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async restartMcpServers(): Promise<McpBridgeConfig | null> {
    await this.mcpManager.stopServers();
    return this.start();
  }

  resolveAskUser(requestId: string, response: AskUserResponse): boolean {
    return this.bridgeServer?.resolveAskUser(requestId, response) ?? false;
  }

  respondToInteraction(
    requestId: string,
    result: ExtensionInteractionResult,
  ): ExtensionInteractionResponse {
    return this.interactionRouter.respond(requestId, result);
  }

  async stop(): Promise<void> {
    // A shutdown may race with the initial bridge startup. Wait for startup to
    // settle first so it cannot create resources after cleanup has completed.
    await this.startPromise;
    await this.mcpManager.stopServers();
    await this.bridgeServer?.stop();
  }

  private async startInternal(): Promise<McpBridgeConfig | null> {
    try {
      this.secret ??= crypto.randomUUID();
      const enabledServers = this.deps.getEnabledMcpServers();
      if (enabledServers.length > 0) {
        await this.mcpManager.startServers(enabledServers);
      }

      if (!this.bridgeServer) {
        this.bridgeServer = new OpenClawExtensionCallbackServer(this.mcpManager, this.secret);
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
