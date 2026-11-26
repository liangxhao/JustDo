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
import { BuiltinModelAuthDiagnosticReason } from '../../../providers/builtinModelAuthDiagnostics';
import { requiresBuiltinModelUserAction } from '../../../providers/builtinModelTokenExchange';
import {
  type CredentialUpdate,
  type LoginSdkAdapter,
  type LoginSdkRestoreResult,
  LoginSdkRestoreStatus,
  LoginSdkStatus,
} from './loginSdkAdapter';
import { LoginStorageError, LoginUserInfoStore, type StoredLogin } from './loginUserInfoStore';

const COOKIE_REFRESH_MIN_INTERVAL_MS = 1_000;
const SDK_REQUEST_TIMEOUT_MS = 15_000;
const SDK_RETRY_INITIAL_MS = 5_000;
const SDK_RETRY_MAX_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type Dependencies = {
  store: LoginUserInfoStore;
  adapter: LoginSdkAdapter;
  onLoginCommitted: () => Promise<boolean | void>;
  onLogoutCommitted: () => Promise<void>;
  waitForLogoutCatalog?: () => Promise<void>;
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
  private syncAttempt = 0;
  private identity: string | null;
  private credentialVersion: string | null;
  private queue: Promise<unknown> = Promise.resolve();
  private loginAttempt: { controller: AbortController; promise: Promise<AuthActionResult> } | null =
    null;
  private sessionRestore: AbortController | null = null;
  private sessionRestoreInterrupted = false;
  private cookieRenewal: CookieRenewal | null = null;
  private cookieRenewalPaused = true;
  private cookieRenewalTimer: ReturnType<typeof setTimeout> | null = null;
  private cookieRenewalRequest: { controller: AbortController | null } | null = null;
  private disposed = false;
  private readonly lifetime = new AbortController();

  constructor(private readonly dependencies: Dependencies) {
    const login = dependencies.store.read();
    this.identity = login?.identity ?? null;
    this.credentialVersion = login?.credentialVersion ?? null;
    this.state = {
      ...INITIAL_AUTH_STATE,
      sdkAvailable: dependencies.adapter.available,
      status: login ? AuthStatus.LocalCredentials : AuthStatus.SignedOut,
      profile: login?.profile ?? null,
    };
  }

  getState(): AuthState {
    return this.state;
  }

  /** Only an SDK-confirmed session can renew its Cookie. */
  async restoreSdkSession(): Promise<void> {
    const { adapter, store } = this.dependencies;
    const { operation, status } = this.state;
    if (
      this.disposed ||
      this.sessionRestore ||
      status !== AuthStatus.LocalCredentials ||
      operation !== AuthOperation.Idle ||
      !adapter.available ||
      !adapter.restoreSession
    )
      return;

    const controller = new AbortController();
    this.sessionRestore = controller;
    this.sessionRestoreInterrupted = false;
    const generation = this.generation;
    const identity = this.identity;
    try {
      let retryDelayMs = SDK_RETRY_INITIAL_MS;
      while (!controller.signal.aborted && generation === this.generation) {
        const before = store.read();
        if (!before || before.identity !== identity) return;
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(SDK_REQUEST_TIMEOUT_MS),
        ]);
        let result: LoginSdkRestoreResult = false;
        try {
          result = await adapter.restoreSession({
            signal,
            profile: before.profile,
            mtoken: before.mtoken,
            cookie: before.cookie,
          });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
        if (controller.signal.aborted || generation !== this.generation) return;
        const retryable = signal.aborted ||
          (typeof result === 'object' && result?.status === LoginSdkRestoreStatus.Retryable);
        if (!retryable) {
          const confirmed = result;
          if (!confirmed || (confirmed !== true && confirmed.status !== LoginSdkRestoreStatus.Recovered)) return;
          const retryWithLatestCredentials = await this.enqueue(async () => {
            if (controller.signal.aborted || generation !== this.generation) return false;
            const current = store.read();
            if (!current || current.identity !== identity) return false;
            let login = current;
            if (confirmed !== true) {
              if (
                confirmed.account !== current.profile.account ||
                typeof confirmed.cookie !== 'string' || !confirmed.cookie.trim()
              ) return false;
              if (current.credentialVersion !== before.credentialVersion) return true;
              login = store.update(current, { headerValues: { 'X-Cookie': confirmed.cookie } });
            }
            this.applyLogin(login, AuthStatus.SignedIn);
            this.scheduleCookieRenewal(login, { restored: confirmed === true });
            this.publishHeaders(login);
            return false;
          });
          if (!retryWithLatestCredentials || controller.signal.aborted) return;
        }
        console.warn(`[LoginService] Session restore retry scheduled ${JSON.stringify({ delayMs: retryDelayMs })}`);
        await new Promise<void>(resolve => {
          const resume = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', resume);
            resolve();
          };
          const timer = setTimeout(resume, retryDelayMs);
          timer.unref();
          controller.signal.addEventListener('abort', resume, { once: true });
        });
        retryDelayMs = Math.min(SDK_RETRY_MAX_MS, retryDelayMs * 2);
      }
    } catch {
      if (!controller.signal.aborted) console.warn('[LoginService] SDK session restoration did not complete.');
    } finally {
      if (this.sessionRestore === controller) this.sessionRestore = null;
    }
  }

  private cancelSessionRestore(): void {
    const controller = this.sessionRestore;
    if (!controller) return;
    this.sessionRestore = null;
    this.sessionRestoreInterrupted = true;
    controller.abort();
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
    this.cancelSessionRestore();
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
        if (this.sessionRestoreInterrupted) void this.restoreSdkSession();
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
    this.cancelSessionRestore();
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
      if (this.sessionRestoreInterrupted) void this.restoreSdkSession();
      return this.failure(AuthErrorCode.StorageFailed);
    }
    this.applyLogin(null, AuthStatus.SignedOut);
    // Local revocation starts synchronously; Gateway acknowledgement has its own status.
    void this.sync(null);
    let sdkCleared = true;
    try {
      await this.dependencies.adapter.logout?.({
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(SDK_REQUEST_TIMEOUT_MS)]),
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
      return synced ? this.success() : this.failure(this.state.errorCode ?? AuthErrorCode.SyncFailed);
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
          synced ? this.success() : this.failure(this.state.errorCode ?? AuthErrorCode.SyncFailed),
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
    this.cancelSessionRestore();
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

    if (!login.cookie) return;
    const intervalMs = LOGIN_STORAGE_CONFIG.cookieRefreshIntervalMs;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < COOKIE_REFRESH_MIN_INTERVAL_MS) return;
    const now = Date.now();
    this.cookieRenewal = {
      lease,
      refreshAt: previous?.refreshAt ?? (restored ? now : now + intervalMs),
      retryDelayMs: previous?.retryDelayMs ?? SDK_RETRY_INITIAL_MS,
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
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SDK_REQUEST_TIMEOUT_MS)]);
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
          renewal.retryDelayMs = Math.min(SDK_RETRY_MAX_MS, delayMs * 2);
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
        } else {
          // An explicit logout may still be clearing the previous account's model catalog.
          try {
            await this.dependencies.waitForLogoutCatalog?.();
          } catch {
            if (generation !== this.generation || controller.signal.aborted) {
              return this.failure(AuthErrorCode.SessionChanged);
            }
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
    const attempt = ++this.syncAttempt;
    this.setState({ syncStatus: AuthSyncStatus.Pending });
    try {
      let confirmed = true;
      if (login) {
        this.dependencies.publishCommittedHeaders?.(login.values);
        confirmed = (await this.dependencies.onLoginCommitted()) !== false;
      } else {
        await this.dependencies.onLogoutCommitted();
      }
      // A late cleanup must leave the new login and any SDK logout error alone.
      if (attempt === this.syncAttempt) {
        this.setState({ syncStatus: confirmed ? AuthSyncStatus.Completed : AuthSyncStatus.Idle });
      }
      return true;
    } catch (error) {
      if (attempt === this.syncAttempt) {
        const modelErrorCode = login && requiresBuiltinModelUserAction(error)
          ? error.reason === BuiltinModelAuthDiagnosticReason.DeviceUnavailable
            ? AuthErrorCode.ModelAuthDeviceUnavailable : AuthErrorCode.ModelAuthRejected
          : undefined;
        this.setState({ syncStatus: AuthSyncStatus.Failed, ...(modelErrorCode && { errorCode: modelErrorCode }) });
      }
      return false;
    }
  }

  private applyLogin(login: StoredLogin | null, status: AuthState['status']): void {
    this.sessionRestoreInterrupted = false;
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
