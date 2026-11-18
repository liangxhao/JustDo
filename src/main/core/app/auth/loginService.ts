import { LOGIN_STORAGE_CONFIG } from '../../../../config/loginStorage';
import {
  type AuthActionResult,
  AuthErrorCode,
  AuthLoginPhase,
  AuthOperation,
  type AuthState,
  AuthStatus,
  AuthSyncStatus,
  INITIAL_AUTH_STATE,
} from '../../../../shared/app/auth';
import { type CredentialUpdate, type LoginSdkAdapter, LoginSdkStatus } from './loginSdkAdapter';
import { LoginStorageError, LoginUserInfoStore, type StoredLogin } from './loginUserInfoStore';

const COOKIE_REFRESH_MIN_INTERVAL_MS = 1_000;
const COOKIE_REFRESH_TIMEOUT_MS = 15_000;
const COOKIE_REFRESH_RETRY_MS = 5_000;
const COOKIE_REFRESH_MAX_RETRY_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type Dependencies = {
  store: LoginUserInfoStore;
  adapter: LoginSdkAdapter;
  onLoginCommitted: () => Promise<void>;
  onLogoutCommitted: () => Promise<void>;
  onStateChanged: (state: AuthState) => void;
} & (
  | { publishCommittedHeaders: (values: Readonly<StoredLogin['values']>) => void }
  | { publishCommittedHeaders?: undefined; onHeadersCommitted: () => void }
);

/** Main-only lease captured BEFORE an asynchronous SDK renewal starts. */
export type AuthCredentialLease = Readonly<{
  generation: number;
  identity: string;
  credentialVersion: string;
}>;

type CookieRenewal = {
  lease: AuthCredentialLease;
  refreshAt: number;
  retryDelayMs: number;
};

export class LoginService {
  private state: AuthState;
  private generation = 0;
  private identity: string | null = null;
  private credentialVersion: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private loginAttempt: { controller: AbortController; promise: Promise<AuthActionResult> } | null =
    null;
  private cookieRenewal: CookieRenewal | null = null;
  private cookieRenewalPaused = true;
  private cookieRenewalTimer: ReturnType<typeof setTimeout> | null = null;
  private cookieRenewalRequest: { controller: AbortController | null } | null = null;
  private disposed = false;
  private readonly lifetime = new AbortController();

  constructor(private readonly dependencies: Dependencies) {
    this.state = { ...INITIAL_AUTH_STATE, sdkAvailable: dependencies.adapter.available };
  }

  getState(): AuthState {
    return this.state;
  }

