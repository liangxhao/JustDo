import type { SessionTitleFetch } from '../../cowork/sessionTitleGenerator';
import type { CoworkStore } from '../../data/coworkStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { OpenClawRuntimeAdapter } from '../openclaw/openclawRuntimeAdapter';
import { CoworkEngineRouter } from './coworkEngineRouter';

type CoworkEngineServiceDeps = {
  getCoworkStore: () => CoworkStore;
  getOpenClawEngineManager: () => OpenClawEngineManager;
  fetchSessionTitle?: SessionTitleFetch;
};

export class CoworkEngineService {
  private readonly deps: CoworkEngineServiceDeps;
  private runtimeAdapter: OpenClawRuntimeAdapter | null = null;
  private router: CoworkEngineRouter | null = null;

  constructor(deps: CoworkEngineServiceDeps) {
    this.deps = deps;
  }

  getRuntimeAdapter(): OpenClawRuntimeAdapter | null {
    return this.runtimeAdapter;
  }

  getCurrentRouter(): CoworkEngineRouter | null {
    return this.router;
  }

  getRouter(): CoworkEngineRouter {
    if (!this.router) {
      if (!this.runtimeAdapter) {
        this.runtimeAdapter = new OpenClawRuntimeAdapter(
          this.deps.getCoworkStore(),
          this.deps.getOpenClawEngineManager(),
          this.deps.fetchSessionTitle,
        );
      }
      this.router = new CoworkEngineRouter({
        openclawRuntime: this.runtimeAdapter,
      });
    }
    return this.router;
  }

  hasActiveSessions(): boolean {
    return this.runtimeAdapter?.hasActiveSessions() ?? false;
  }

  disconnectGatewayClient(): void {
    this.runtimeAdapter?.disconnectGatewayClient();
  }

  async connectGatewayClient(): Promise<void> {
    this.getRouter();
    if (!this.runtimeAdapter) {
      throw new Error('OpenClaw runtime adapter is unavailable.');
    }
    await this.runtimeAdapter.connectGatewayIfNeeded();
  }

  async reconnectGatewayClient(): Promise<void> {
    this.getRouter();
    if (!this.runtimeAdapter) {
      throw new Error('OpenClaw runtime adapter is unavailable.');
    }
    await this.runtimeAdapter.reconnectGateway();
  }

  async requestGateway<T>(method: string, params?: unknown): Promise<T> {
    this.getRouter();
    if (!this.runtimeAdapter) {
      throw new Error('OpenClaw runtime adapter is unavailable.');
    }
    return this.runtimeAdapter.requestGateway<T>(method, params);
  }
}
