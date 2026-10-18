import type { McpAppWorkspaceScope } from '@shared/plugins/mcpApps';

import type { McpAppViewContext } from '../components/mcp-app/view';
import type { GatewayClient } from './client';
import { McpAppSession, type McpAppSessionBinding } from './mcp-app-session';

/** One lazy native connection for homepage file Apps; never sends chat or reads history. */
export class McpWorkspaceSession {
  readonly apps = new McpAppSession(() => this.binding);
  private binding?: McpAppSessionBinding;
  private client?: GatewayClient;
  private connection?: Promise<GatewayClient>;
  private preparing?: Promise<McpAppViewContext>;
  private disposed = false;

  constructor(
    private readonly scope: McpAppWorkspaceScope,
    private readonly host: {
      isCurrent: () => boolean;
      addDraft: (text: string) => Promise<boolean>;
      openFile: (file: { path: string; name: string }) => Promise<boolean>;
    },
  ) {}

  private current = () => !this.disposed && this.host.isCurrent();

  private connect(): Promise<GatewayClient> {
    if (this.connection) return this.connection;
    this.connection = (async () => {
      const engine = window.electron.openclaw.engine;
      const [port, token] = await Promise.all([engine.getPort(), engine.getToken()]);
      if (!this.current() || !port.success || !port.port || !token.success || !token.token)
        throw new Error('Workspace Gateway is unavailable');
      const { GatewayClient } = await import('./client');
      if (!this.current()) throw new Error('App workspace changed');
      return new Promise<GatewayClient>((resolve, reject) => {
        let initialized = false;
        const timer = setTimeout(() => {
          client.stop();
          reject(new Error('Workspace Gateway connection timed out'));
        }, 15_000);
        const client = new GatewayClient({
          url: `ws://127.0.0.1:${port.port}`,
          token: token.token,
          onHello: () => {
            clearTimeout(timer);
            initialized = true;
            if (this.current()) resolve(client);
            else {
              client.stop();
              reject(new Error('App workspace changed'));
            }
          },
          onClose: () => {
            clearTimeout(timer);
            this.binding = undefined;
            this.apps.invalidate();
            if (!initialized) client.stop();
            reject(new Error('Workspace Gateway disconnected'));
          },
        });
        this.client = client;
        client.start();
      });
    })().catch(error => {
      this.connection = undefined;
      throw error;
    });
    return this.connection;
  }

  prepare = (): Promise<McpAppViewContext> => {
    if (this.preparing) return this.preparing;
    const task = this.prepareCurrent().finally(() => {
      if (this.preparing === task) this.preparing = undefined;
    });
    this.preparing = task;
    return task;
  };

  private async prepareCurrent(): Promise<McpAppViewContext> {
    if (!this.current()) throw new Error('App workspace changed');
    const client = await this.connect();
    const generation = client.generation;
    // Establish connectivity before any native creation. An unavailable runtime
    // can then fall back to ordinary previews without an uncertain preparation.
    if (!this.current() || !client.connected) throw new Error('Workspace Gateway is unavailable');
    const prepared = await window.electron.mcpApps.prepareWorkspace(this.scope);
    if (!this.current() || !prepared.success || client.generation !== generation)
      throw new Error('App workspace is unavailable');
    const native = prepared.value;
    const { session } = await client.request<{ session?: { sessionId?: string } }>(
      'sessions.describe',
      { key: native.sessionKey, agentId: native.agentId },
    );
    if (
      !this.current() ||
      !client.connected ||
      client.generation !== generation ||
      session?.sessionId !== native.gatewaySessionId
    )
      throw new Error('Native App workspace changed');
    if (
      this.binding?.client !== client ||
      this.binding.generation !== generation ||
      this.binding.sessionId !== native.gatewaySessionId ||
      this.binding.sessionKey !== native.sessionKey
    ) {
      this.apps.invalidate();
      const binding: McpAppSessionBinding = {
        client,
        generation,
        sessionKey: native.sessionKey,
        sessionId: native.gatewaySessionId,
        agentId: native.agentId,
        isCurrent: () =>
          this.current() &&
          this.binding === binding &&
          client.connected &&
          client.generation === generation,
      };
      this.binding = binding;
      this.apps.refreshBinding();
    }
    const binding = this.apps.bind();
    return {
      apps: this.apps,
      sessionKey: native.sessionKey,
      isCurrent: () => this.current() && binding.isCurrent(),
      canDraft: () => this.current() && binding.isCurrent(),
      addDraft: text => (this.current() ? this.host.addDraft(text) : Promise.resolve(false)),
      openFile: file => (this.current() ? this.host.openFile(file) : Promise.resolve(false)),
      refresh: this.prepare,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.apps.invalidate();
    this.binding = undefined;
    this.client?.stop();
    void window.electron.mcpApps.releaseWorkspace(this.scope.requestId).catch(() => undefined);
  }
}
