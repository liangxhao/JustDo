import {
  BuiltinModelAuthDiagnosticEvent,
  type BuiltinModelAuthDiagnosticFields,
  getBuiltinModelAuthErrorCode,
  writeBuiltinModelAuthDiagnostic,
} from './builtinModelAuthDiagnostics';
import type { BuiltinModelCredential } from './builtinModelCredential';

type Dependencies = {
  exchange: () => Promise<BuiltinModelCredential | null>;
  getActive: () => BuiltinModelCredential | null;
  getAuthSessionId: () => string | null;
  publishCredential?: (credential: BuiltinModelCredential, authSessionId: string) => void;
  onBackgroundError?: (error: unknown) => void;
  login: () => Promise<void>;
  rotate: () => Promise<void>;
  invalidate?: () => void;
  logout: () => Promise<void>;
};

type RefreshDecision = {
  generation: number;
  backgroundRevision?: number;
  credential: BuiltinModelCredential | null;
  authSessionId: string | null;
  refreshCatalog: boolean;
};

const decisionDiagnostics = (decision: RefreshDecision): BuiltinModelAuthDiagnosticFields => ({
  generation: decision.generation,
  backgroundRevision: decision.backgroundRevision,
  background: decision.backgroundRevision !== undefined,
  refreshCatalog: decision.refreshCatalog,
  credentialPresent: decision.credential !== null,
});

/** Prevent obsolete asynchronous refreshes from overwriting a newer auth decision. */
export class BuiltinModelAuthCoordinator {
  private generation = 0;
  private applied: BuiltinModelCredential | null | undefined;
  private appliedAuthSessionId: string | null = null;
  private pendingBackground: RefreshDecision | null = null;
  private applyingBackground = false;
  private backgroundRevision = 0;
  private foregroundRefreshes = 0;

  constructor(private readonly dependencies: Dependencies) {}

  initialize(credential: BuiltinModelCredential | null): void {
    this.generation += 1;
    this.pendingBackground = null;
    this.applied = credential;
    this.appliedAuthSessionId = credential ? this.dependencies.getAuthSessionId() : null;
  }

  async refresh(refreshCatalog = false): Promise<BuiltinModelCredential | null> {
    this.foregroundRefreshes += 1;
    try {
      const decision = await this.prepareRefresh(refreshCatalog, false);
      if (!decision) return this.dependencies.getActive();
      await this.applyDecision(decision);
      return this.isCurrent(decision) ? decision.credential : this.dependencies.getActive();
    } finally {
      this.foregroundRefreshes -= 1;
      this.startBackgroundIfReady();
    }
  }

  /** Renewal deadlines must not wait for configuration or native reload acknowledgements. */
  async refreshInBackground(): Promise<BuiltinModelCredential | null> {
    const decision = await this.prepareRefresh(false, true);
    if (!decision) return this.dependencies.getActive();
    this.enqueueBackground(decision);
    return this.isCurrent(decision) ? decision.credential : this.dependencies.getActive();
  }

  private async prepareRefresh(
    refreshCatalog: boolean,
    background: boolean,
  ): Promise<RefreshDecision | null> {
    // Same-session renewals must not cancel an explicit catalog/login operation.
    const generation = background ? this.generation : ++this.generation;
    const backgroundRevision = background ? ++this.backgroundRevision : undefined;
    const ownsExchange = (): boolean => generation === this.generation &&
      (backgroundRevision === undefined || backgroundRevision === this.backgroundRevision);
    let credential: BuiltinModelCredential | null;
    try {
      credential = await this.dependencies.exchange();
    } catch (error) {
      if (!ownsExchange()) return null;
      if (!this.dependencies.getActive()) {
        this.applied = undefined;
        this.appliedAuthSessionId = null;
        const cleanup: RefreshDecision = {
          generation, backgroundRevision, credential: null, authSessionId: this.dependencies.getAuthSessionId(),
          refreshCatalog: false,
        };
        if (background) this.enqueueBackground(cleanup);
        else await this.applyDecision(cleanup);
      }
      throw error;
    }
    if (!ownsExchange()) return null;
    const authSessionId = this.dependencies.getAuthSessionId();
    const decision = { generation, backgroundRevision, credential, authSessionId, refreshCatalog };
    if (!this.isCurrent(decision)) return null;
    // Publication is synchronous and remains distinct from native application evidence.
    if (credential && authSessionId !== null) {
      this.dependencies.publishCredential?.(credential, authSessionId);
    }
    return decision;
  }

  private isCurrent(decision: RefreshDecision): boolean {
    return decision.generation === this.generation &&
      (decision.backgroundRevision === undefined || decision.backgroundRevision === this.backgroundRevision) &&
      decision.authSessionId === this.dependencies.getAuthSessionId();
  }

  private async applyDecision(decision: RefreshDecision): Promise<void> {
    if (!this.isCurrent(decision)) return;
    const { credential, authSessionId, refreshCatalog } = decision;
    if (!refreshCatalog && this.applied !== undefined &&
      credential?.accessToken === this.applied?.accessToken &&
      (!credential || (authSessionId !== null && authSessionId === this.appliedAuthSessionId))) return;
    try {
      let applicationCurrent: boolean;
      if (!credential) {
        this.applied = undefined;
        this.appliedAuthSessionId = null;
        await this.dependencies.logout();
        applicationCurrent = this.isCurrent(decision);
        if (applicationCurrent) this.applied = null;
      } else {
        this.applied = undefined;
        // Keep the confirmed session across a failed rotation, so retrying the
        // same login does not put model discovery back in front of its credential.
        const rotate = !refreshCatalog && authSessionId !== null && authSessionId === this.appliedAuthSessionId;
        await (rotate ? this.dependencies.rotate() : this.dependencies.login());
        applicationCurrent = this.isCurrent(decision);
        if (applicationCurrent && authSessionId !== null) {
          this.applied = credential;
          this.appliedAuthSessionId = authSessionId;
        }
      }
    } catch (error) {
      writeBuiltinModelAuthDiagnostic('warn', BuiltinModelAuthDiagnosticEvent.ApplicationFailed, {
        ...decisionDiagnostics(decision),
        errorCode: getBuiltinModelAuthErrorCode(error),
      });
      throw error;
    }
  }

  private enqueueBackground(decision: RefreshDecision): void {
    // At most one application waits behind the current ACK, always with the latest token.
    this.pendingBackground = decision;
    this.startBackgroundIfReady();
  }

  private startBackgroundIfReady(): void {
    if (this.pendingBackground && !this.applyingBackground && this.foregroundRefreshes === 0) {
      void this.applyBackground();
    }
  }

  private async applyBackground(): Promise<void> {
    this.applyingBackground = true;
    try {
      while (this.pendingBackground && this.foregroundRefreshes === 0) {
        const decision = this.pendingBackground;
        this.pendingBackground = null;
        try {
          await this.applyDecision(decision);
        } catch (error) {
          if (this.isCurrent(decision)) this.dependencies.onBackgroundError?.(error);
        }
      }
    } finally {
      this.applyingBackground = false;
    }
  }

  async logout(): Promise<void> {
    const generation = ++this.generation;
    this.pendingBackground = null;
    this.applied = undefined;
    this.appliedAuthSessionId = null;
    try {
      this.dependencies.invalidate?.();
    } finally {
      // Snapshot revocation can fail on Windows. Still enter the existing config
      // cleanup, whose failure stops Gateway instead of retaining usable secrets.
      await this.dependencies.logout();
      if (generation === this.generation) this.applied = null;
    }
  }
}
