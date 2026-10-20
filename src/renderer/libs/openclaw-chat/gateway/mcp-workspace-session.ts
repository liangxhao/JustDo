import type { McpAppDiscovery, McpAppWorkspaceScope } from '@shared/plugins/mcpApps';

import type { McpAppViewContext } from '../components/mcp-app/view';
import type { GatewayClient } from './client';
import { McpAppSession, type McpAppSessionBinding } from './mcp-app-session';

interface ConnectionWait {
  resolve: (client: GatewayClient) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface McpWorkspaceCatalog {
  value: McpAppDiscovery;
  isCurrent: () => boolean;
}

/** One lazy native connection for homepage file Apps; never sends chat or reads history. */
export class McpWorkspaceSession {
  readonly apps = new McpAppSession(() => this.binding);
  private binding?: McpAppSessionBinding;
  private client?: GatewayClient;
  private connection?: Promise<GatewayClient>;
  private connectionWait?: ConnectionWait;
  private authenticatedGeneration?: number;
  private readonly connectionListeners = new Set<() => void>();
  private bindingPreparation?: Promise<{ isCurrent: () => boolean }>;
  private preparing?: Promise<McpAppViewContext>;
  private disposed = false;
  private adoptedSessionId?: string;

  adopt(sessionId: string): void {
    // Main has already adopted the native session. A concurrent disconnect only
    // invalidates transport; the next preparation must use its canonical owner.
    if (!this.current()) throw new Error('App workspace is unavailable');
    this.adoptedSessionId = sessionId;
  }

  constructor(
    private readonly scope: McpAppWorkspaceScope,
    private readonly host: {
      isCurrent: () => boolean;
      canInteract?: () => boolean;
      addDraft: (text: string) => Promise<boolean>;
      openFile: (file: { path: string; name: string }) => Promise<boolean>;
    },
  ) {}

  private current = () => !this.disposed && this.host.isCurrent();

  get connected(): boolean {
    return Boolean(
      this.current() &&
      this.client?.connected &&
      this.authenticatedGeneration === this.client.generation,
    );
  }

