import { AppInitializationPhase } from '../../../shared/app/initialization';
import { StartupRoute } from '../../../shared/app/startup/routing';
import { EnginePhase, type OpenClawEngineStatus } from '../../../shared/openclaw/engineStatus';
import { t } from '../../core/i18n';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import type { AppInitialization } from './appInitialization';

type Generation = { process: number; lifecycle: number };
type Preparation = { identity?: Generation };

/** Owns ordinary startup admission; process Running alone cannot discharge it. */
export class StartupEnginePreparation {
  private active?: Preparation;
  private admitted?: Generation;
  private readonly pending = new Set<Promise<OpenClawEngineStatus>>();

  constructor(private readonly deps: {
    initialization: AppInitialization;
    manager: Pick<OpenClawEngineManager,
      'getStatus' | 'getGatewayProcessGeneration' | 'getGatewayLifecycleGeneration'>;
    isQuitting: () => boolean;
    prepare: () => Promise<OpenClawEngineStatus>;
  }) {}

  private identity(): Generation {
    return { process: this.deps.manager.getGatewayProcessGeneration(),
      lifecycle: this.deps.manager.getGatewayLifecycleGeneration() };
  }

  private matches(identity: Generation | undefined): boolean {
    const current = this.identity();
    return identity?.process === current.process && identity.lifecycle === current.lifecycle;
  }

  private usable(): boolean {
    return !this.deps.isQuitting() &&
      this.deps.initialization.getState().phase !== AppInitializationPhase.Failed;
  }

  isReady(): boolean {
    const state = this.deps.initialization.getState();
    return this.usable() && state.phase === AppInitializationPhase.Ready &&
      state.enginePreparationPending === false && !state.enginePreparationFailure &&
      this.deps.manager.getStatus().phase === EnginePhase.Running && this.matches(this.admitted);
  }

  observe(status: OpenClawEngineStatus): void {
    if (!this.usable()) return;
    if (status.phase !== EnginePhase.Running) {
      this.admitted = undefined;
      if (status.phase === EnginePhase.Error) {
        this.deps.initialization.failEnginePreparation(new Error(status.message || t('enginePreparationFailed')));
      } else {
        this.deps.initialization.setEnginePreparationPending(
          status.phase === EnginePhase.Starting || Boolean(this.active));
      }
      return;
    }
    if (this.active) {
      this.active.identity ??= this.identity();
      return;
    }
    if (!this.matches(this.admitted)) this.refresh();
  }

  private refresh(): void {
    // Verify an independently restarted process through the existing permission owner.
    void this.run(this.deps.prepare).catch(() => { /* Failure is published by this owner. */ });
  }

  run(operation: () => Promise<OpenClawEngineStatus>): Promise<OpenClawEngineStatus> {
    if (!this.usable()) return Promise.reject(new Error(t('enginePreparationFailed')));
    const task = this.prepare(operation);
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private async prepare(operation: () => Promise<OpenClawEngineStatus>): Promise<OpenClawEngineStatus> {
    if (this.deps.initialization.getState().route !== StartupRoute.Normal) return operation();
    if (this.matches(this.admitted) && !this.active &&
        this.deps.manager.getStatus().phase === EnginePhase.Running) {
      const admitted = this.admitted;
      try {
        const status = await operation();
        if (status.phase !== EnginePhase.Running ||
            this.deps.manager.getStatus().phase !== EnginePhase.Running ||
            !this.usable() || this.admitted !== admitted || this.active || !this.matches(admitted))
          throw new Error(status.message || t('enginePreparationFailed'));
        return status;
      } catch (error) {
        if (this.admitted === admitted && !this.active && this.usable()) {
          this.admitted = undefined;
          if (!this.matches(admitted) && this.deps.manager.getStatus().phase === EnginePhase.Running)
            this.refresh();
          else this.deps.initialization.failEnginePreparation(error);
        }
        throw error;
      }
    }
    const preparation: Preparation = this.deps.manager.getStatus().phase === EnginePhase.Running
      ? { identity: this.identity() } : {};
    this.active = preparation;
    this.admitted = undefined;
    this.deps.initialization.setEnginePreparationPending(true);
    try {
      const status = await operation();
      if (this.active !== preparation || !this.usable()) throw new Error(t('enginePreparationFailed'));
      const currentRunning = this.deps.manager.getStatus().phase === EnginePhase.Running;
      const running = status.phase === EnginePhase.Running && currentRunning;
      if (running && this.matches(preparation.identity)) {
        this.admitted = preparation.identity;
        this.deps.initialization.setEnginePreparationPending(false);
      } else if (currentRunning && preparation.identity && !this.matches(preparation.identity)) {
        // The old permission check belongs to a retired lifecycle, not its successor.
        this.active = undefined;
        this.refresh();
        throw new Error(t('enginePreparationFailed'));
      } else {
        if (status.phase === EnginePhase.Running) throw new Error(t('enginePreparationFailed'));
        this.deps.initialization.failEnginePreparation(new Error(status.message || t('enginePreparationFailed')));
      }
      return status;
    } catch (error) {
      if (this.active === preparation && this.usable()) {
        if (preparation.identity && !this.matches(preparation.identity) &&
            this.deps.manager.getStatus().phase === EnginePhase.Running) {
          this.active = undefined;
          this.refresh();
        } else {
          this.deps.initialization.failEnginePreparation(error);
        }
      }
      throw error;
    } finally {
      if (this.active === preparation) this.active = undefined;
    }
  }
}
