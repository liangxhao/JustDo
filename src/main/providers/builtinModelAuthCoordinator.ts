import type { BuiltinModelCredential } from './builtinModelCredential';

type Dependencies = {
  exchange: () => Promise<BuiltinModelCredential | null>;
  getActive: () => BuiltinModelCredential | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
};

/** Prevent obsolete asynchronous refreshes from overwriting a newer auth decision. */
export class BuiltinModelAuthCoordinator {
  private generation = 0;
  private applied: BuiltinModelCredential | null | undefined;

  constructor(private readonly dependencies: Dependencies) {}

  initialize(credential: BuiltinModelCredential | null): void {
    this.generation += 1;
    this.applied = credential;
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
        await this.dependencies.logout();
        if (generation === this.generation) this.applied = null;
      }
      throw error;
    }
    if (generation !== this.generation) return this.dependencies.getActive();
    if (!refreshCatalog && this.applied !== undefined && credential?.accessToken === this.applied?.accessToken) return credential;
    if (!credential) {
      this.applied = undefined;
      await this.dependencies.logout();
      if (generation === this.generation) this.applied = null;
    } else {
      this.applied = undefined;
      await this.dependencies.login();
      if (generation === this.generation) this.applied = credential;
    }
    return generation === this.generation ? credential : this.dependencies.getActive();
  }

  async logout(): Promise<void> {
    const generation = ++this.generation;
    this.applied = undefined;
    await this.dependencies.logout();
    if (generation === this.generation) this.applied = null;
  }
}
