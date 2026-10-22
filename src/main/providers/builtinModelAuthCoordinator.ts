import type { BuiltinModelCredential } from './builtinModelCredential';

type Dependencies = {
  exchange: () => Promise<BuiltinModelCredential | null>;
  getActive: () => BuiltinModelCredential | null;
  getAuthSessionId: () => string | null;
  login: () => Promise<void>;
  rotate: () => Promise<void>;
  invalidate?: () => void;
  logout: () => Promise<void>;
};

/** Prevent obsolete asynchronous refreshes from overwriting a newer auth decision. */
export class BuiltinModelAuthCoordinator {
  private generation = 0;
  private applied: BuiltinModelCredential | null | undefined;
  private appliedAuthSessionId: string | null = null;

  constructor(private readonly dependencies: Dependencies) {}

  initialize(credential: BuiltinModelCredential | null): void {
    this.generation += 1;
    this.applied = credential;
    this.appliedAuthSessionId = credential ? this.dependencies.getAuthSessionId() : null;
  }

  async refresh(refreshCatalog = false): Promise<BuiltinModelCredential | null> {
    const generation = ++this.generation;
    let credential: BuiltinModelCredential | null;
    try {
      credential = await this.dependencies.exchange();
    } catch (error) {
      if (generation !== this.generation) return this.dependencies.getActive();
      if (!this.dependencies.getActive()) {
        this.applied = undefined;
        this.appliedAuthSessionId = null;
        await this.dependencies.logout();
        if (generation === this.generation) this.applied = null;
      }
      throw error;
    }
    if (generation !== this.generation) return this.dependencies.getActive();
    const authSessionId = this.dependencies.getAuthSessionId();
    if (!refreshCatalog && this.applied !== undefined &&
      credential?.accessToken === this.applied?.accessToken &&
      (!credential || (authSessionId !== null && authSessionId === this.appliedAuthSessionId))) return credential;
    if (!credential) {
      this.applied = undefined;
      this.appliedAuthSessionId = null;
      await this.dependencies.logout();
      if (generation === this.generation) this.applied = null;
    } else {
      this.applied = undefined;
      // Keep the confirmed session across a failed rotation, so retrying the
      // same login does not put model discovery back in front of its credential.
      const rotate = !refreshCatalog && authSessionId !== null && authSessionId === this.appliedAuthSessionId;
      await (rotate ? this.dependencies.rotate() : this.dependencies.login());
      if (generation === this.generation && authSessionId !== null &&
        authSessionId === this.dependencies.getAuthSessionId()) {
        this.applied = credential;
        this.appliedAuthSessionId = authSessionId;
      }
    }
    return generation === this.generation && authSessionId === this.dependencies.getAuthSessionId()
      ? credential : this.dependencies.getActive();
  }

  async logout(): Promise<void> {
    const generation = ++this.generation;
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