  subscribeConnection(listener: () => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  private notifyConnection(): void {
    for (const listener of this.connectionListeners) listener();
  }

  private settleConnection(error?: Error): void {
    const pending = this.connectionWait;
    if (!pending) return;
    this.connectionWait = undefined;
    this.connection = undefined;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else if (this.connected && this.client) pending.resolve(this.client);
    else pending.reject(new Error('Workspace Gateway is unavailable'));
  }

  private retireClient(): void {
    const client = this.client;
    this.client = undefined;
    this.authenticatedGeneration = undefined;
    this.binding = undefined;
    this.apps.invalidate();
    client?.stop();
    this.notifyConnection();
  }

  private connect(): Promise<GatewayClient> {
    if (!this.current()) return Promise.reject(new Error('App workspace changed'));
    if (this.connected && this.client) return Promise.resolve(this.client);
    if (this.connection) return this.connection;
    let pending!: ConnectionWait;
    this.connection = new Promise<GatewayClient>((resolve, reject) => {
      pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.connectionWait !== pending) return;
          this.settleConnection(new Error('Workspace Gateway connection timed out'));
          this.retireClient();
        }, 15_000),
      };
      this.connectionWait = pending;
    });
    // A started client owns its automatic reconnect. Waiting for its next
    // authenticated hello must not start a second socket or reuse an old hello.
    if (this.client) return this.connection;
    void (async () => {
      const engine = window.electron.openclaw.engine;
      const [port, token] = await Promise.all([engine.getPort(), engine.getToken()]);
      if (this.connectionWait !== pending) return;
      if (!this.current() || !port.success || !port.port || !token.success || !token.token)
        throw new Error('Workspace Gateway is unavailable');
      const { GatewayClient } = await import('./client');
      if (this.connectionWait !== pending) return;
      if (!this.current()) throw new Error('App workspace changed');
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port.port}`,
        token: token.token,
        onHello: () => {
          if (this.client !== client) return;
          if (!this.current()) {
            this.settleConnection(new Error('App workspace changed'));
            this.retireClient();
            return;
          }
          this.authenticatedGeneration = client.generation;
          this.settleConnection();
          this.notifyConnection();
        },
        onClose: () => {
          if (this.client !== client) return;
          this.authenticatedGeneration = undefined;
          this.binding = undefined;
          this.apps.invalidate();
          this.notifyConnection();
        },
      });
      this.client = client;
      client.start();
    })().catch(error => {
      if (this.connectionWait !== pending) return;
      this.settleConnection(error instanceof Error ? error : new Error(String(error)));
      this.retireClient();
    });
    return this.connection;
  }

  prepare = (): Promise<McpAppViewContext> => {
    if (!this.current() || this.host.canInteract?.() === false)
      return Promise.reject(new Error('App workspace is not interactive'));
    if (this.preparing) return this.preparing;
    const task = this.prepareCurrent().finally(() => {
      if (this.preparing === task) this.preparing = undefined;
    });
    this.preparing = task;
    return task;
  };

  /** Read the owned workspace catalog without granting App interaction. */
  async discover(signal?: AbortSignal): Promise<McpWorkspaceCatalog> {
    const binding = await this.prepareBinding();
    let revision = this.apps.discoveryRevision;
    let reread = false;
    for (;;) {
      try {
        signal?.throwIfAborted();
        const value = await this.apps.discover(signal);
        if (!binding.isCurrent() || signal?.aborted) throw new Error('App workspace changed');
        return { value, isCurrent: binding.isCurrent };
      } catch (error) {
        // Navigation revokes presentation operations, including an in-flight
        // directory read. Only reread after that change on the same native owner.
        if (
          reread ||
          signal?.aborted ||
          !binding.isCurrent() ||
          revision === this.apps.discoveryRevision
        )
          throw error;
        reread = true;
        revision = this.apps.discoveryRevision;
      }
    }
  }

  private prepareBinding = (): Promise<{ isCurrent: () => boolean }> => {
    if (this.bindingPreparation) return this.bindingPreparation;
    const task = this.prepareNativeBinding().finally(() => {
      if (this.bindingPreparation === task) this.bindingPreparation = undefined;
    });
    this.bindingPreparation = task;
    return task;
  };

  private async prepareNativeBinding(): Promise<{ isCurrent: () => boolean }> {
    if (!this.current()) throw new Error('App workspace changed');
    const client = await this.connect();
    const generation = client.generation;
    // Establish connectivity before any native creation. An unavailable runtime
    // can then fall back to ordinary previews without an uncertain preparation.
    if (!this.connected) throw new Error('Workspace Gateway is unavailable');
    const prepared = this.adoptedSessionId
      ? await window.electron.mcpApps.prepare(this.adoptedSessionId)
      : await window.electron.mcpApps.prepareWorkspace(this.scope);
    if (!this.connected || !prepared.success || client.generation !== generation)
      throw new Error('App workspace is unavailable');
    const native = prepared.value;
    const { session } = await client.request<{ session?: { sessionId?: string } }>(
      'sessions.describe',
      { key: native.sessionKey, agentId: this.scope.agentId },
    );
    if (
      !this.connected ||
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
        agentId: this.scope.agentId,
        isCurrent: () =>
          this.current() &&
          this.binding === binding &&
          this.connected &&
          client.generation === generation,
      };
      this.binding = binding;
      this.apps.refreshBinding();
    }
    const binding = this.binding;
    return { isCurrent: () => this.binding === binding && binding.isCurrent() };
  }

  private async prepareCurrent(): Promise<McpAppViewContext> {
    const prepared = await this.prepareBinding();
    if (!prepared.isCurrent() || !this.binding) throw new Error('App workspace changed');
    const native = this.binding;
    const resume = (): McpAppViewContext | undefined => {
      if (
        !this.current() ||
        this.host.canInteract?.() === false ||
        !this.apps.ready ||
        this.binding?.sessionId !== native.sessionId ||
        this.binding.sessionKey !== native.sessionKey
      )
        return;
      const binding = this.apps.bind();
      return {
        apps: this.apps,
        sessionKey: native.sessionKey,
        isCurrent: () =>
          this.current() && binding.isCurrent() && this.host.canInteract?.() !== false,
        canDraft: () =>
          this.current() && binding.isCurrent() && this.host.canInteract?.() !== false,
        addDraft: text =>
          this.current() && this.host.canInteract?.() !== false
            ? this.host.addDraft(text)
            : Promise.resolve(false),
        openFile: file =>
          this.current() && this.host.canInteract?.() !== false
            ? this.host.openFile(file)
            : Promise.resolve(false),
        refresh: this.prepare,
        resume,
      };
    };
    const context = resume();
    if (!context) throw new Error('App workspace changed');
    return context;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settleConnection(new Error('App workspace changed'));
    this.retireClient();
    this.connectionListeners.clear();
    void window.electron.mcpApps.releaseWorkspace(this.scope.requestId).catch(() => undefined);
  }
}
