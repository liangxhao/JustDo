import {
  type AuthActionResult,
  AuthErrorCode,
  AuthOperation,
  type AuthState,
  AuthStatus,
  AuthSyncStatus,
  INITIAL_AUTH_STATE,
} from '../../../../shared/app/auth';
import { type CredentialUpdate, type LoginSdkAdapter, LoginSdkStatus } from './loginSdkAdapter';
import { LoginStorageError, LoginUserInfoStore, type StoredLogin } from './loginUserInfoStore';

type Dependencies = {
  store: LoginUserInfoStore;
  adapter: LoginSdkAdapter;
  onLoginCommitted: () => Promise<void>;
  onLogoutCommitted: () => Promise<void>;
  onHeadersCommitted: () => void;
  onStateChanged: (state: AuthState) => void;
};

/** Main-only lease captured BEFORE an asynchronous SDK renewal starts. */
export type AuthCredentialLease = Readonly<{
  generation: number;
  identity: string;
  credentialVersion: string;
}>;

export class LoginService {
  private state: AuthState;
  private generation = 0;
  private identity: string | null = null;
  private credentialVersion: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private loginAttempt: { controller: AbortController; promise: Promise<AuthActionResult> } | null =
    null;
  private disposed = false;
  private readonly lifetime = new AbortController();

  constructor(private readonly dependencies: Dependencies) {
    this.state = { ...INITIAL_AUTH_STATE, sdkAvailable: dependencies.adapter.available };
  }

  getState(): AuthState {
    return this.state;
  }

