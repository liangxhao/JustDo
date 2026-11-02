import { AppInitializationPhase } from '../../../shared/app/initialization';
import { StartupRoute } from '../../../shared/app/startup/routing';
import { EnginePhase, type OpenClawEngineStatus } from '../../../shared/openclaw/engineStatus';
import { t } from '../../core/i18n';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import type { AppInitialization } from './appInitialization';

type Generation = { process: number; lifecycle: number };
type Preparation = { identity?: Generation };
type PreparationAttempt = object;

/** Owns ordinary startup admission; process Running alone cannot discharge it. */
export class StartupEnginePreparation {
  private active?: Preparation;
  private admitted?: Generation;
  // Error attribution only; this token never grants or changes execution admission.
  private latestAttempt?: PreparationAttempt;
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

  private preparationFailure(
    attempt?: PreparationAttempt,
    identity?: Generation,
    returned?: OpenClawEngineStatus,
  ): Error {
    if (this.deps.isQuitting()) return new Error(t('enginePreparationShuttingDown'));
    if (this.deps.initialization.getState().phase === AppInitializationPhase.Failed)
      return new Error(t('enginePreparationInitializationUnavailable'));
    if (attempt && this.latestAttempt !== attempt)
      return new Error(t('enginePreparationSuperseded'));
    if (identity && !this.matches(identity))
      return new Error(t('enginePreparationLifecycleChanged'));

    const current = this.deps.manager.getStatus();
    // observe(Error) clears admitted, but a current attempt can still own this
    // generation's failure. A successor's error must never explain an old call.
    if (attempt && this.latestAttempt === attempt && identity && this.matches(identity) &&
        current.phase === EnginePhase.Error && current.message)
      return new Error(current.message);
    if (returned?.phase === EnginePhase.Error && returned.message)
      return new Error(returned.message);
    return new Error(t(current.phase === EnginePhase.Ready
      ? 'enginePreparationStopped'
      : current.phase === EnginePhase.Starting
        ? 'enginePreparationStillStarting'
        : 'enginePreparationUnconfirmed'));
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
    if (!this.usable()) return Promise.reject(this.preparationFailure());
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
    const attempt: PreparationAttempt = {};
    this.latestAttempt = attempt;
    if (this.matches(this.admitted) && !this.active &&
        this.deps.manager.getStatus().phase === EnginePhase.Running) {
      const admitted = this.admitted;
      try {
        const status = await operation();
        if (status.phase !== EnginePhase.Running ||
            this.deps.manager.getStatus().phase !== EnginePhase.Running ||
            !this.usable() || this.admitted !== admitted || this.active || !this.matches(admitted))
          throw this.preparationFailure(attempt, admitted, status);
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
    const publishFailure = (error: unknown): void => {
      // A replacement lifecycle's observed Error owns its diagnosis. A retired
      // call can explain its own result without replacing that current failure.
      if (preparation.identity && !this.matches(preparation.identity) &&
          this.deps.manager.getStatus().phase === EnginePhase.Error) return;
      this.deps.initialization.failEnginePreparation(error);
    };
    this.active = preparation;
    this.admitted = undefined;
    this.deps.initialization.setEnginePreparationPending(true);
    try {
      const status = await operation();
      if (this.active !== preparation || !this.usable())
        throw this.preparationFailure(attempt, preparation.identity, status);
      const currentRunning = this.deps.manager.getStatus().phase === EnginePhase.Running;
      const running = status.phase === EnginePhase.Running && currentRunning;
      if (running && this.matches(preparation.identity)) {
        this.admitted = preparation.identity;
        this.deps.initialization.setEnginePreparationPending(false);
      } else if (currentRunning && preparation.identity && !this.matches(preparation.identity)) {
        // The old permission check belongs to a retired lifecycle, not its successor.
        const failure = this.preparationFailure(attempt, preparation.identity, status);
        this.active = undefined;
        this.refresh();
        throw failure;
      } else {
        const failure = this.preparationFailure(attempt, preparation.identity, status);
        if (status.phase === EnginePhase.Running) throw failure;
        publishFailure(failure);
      }
      return status;
    } catch (error) {
      if (this.active === preparation && this.usable()) {
        if (preparation.identity && !this.matches(preparation.identity) &&
            this.deps.manager.getStatus().phase === EnginePhase.Running) {
          this.active = undefined;
          this.refresh();
        } else {
          publishFailure(error);
        }
      }
      throw error;
    } finally {
      if (this.active === preparation) this.active = undefined;
    }
  }
}
