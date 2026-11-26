import {
  BuiltinModelAuthDiagnosticEvent,
  type BuiltinModelAuthDiagnosticFields,
  getBuiltinModelAuthErrorCode,
  writeBuiltinModelAuthDiagnostic,
} from './builtinModelAuthDiagnostics';
import type { BuiltinModelCredential, BuiltinModelCredentialBinding } from './builtinModelCredential';

type Dependencies = {
  exchange: () => Promise<BuiltinModelCredential | null>;
  getActiveBinding: () => BuiltinModelCredentialBinding | null;
  publishCredential?: (binding: BuiltinModelCredentialBinding) => boolean | null;
  onBackgroundError?: (error: unknown) => void;
  onApplicationUnconfirmed?: () => void;
  needsCatalogRetry?: () => boolean;
  login: () => Promise<boolean>;
  rotate: () => Promise<boolean>;
  invalidate?: () => void;
  logout: () => Promise<void>;
};

type RefreshDecision = {
  generation: number;
  backgroundRevision?: number;
  refreshCatalog: boolean;
} & (BuiltinModelCredentialBinding | { credential: null; authSessionId: null });

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
  private explicitLogout: { generation: number; promise: Promise<void> } | null = null;
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
    const binding = this.dependencies.getActiveBinding();
    this.applied = credential === (binding?.credential ?? null) ? credential : undefined;
    this.appliedAuthSessionId = this.applied ? binding?.authSessionId ?? null : null;
  }

  async refresh(refreshCatalog = false): Promise<BuiltinModelCredential | null> {
    this.foregroundRefreshes += 1;
    try {
      const decision = await this.prepareRefresh(refreshCatalog, false);
      if (!decision) return null;
      await this.applyDecision(decision);
      if (!this.isCurrent(decision)) return null;
      const binding = this.dependencies.getActiveBinding();
      return binding && binding.authSessionId === this.appliedAuthSessionId &&
        binding.credential.accessToken === this.applied?.accessToken ? binding.credential : null;
    } finally {
      this.foregroundRefreshes -= 1;
      this.startBackgroundIfReady();
    }
  }

  /** Renewal deadlines must not wait for configuration or native reload acknowledgements. */
  async refreshInBackground(): Promise<BuiltinModelCredential | null> {
    const decision = await this.prepareRefresh(false, true);
    if (!decision) return this.dependencies.getActiveBinding()?.credential ?? null;
    this.enqueueBackground(decision);
    return this.isCurrent(decision) ? decision.credential : this.dependencies.getActiveBinding()?.credential ?? null;
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
      if (!this.dependencies.getActiveBinding()) {
        this.applied = undefined;
        this.appliedAuthSessionId = null;
        const cleanup: RefreshDecision = {
          generation, backgroundRevision, credential: null, authSessionId: null,
          refreshCatalog: false,
        };
        this.enqueueBackground(cleanup);
      }
      throw error;
    }
    if (!ownsExchange()) return null;
    const binding = this.dependencies.getActiveBinding();
    if (binding && binding.credential !== credential) return null;
    // Publication is synchronous and remains distinct from native application evidence.
    if (binding && this.dependencies.publishCredential?.(binding) !== null) {
      return { generation, backgroundRevision, ...binding, refreshCatalog };
    }
    // A token can reach the request cutoff while entering publication. Reconcile
    // only an inactive binding, never apply this result to a replacement login.
    if (binding && this.dependencies.getActiveBinding()) return null;
    return { generation, backgroundRevision, credential: null, authSessionId: null, refreshCatalog };
  }

  private isCurrent(decision: RefreshDecision): boolean {
    return decision.generation === this.generation &&
      (decision.backgroundRevision === undefined || decision.backgroundRevision === this.backgroundRevision) &&
      decision.authSessionId === (this.dependencies.getActiveBinding()?.authSessionId ?? null);
  }

  private async applyDecision(decision: RefreshDecision): Promise<void> {
    if (!this.isCurrent(decision)) {
      await this.withdrawExpiredDecision(decision);
      return;
    }
    const { credential, authSessionId } = decision;
    if (!credential && decision.generation === this.explicitLogout?.generation) return;
    const refreshCatalog = decision.refreshCatalog ||
      (credential !== null && this.dependencies.needsCatalogRetry?.() === true);
    if (!refreshCatalog && this.applied !== undefined &&
      credential?.accessToken === this.applied?.accessToken &&
      (!credential || authSessionId === this.appliedAuthSessionId)) return;
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
        const rotate = !refreshCatalog && authSessionId === this.appliedAuthSessionId;
        const confirmed = await (rotate ? this.dependencies.rotate() : this.dependencies.login());
        applicationCurrent = this.isCurrent(decision);
        if (applicationCurrent && confirmed === false) {
          this.dependencies.onApplicationUnconfirmed?.();
        } else if (applicationCurrent) {
          this.applied = credential;
          this.appliedAuthSessionId = authSessionId;
        }
      }
    } catch (error) {
      if (this.isCurrent(decision)) {
        writeBuiltinModelAuthDiagnostic('warn', BuiltinModelAuthDiagnosticEvent.ApplicationFailed, {
          ...decisionDiagnostics({ ...decision, refreshCatalog }),
          errorCode: getBuiltinModelAuthErrorCode(error),
        });
        throw error;
      }
    }
    await this.withdrawExpiredDecision(decision);
  }

  private async withdrawExpiredDecision(decision: RefreshDecision): Promise<void> {
    if (!decision.credential) return;
    // Withdraw the expired publication only while it still owns the decision.
    const cleanup: RefreshDecision = { ...decision, credential: null, authSessionId: null, refreshCatalog: false };
    if (!this.isCurrent(cleanup)) return;
    try {
      await this.applyDecision(cleanup);
    } catch (error) {
      if (decision.backgroundRevision === undefined) throw error;
      if (this.isCurrent(cleanup)) this.dependencies.onBackgroundError?.(error);
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

  logout(): Promise<void> {
    if (this.explicitLogout?.generation === this.generation) return this.explicitLogout.promise;
    const generation = ++this.generation;
    this.pendingBackground = null;
    this.applied = undefined;
    this.appliedAuthSessionId = null;
    const promise = this.applyExplicitLogout(generation).finally(() => {
      if (this.explicitLogout?.generation === generation) this.explicitLogout = null;
    });
    this.explicitLogout = { generation, promise };
    return promise;
  }

  private async applyExplicitLogout(generation: number): Promise<void> {
    try {
      this.dependencies.invalidate?.();
    } finally {
      // Still attempt config cleanup if local snapshot revocation fails.
      await this.dependencies.logout();
      if (generation === this.generation) this.applied = null;
    }
  }
}