  /** File import restores display state only; existing startup owns JWT/model recovery. */
  async restoreFromFile(): Promise<void> {
    const generation = ++this.generation;
    const login = this.dependencies.store.read();
    this.applyLogin(login, AuthStatus.LocalCredentials);
    if (!login || !this.dependencies.adapter.available || !this.dependencies.adapter.restoreSession)
      return;
    try {
      const confirmed = await this.dependencies.adapter.restoreSession({
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]),
        profile: login.profile,
      });
      if (
        !this.disposed &&
        generation === this.generation &&
        confirmed &&
        this.dependencies.store.read()?.identity === login.identity
      ) {
        this.setState({ status: AuthStatus.SignedIn });
      }
    } catch {
      // Local credentials can still drive native model recovery while SDK restoration is unavailable.
    }
  }

  login(): Promise<AuthActionResult> {
    if (this.disposed) return Promise.resolve(this.failure(AuthErrorCode.Unavailable));
    if (this.loginAttempt) return this.loginAttempt.promise;
    if (this.state.operation !== AuthOperation.Idle) {
      return Promise.resolve(this.failure(AuthErrorCode.Unavailable));
    }
    if (!this.dependencies.adapter.available) {
      return Promise.resolve(this.failure(AuthErrorCode.SdkUnavailable));
    }
    const generation = ++this.generation;
    const controller = new AbortController();
    this.setState({ operation: AuthOperation.Login, errorCode: null });
    const promise = this.runLogin(generation, controller).finally(() => {
      if (this.loginAttempt?.controller === controller) this.loginAttempt = null;
    });
    this.loginAttempt = { controller, promise };
    return promise;
  }

  logout(): Promise<AuthActionResult> {
    const generation = this.beginLogout();
    return this.enqueue(() => this.runLogout(generation));
  }

  private beginLogout(): number {
    const generation = ++this.generation;
    this.loginAttempt?.controller.abort();
    this.loginAttempt = null;
    return generation;
  }

  private async runLogout(generation: number): Promise<AuthActionResult> {
    if (this.disposed || generation !== this.generation)
      return this.failure(AuthErrorCode.SessionChanged);
    this.setState({ operation: AuthOperation.Logout, errorCode: null });
    try {
      this.dependencies.store.clear();
    } catch {
      this.setState({ operation: AuthOperation.Idle });
      return this.failure(AuthErrorCode.StorageFailed);
    }
    this.applyLogin(null, AuthStatus.SignedOut);
    const synced = await this.sync(false);
    let sdkCleared = true;
    try {
      await this.dependencies.adapter.logout?.({
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]),
      });
    } catch {
      sdkCleared = false;
    }
    this.setState({ operation: AuthOperation.Idle });
    if (!synced) return this.failure(AuthErrorCode.SyncFailed);
    return sdkCleared ? this.success() : this.failure(AuthErrorCode.LogoutFailed);
  }

  retrySync(): Promise<AuthActionResult> {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (this.disposed || generation !== this.generation || this.loginAttempt) {
        return this.failure(AuthErrorCode.SessionChanged);
      }
      const login = this.dependencies.store.read();
      if (this.state.status !== AuthStatus.SignedOut && login?.identity !== this.identity) {
        return this.failure(AuthErrorCode.SessionChanged);
      }
      this.setState({ operation: AuthOperation.Sync, errorCode: null });
      const synced = await this.sync(this.state.status !== AuthStatus.SignedOut && login !== null);
      this.setState({ operation: AuthOperation.Idle });
      return synced ? this.success() : this.failure(AuthErrorCode.SyncFailed);
    });
  }

  captureCredentialLease(): AuthCredentialLease | null {
    return !this.disposed && this.identity && this.credentialVersion
      ? {
          generation: this.generation,
          identity: this.identity,
          credentialVersion: this.credentialVersion,
        }
      : null;
  }

  /** SDK renewal seam. Cookie updates preserve mtoken; mtoken rotation re-enters model auth. */
  updateCredentials(
    lease: AuthCredentialLease,
    update: CredentialUpdate,
  ): Promise<AuthActionResult> {
    return this.enqueue(async () => {
      const current = this.dependencies.store.read();
      if (!this.matchesCredentialLease(lease, current)) {
        return this.failure(AuthErrorCode.SessionChanged);
      }
      let next: StoredLogin;
      try {
        next = this.dependencies.store.update(current, update);
      } catch {
        return this.failure(AuthErrorCode.StorageFailed);
      }
      this.identity = next.identity;
      this.credentialVersion = next.credentialVersion;
      if (next.identity !== current.identity) {
        this.setState({ operation: AuthOperation.Sync, errorCode: null });
        const synced = await this.sync(true);
        this.setState({ operation: AuthOperation.Idle });
        return synced ? this.success() : this.failure(AuthErrorCode.SyncFailed);
      }
      try {
        this.dependencies.onHeadersCommitted();
        return this.success();
      } catch {
        this.setState({ syncStatus: AuthSyncStatus.Failed });
        return this.failure(AuthErrorCode.SyncFailed);
      }
    });
  }

  /** A verified SDK expiry event may invalidate only the session that produced it. */
  expireSession(lease: AuthCredentialLease): Promise<AuthActionResult> {
    return this.enqueue(async () => {
      if (!this.matchesCredentialLease(lease, this.dependencies.store.read())) {
        return this.failure(AuthErrorCode.SessionChanged);
      }
      return this.runLogout(this.beginLogout());
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.loginAttempt?.controller.abort();
    this.lifetime.abort();
    try {
      this.dependencies.adapter.dispose?.();
    } catch {
      console.warn('[LoginService] SDK cleanup did not complete.');
    }
  }

  private async runLogin(
    generation: number,
    controller: AbortController,
  ): Promise<AuthActionResult> {
    try {
      const result = await this.dependencies.adapter.login({ signal: controller.signal });
      return await this.enqueue(async () => {
        if (this.disposed || generation !== this.generation || controller.signal.aborted) {
          return this.failure(AuthErrorCode.SessionChanged);
        }
        if (result.status === LoginSdkStatus.Canceled) {
          this.setState({ operation: AuthOperation.Idle });
          return { ...this.success(), canceled: true };
        }
        if (result.status !== LoginSdkStatus.Authenticated) {
          this.setState({ operation: AuthOperation.Idle });
          return this.failure(AuthErrorCode.LoginFailed);
        }
        this.dependencies.store.validateLogin(result.session);
        // A replacement identity must not inherit the previous model catalog or headers.
        if (this.identity) {
          this.dependencies.store.clear();
          this.applyLogin(null, AuthStatus.SignedOut);
          if (!(await this.sync(false))) {
            this.setState({ operation: AuthOperation.Idle });
            return this.failure(AuthErrorCode.SyncFailed);
          }
        }
        if (generation !== this.generation || controller.signal.aborted) {
          return this.failure(AuthErrorCode.SessionChanged);
        }
        const login = this.dependencies.store.writeLogin(result.session);
        this.applyLogin(login, AuthStatus.SignedIn);
        const synced = await this.sync(true);
        this.setState({ operation: AuthOperation.Idle });
        return synced ? this.success() : this.failure(AuthErrorCode.SyncFailed);
      });
    } catch (error) {
      if (this.disposed || generation !== this.generation || controller.signal.aborted) {
        return this.failure(AuthErrorCode.SessionChanged);
      }
      this.setState({ operation: AuthOperation.Idle });
      return this.failure(
        error instanceof LoginStorageError
          ? AuthErrorCode.StorageFailed
          : AuthErrorCode.LoginFailed,
      );
    }
  }

  private async sync(loggedIn: boolean): Promise<boolean> {
    this.setState({ syncStatus: AuthSyncStatus.Pending });
    try {
      await (loggedIn
        ? this.dependencies.onLoginCommitted()
        : this.dependencies.onLogoutCommitted());
      // Completed means the callback settled, NOT that a model or the runtime is ready.
      this.setState({ syncStatus: AuthSyncStatus.Completed, errorCode: null });
      return true;
    } catch {
      this.setState({ syncStatus: AuthSyncStatus.Failed, errorCode: AuthErrorCode.SyncFailed });
      return false;
    }
  }

  private applyLogin(login: StoredLogin | null, status: AuthState['status']): void {
    this.identity = login?.identity ?? null;
    this.credentialVersion = login?.credentialVersion ?? null;
    this.setState({
      status: login ? status : AuthStatus.SignedOut,
      profile: login?.profile ?? null,
    });
  }

  private matchesCredentialLease(
    lease: AuthCredentialLease,
    current: StoredLogin | null,
  ): current is StoredLogin {
    return (
      !this.disposed &&
      lease.generation === this.generation &&
      lease.identity === this.identity &&
      lease.credentialVersion === this.credentialVersion &&
      current?.identity === lease.identity &&
      current.credentialVersion === lease.credentialVersion
    );
  }

  private setState(patch: Partial<AuthState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.dependencies.onStateChanged(this.state);
  }

  private success(): AuthActionResult {
    return { success: true, state: this.state };
  }

  private failure(errorCode: AuthErrorCode): AuthActionResult {
    // Stale callbacks must not alter the newer account's visible state.
    if (errorCode !== AuthErrorCode.SessionChanged && !this.disposed) this.setState({ errorCode });
    return { success: false, errorCode, state: this.state };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch((): void => undefined);
    return result;
  }
}
