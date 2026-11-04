import { randomUUID } from 'node:crypto';

import fs from 'fs';

import { ACTIVITY_REPORTING_CONFIG } from '../../../config/activityReporting';
import {
  buildBuiltinModelRequestHeaders,
  type BuiltinModelCredential,
} from '../../providers/builtinModelCredential';
import { mainProcessFetch } from '../network/mainProcessFetch';

const DEFAULT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MAX_RESPONSE_BYTES = 4096;
const DEFERRED_HTTP_STATUSES = new Set([400, 404, 405, 413, 415, 422, 501]);
const ReportOutcome = {
  Acknowledged: 'acknowledged',
  Deferred: 'deferred',
  Retry: 'retry',
  Retired: 'retired',
} as const;
type ReportOutcome = (typeof ReportOutcome)[keyof typeof ReportOutcome];

export type UserActivityValue =
  | null | boolean | number | string | UserActivityValue[] | UserActivityMetadata;
export type UserActivityMetadata = { [key: string]: UserActivityValue };

type PendingActivityEvent = {
  userId: string;
  body: string;
};

const acknowledgesActivity = async (response: Response, signal: AbortSignal): Promise<boolean> => {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const abort = (): void => { void reader.cancel().catch((): void => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return false;
      chunks.push(value);
    }
    signal.throwIfAborted();
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return Boolean(value && typeof value === 'object' &&
        !Array.isArray(value) && (value as { ok?: unknown }).ok === true);
    } catch {
      return false;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch((): void => undefined);
    reader.releaseLock();
  }
};

type UserActivityPayload = {
  user_id: string;
  metadata: {
    userName: string;
    loginTime: string;
    productName: string;
    version: string;
  };
};

type UserActivityServiceOptions = {
  getCredential: () => BuiltinModelCredential | null;
  baseUrl: string;
  productName: string;
  version: string;
  userInfoPath: string;
  getMetadata?: () => UserActivityMetadata;
  fetch?: typeof mainProcessFetch;
  syncIntervalMs?: number;
};

type UserInfoFile = {
  'X-User-Account'?: unknown;
  userName?: unknown;
  loginTime?: unknown;
};

const normalizeString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

export const buildActivityApiBaseUrl = (modelBaseUrl: string): string => {
  const url = new URL(modelBaseUrl.trim());
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return url.toString().replace(/\/$/, '');
};

