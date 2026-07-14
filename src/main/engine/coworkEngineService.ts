import type { CoworkStore } from '../data/coworkStore';
import type { OpenClawEngineManager } from '../openclaw/runtime/openclawEngineManager';
import { CoworkEngineRouter } from './coworkEngineRouter';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

type CoworkEngineServiceDeps = {
  getCoworkStore: () => CoworkStore;
  getOpenClawEngineManager: () => OpenClawEngineManager;
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
}