  /** File import restores display state; only an SDK-confirmed session can renew its Cookie. */
  async restoreFromFile(): Promise<void> {
    if (this.disposed) return;
    this.pauseCookieRenewal();
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
      if (!confirmed || this.disposed || generation !== this.generation) return;
      const current = this.dependencies.store.read();
      if (current?.identity !== login.identity) return;
      this.applyLogin(current, AuthStatus.SignedIn);
      this.scheduleCookieRenewal(current, { restored: true });
      this.publishHeaders(current);
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
    this.pauseCookieRenewal();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.setState({
      operation: AuthOperation.Login,
      loginPhase: AuthLoginPhase.Dialog,
      errorCode: null,
    });
    const promise = this.runLogin(generation, controller).finally(() => {
      if (this.loginAttempt?.controller === controller) {
        this.loginAttempt = null;
        this.scheduleCookieRenewal(this.dependencies.store.read());
      }
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
    this.pauseCookieRenewal();
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
      this.scheduleCookieRenewal(this.dependencies.store.read());
      return this.failure(AuthErrorCode.StorageFailed);
    }
    this.applyLogin(null, AuthStatus.SignedOut);
    await this.sync(null);
    let sdkCleared = true;
    try {
      await this.dependencies.adapter.logout?.({
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]),
      });
    } catch {
      sdkCleared = false;
    }
    this.setState({ operation: AuthOperation.Idle });
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
      const synced = await this.sync(this.state.status === AuthStatus.SignedOut ? null : login);
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
    return this.commitCredentials(lease, update);
  }

  private commitCredentials(
    lease: AuthCredentialLease,
    update: CredentialUpdate,
    renewal?: CookieRenewal,
  ): Promise<AuthActionResult> {
    return this.enqueue(async () => {
      const cookieProvided = Object.hasOwn(update?.headerValues ?? {}, 'X-Cookie');
      const report = (result: AuthActionResult, cookieChanged = false): AuthActionResult => {
        const message = `[LoginService] Credential update ${JSON.stringify({
          result: result.success ? 'success' : result.errorCode,
          cookieProvided,
          cookieChanged,
        })}`;
        if (result.success) console.info(message);
        else console.warn(message);
        return result;
      };
      const current = this.dependencies.store.read();
      if (!this.matchesCredentialLease(lease, current)) {
        return report(this.failure(AuthErrorCode.SessionChanged));
      }
      if (renewal) {
        if (this.cookieRenewalPaused || this.cookieRenewal !== renewal) {
          return this.failure(AuthErrorCode.SessionChanged);
        }
        const cookie = update?.headerValues?.['X-Cookie'];
        if (!cookieProvided || typeof cookie !== 'string' || !cookie.trim()) {
          return { success: false, errorCode: AuthErrorCode.SyncFailed, state: this.state };
        }
      }
      let next: StoredLogin;
      try {
        next = this.dependencies.store.update(current, update);
      } catch {
        return report(this.failure(AuthErrorCode.StorageFailed));
      }
      const previousCookie = current.values['X-Cookie'];
      const nextCookie = next.values['X-Cookie'];
      const cookieChanged = previousCookie !== nextCookie;
      const outboundCookieChanged =
        (typeof previousCookie === 'string' ? previousCookie.trim() : '') !==
        (typeof nextCookie === 'string' ? nextCookie.trim() : '');
      this.identity = next.identity;
      this.credentialVersion = next.credentialVersion;
      if (renewal || outboundCookieChanged) this.cookieRenewal = null;
      this.scheduleCookieRenewal(next);
      if (next.identity !== current.identity) {
        this.setState({ operation: AuthOperation.Sync, errorCode: null });
        const synced = await this.sync(next);
        this.setState({ operation: AuthOperation.Idle });
        return report(
          synced ? this.success() : this.failure(AuthErrorCode.SyncFailed),
          cookieChanged,
        );
      }
      try {
        this.publishHeaders(next);
      } catch {
        this.setState({ syncStatus: AuthSyncStatus.Failed });
        return report(this.failure(AuthErrorCode.SyncFailed), cookieChanged);
      }
      return report(this.success(), cookieChanged);
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
    this.cookieRenewal = null;
    this.pauseCookieRenewal();
    this.loginAttempt?.controller.abort();
    this.lifetime.abort();
    try {
      this.dependencies.adapter.dispose?.();
    } catch {
      console.warn('[LoginService] SDK cleanup did not complete.');
    }
  }

  onSystemResume(): void {
    this.armCookieRenewal();
  }

  private pauseCookieRenewal(): void {
    this.cookieRenewalPaused = true;
    this.armCookieRenewal();
    this.cookieRenewalRequest?.controller?.abort();
  }

  private scheduleCookieRenewal(
    login: StoredLogin | null,
    { restored = false }: { restored?: boolean } = {},
  ): void {
    this.pauseCookieRenewal();
    if (this.loginAttempt) return;
    const previous = restored ? null : this.cookieRenewal;
    this.cookieRenewal = null;
    const adapter = this.dependencies.adapter;
    const lease = this.captureCredentialLease();
    if (
      this.state.status !== AuthStatus.SignedIn ||
      !adapter.available || !adapter.refreshCredentials || !lease || !this.matchesCredentialLease(lease, login)
    ) return;

    const cookie = login.values['X-Cookie'];
    if (typeof cookie !== 'string' || !cookie.trim()) return;
    const intervalMs = LOGIN_STORAGE_CONFIG.cookieRefreshIntervalMs;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < COOKIE_REFRESH_MIN_INTERVAL_MS) return;
    const now = Date.now();
    this.cookieRenewal = {
      lease,
      refreshAt: previous?.refreshAt ?? (restored ? now : now + intervalMs),
      retryDelayMs: previous?.retryDelayMs ?? COOKIE_REFRESH_RETRY_MS,
    };
    this.cookieRenewalPaused = false;
    this.armCookieRenewal();
  }

  private armCookieRenewal(): void {
    if (this.cookieRenewalTimer !== null) clearTimeout(this.cookieRenewalTimer);
    this.cookieRenewalTimer = null;
    const renewal = this.cookieRenewal;
    if (!renewal || this.cookieRenewalPaused || this.cookieRenewalRequest) return;
    const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, renewal.refreshAt - Date.now()));
    this.cookieRenewalTimer = setTimeout(() => {
      this.cookieRenewalTimer = null;
      if (this.cookieRenewalPaused || this.cookieRenewal !== renewal) return;
      if (Date.now() < renewal.refreshAt) this.armCookieRenewal();
      else void this.renewCookie(renewal);
    }, delayMs);
    this.cookieRenewalTimer.unref();
  }

  private async renewCookie(renewal: CookieRenewal): Promise<void> {
    const adapter = this.dependencies.adapter;
    if (!adapter.available || !adapter.refreshCredentials || !this.matchesCredentialLease(renewal.lease, this.dependencies.store.read())) {
      this.cookieRenewal = null;
      this.pauseCookieRenewal();
      return;
    }
    const controller = new AbortController();
    const request: { controller: AbortController | null } = { controller };
    this.cookieRenewalRequest = request;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(COOKIE_REFRESH_TIMEOUT_MS)]);
    try {
      const update = await adapter.refreshCredentials({ signal });
      request.controller = null;
      if (!signal.aborted && !this.cookieRenewalPaused && this.cookieRenewal === renewal) {
        const result = await this.commitCredentials(renewal.lease, update, renewal);
        if (!result.success && result.errorCode === AuthErrorCode.SessionChanged && this.cookieRenewal === renewal) {
          this.cookieRenewal = null;
          this.pauseCookieRenewal();
        }
      }
    } catch {
      // Retries below are confined to this still-current schedule.
    } finally {
      if (this.cookieRenewalRequest === request) {
        this.cookieRenewalRequest = null;
        if (!this.cookieRenewalPaused && this.cookieRenewal === renewal) {
          const delayMs = renewal.retryDelayMs;
          renewal.refreshAt = Date.now() + delayMs;
          renewal.retryDelayMs = Math.min(COOKIE_REFRESH_MAX_RETRY_MS, delayMs * 2);
          console.warn(`[LoginService] Cookie renewal retry scheduled ${JSON.stringify({ delayMs })}`);
        }
        this.armCookieRenewal();
      }
    }
  }

  private async runLogin(
    generation: number,
    controller: AbortController,
  ): Promise<AuthActionResult> {
    let sdkPending = true;
    const enterCompletion = () => {
      if (
        this.disposed ||
        generation !== this.generation ||
        controller.signal.aborted ||
        this.state.loginPhase !== AuthLoginPhase.Dialog
      ) return;
      this.setState({ loginPhase: AuthLoginPhase.Completing });
    };
    try {
      const result = await this.dependencies.adapter.login({
        signal: controller.signal,
        onDialogSubmitted: () => {
          if (sdkPending) enterCompletion();
        },
      });
      sdkPending = false;
      if (result.status === LoginSdkStatus.Authenticated) enterCompletion();
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
          if (!(await this.sync(null))) {
            this.setState({ operation: AuthOperation.Idle });
            return this.failure(AuthErrorCode.SyncFailed);
          }
        }
        if (generation !== this.generation || controller.signal.aborted) {
          return this.failure(AuthErrorCode.SessionChanged);
        }
        const login = this.dependencies.store.writeLogin(result.session);
        this.applyLogin(login, AuthStatus.SignedIn);
        await this.sync(login);
        this.setState({ operation: AuthOperation.Idle });
        return this.success();
      });
    } catch (error) {
      sdkPending = false;
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

  private async sync(login: StoredLogin | null): Promise<boolean> {
    this.setState({ syncStatus: AuthSyncStatus.Pending });
    try {
      if (login) {
        this.dependencies.publishCommittedHeaders?.(login.values);
        await this.dependencies.onLoginCommitted();
      } else {
        await this.dependencies.onLogoutCommitted();
      }
      // Completed means the callback settled, NOT that a model or the runtime is ready.
      this.setState({ syncStatus: AuthSyncStatus.Completed, errorCode: null });
      return true;
    } catch {
      this.setState({ syncStatus: AuthSyncStatus.Failed });
      return false;
    }
  }

  private applyLogin(login: StoredLogin | null, status: AuthState['status']): void {
    // A cleared identity releases a canceled SDK request even if it never settles.
    if (!login) {
      this.cookieRenewal = null;
      this.cookieRenewalRequest = null;
    }
    this.identity = login?.identity ?? null;
    this.credentialVersion = login?.credentialVersion ?? null;
    this.setState({
      status: login ? status : AuthStatus.SignedOut,
      profile: login?.profile ?? null,
    });
  }

  private publishHeaders(login: StoredLogin): void {
    if ('onHeadersCommitted' in this.dependencies) {
      this.dependencies.onHeadersCommitted();
    } else {
      this.dependencies.publishCommittedHeaders(login.values);
    }
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
    const next = { ...this.state, ...patch, revision: this.state.revision + 1 };
    if (next.operation !== AuthOperation.Login || patch.status === AuthStatus.SignedIn) {
      next.loginPhase = null;
    }
    this.state = next;
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