const readUserActivityPayload = async (
  userInfoPath: string,
  productName: string,
  version: string,
): Promise<UserActivityPayload | null> => {
  let parsed: UserInfoFile;
  try {
    const value: unknown = JSON.parse(await fs.promises.readFile(userInfoPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    parsed = value as UserInfoFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.info('[UserActivity] Activity deferred: login information is unavailable.');
    }
    return null;
  }

  const userId = normalizeString(parsed['X-User-Account']);
  if (!userId) return null;

  return {
    user_id: userId,
    metadata: {
      userName: normalizeString(parsed.userName),
      loginTime: normalizeString(parsed.loginTime),
      productName,
      version,
    },
  };
};

export class UserActivityService {
  private readonly request: typeof mainProcessFetch;
  private readonly syncIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;
  private retryAttempt = 0;
  private syncPromise: Promise<void> | null = null;
  private syncGeneration = 0;
  private syncRequested = false;
  private activityStarted = false;
  private activityUserId: string | null = null;
  private pendingEvent: PendingActivityEvent | null = null;
  private requestController: AbortController | null = null;
  private reportedStatus: string | null = null;

  constructor(private readonly options: UserActivityServiceOptions) {
    this.request = options.fetch ?? mainProcessFetch;
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  }

  start(): void {
    if (!ACTIVITY_REPORTING_CONFIG.enabled || this.running) return;
    this.running = true;
    this.generation += 1;
    this.retryAttempt = 0;
    void this.sync();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.requestController?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.syncRequested = false;
    this.pendingEvent = null;
    this.activityStarted = false;
    this.activityUserId = null;
  }

  sync(): Promise<void> {
    if (!ACTIVITY_REPORTING_CONFIG.enabled) {
      this.stop();
      return Promise.resolve();
    }
    if (this.syncPromise) {
      if (this.syncGeneration !== this.generation) this.syncRequested = true;
      return this.syncPromise;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const generation = this.generation;
    this.syncGeneration = generation;
    const pending = this.syncActivity(generation)
      .then(outcome => {
        if (!this.running || generation !== this.generation) return;
        let delay = this.syncIntervalMs;
        if (outcome === ReportOutcome.Retry && this.retryAttempt < RETRY_DELAYS_MS.length) {
          delay = RETRY_DELAYS_MS[this.retryAttempt++];
        } else {
          this.retryAttempt = 0;
        }
        this.timer = setTimeout(() => void this.sync(), delay);
        this.timer.unref();
      })
      .catch(() => {
        // Optional reporting must never reject a caller's login/startup work.
        if (generation === this.generation) this.noteDeferred('unavailable');
      })
      .finally(() => {
        if (this.syncPromise !== pending) return;
        this.syncPromise = null;
        if (this.syncRequested && this.running) {
          this.syncRequested = false;
          void this.sync();
        }
      });
    this.syncPromise = pending;
    return pending;
  }

  private noteDeferred(status: string): void {
    if (this.reportedStatus === status) return;
    this.reportedStatus = status;
    console.info(`[UserActivity] Optional activity reporting deferred: ${status}.`);
  }

  private isCurrent(generation: number, userId: string): boolean {
    if (generation !== this.generation) return false;
    const credential = this.options.getCredential();
    return Boolean(credential && credential.authType !== 'api-key' && credential.userAccount === userId);
  }

  private async syncActivity(generation: number): Promise<ReportOutcome> {
    let controller: AbortController | null = null;
    try {
      const payload = await readUserActivityPayload(
        this.options.userInfoPath, this.options.productName, this.options.version,
      );
      if (generation !== this.generation) return ReportOutcome.Retired;
      if (!payload) return ReportOutcome.Retry;
      const credential = this.options.getCredential();
      if (!credential || credential.authType === 'api-key' || credential.userAccount !== payload.user_id) {
        return ReportOutcome.Retry;
      }
      const apiBaseUrl = buildActivityApiBaseUrl(this.options.baseUrl);
      const endpointPath = ACTIVITY_REPORTING_CONFIG.endpointPath;
      if (!/^\/(?!\/)[A-Za-z0-9._~/-]+$/.test(endpointPath) ||
          endpointPath.split('/').some(segment => segment === '.' || segment === '..')) {
        this.noteDeferred('invalid endpoint configuration');
        return ReportOutcome.Deferred;
      }
      if (this.activityUserId !== payload.user_id) {
        this.activityUserId = payload.user_id;
        this.pendingEvent = null;
        this.activityStarted = false;
      }
      if (!this.pendingEvent) {
        const metadata = this.options.getMetadata?.() ?? {};
        const body = JSON.stringify({
          event_id: randomUUID(),
          user_id: payload.user_id,
          event_type: this.activityStarted ? 'heartbeat' : 'startup',
          metadata: { ...metadata, ...payload.metadata, clientTime: new Date().toISOString() },
        }, (_key, value: unknown) => {
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid activity number');
          return value;
        });
        this.pendingEvent = { userId: payload.user_id, body };
      }
      const event = this.pendingEvent;
      controller = new AbortController();
      this.requestController = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      const response = await this.request(`${apiBaseUrl}${endpointPath}`, {
        method: 'POST',
        headers: { ...buildBuiltinModelRequestHeaders(credential), 'Content-Type': 'application/json' },
        body: event.body,
        redirect: 'error',
        signal,
      }, { maxResponseBytes: MAX_RESPONSE_BYTES });
      if (!this.isCurrent(generation, event.userId)) {
        await response.body?.cancel().catch((): void => undefined);
        return ReportOutcome.Retired;
      }
      if (!response.ok) {
        await response.body?.cancel().catch((): void => undefined);
        this.noteDeferred(`HTTP ${response.status}`);
        return DEFERRED_HTTP_STATUSES.has(response.status) ? ReportOutcome.Deferred : ReportOutcome.Retry;
      }
      const acknowledged = await acknowledgesActivity(response, signal);
      if (!this.isCurrent(generation, event.userId) || this.pendingEvent !== event) return ReportOutcome.Retired;
      if (!acknowledged) {
        this.noteDeferred('response not acknowledged');
        return ReportOutcome.Deferred;
      }
      this.activityStarted = true;
      this.pendingEvent = null;
      this.reportedStatus = null;
      return ReportOutcome.Acknowledged;
    } catch {
      if (generation !== this.generation) return ReportOutcome.Retired;
      this.noteDeferred('unavailable');
      return ReportOutcome.Retry;
    } finally {
      if (this.requestController === controller) this.requestController = null;
    }
  }
}
