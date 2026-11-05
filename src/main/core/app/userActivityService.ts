import { createHash, randomUUID } from 'node:crypto';

import fs from 'fs';

import { ACTIVITY_REPORTING_CONFIG } from '../../../config/activityReporting';
import {
  buildBuiltinModelRequestHeaders,
  type BuiltinModelCredential,
} from '../../providers/builtinModelCredential';
import { mainProcessFetch } from '../network/mainProcessFetch';

const DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const IDLE_RECHECK_MS = 5 * 60 * 1000;
const COLLECTION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 4096;
const MAX_BODY_BYTES = 8192;
const DAILY_WINDOW_LIMIT = 3;
const DEFERRED_HTTP_STATUSES = new Set([400, 404, 405, 413, 415, 422, 501]);
const SNAPSHOT_TIME_FIELDS = new Set(['clientTime', 'collectedAt', 'updatedAt']);

export const USER_ACTIVITY_SCHEDULE_KEY = 'activity.reportingSchedule';

export type UserActivityScheduleState = {
  date: string;
  attempts: number;
  lastAttemptAt: number;
  cooldownUntil: number;
  lastSuccessAt: number;
  fingerprint: string | null;
};

export type UserActivityValue =
  | null | boolean | number | string | UserActivityValue[] | UserActivityMetadata;
export type UserActivityMetadata = { [key: string]: UserActivityValue };

const reportDate = (now: number): string => new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const nextReportDay = (now: number): number =>
  Date.parse(`${reportDate(now)}T00:00:00+08:00`) + DAY_MS;

const readScheduleState = (value: unknown, now: number): UserActivityScheduleState => {
  const date = reportDate(now);
  if (value === undefined) {
    return { date, attempts: 0, lastAttemptAt: 0, cooldownUntil: 0, lastSuccessAt: 0, fingerprint: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid activity schedule');
  const state = value as UserActivityScheduleState;
  if (typeof state.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(state.date) ||
      !Number.isInteger(state.attempts) || state.attempts < 0 || state.attempts > DAILY_WINDOW_LIMIT ||
      ![state.lastAttemptAt, state.cooldownUntil, state.lastSuccessAt]
        .every(time => Number.isSafeInteger(time) && time >= 0) ||
      !(state.fingerprint === null || (typeof state.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(state.fingerprint)))) {
    throw new Error('Invalid activity schedule');
  }
  // Midnight resets only the day budget. It never removes spacing or endpoint cooldown.
  return state.date < date ? { ...state, date, attempts: 0 } : { ...state };
};

const abortable = <T>(task: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const abort = (): void => reject(signal.reason ?? new Error('Activity stopped'));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
});

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
  stateStore: {
    read: () => unknown;
    write: (state: UserActivityScheduleState) => void;
  };
  isIdle: () => boolean;
  collectMetadata?: (signal: AbortSignal) => Promise<UserActivityMetadata | null>;
  getMetadata?: () => UserActivityMetadata;
  fetch?: typeof mainProcessFetch;
  now?: () => number;
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
  private readonly now: () => number;
  private readonly startupReadyAt: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;
  private syncPromise: Promise<void> | null = null;
  private syncGeneration = 0;
  private syncRequested = false;
  private requestController: AbortController | null = null;
  private reportedStatus: string | null = null;

  constructor(private readonly options: UserActivityServiceOptions) {
    this.request = options.fetch ?? mainProcessFetch;
    this.now = options.now ?? Date.now;
    this.startupReadyAt = this.now() + STARTUP_DELAY_MS;
  }

  start(): void {
    if (!ACTIVITY_REPORTING_CONFIG.enabled || this.running) return;
    this.running = true;
    this.generation += 1;
    void this.sync();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.requestController?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.syncRequested = false;
  }

  sync(): Promise<void> {
    if (!ACTIVITY_REPORTING_CONFIG.enabled) {
      this.stop();
      return Promise.resolve();
    }
    if (!this.running) return Promise.resolve();
    if (this.syncPromise) {
      if (this.syncGeneration !== this.generation) this.syncRequested = true;
      return this.syncPromise;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const generation = this.generation;
    this.syncGeneration = generation;
    const pending = this.syncActivity(generation)
      .then(delay => {
        if (!this.running || generation !== this.generation) return;
        this.schedule(generation, delay);
      })
      .catch(() => {
        // Optional reporting must never reject a caller's login/startup work.
        if (generation === this.generation) {
          this.noteDeferred('unavailable');
          this.schedule(generation, IDLE_RECHECK_MS);
        }
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

  private schedule(generation: number, delay: number): void {
    if (!this.running || generation !== this.generation) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), Math.min(DAY_MS, Math.max(1, delay)));
    this.timer.unref();
  }

  private readState(): UserActivityScheduleState {
    return readScheduleState(this.options.stateStore.read(), this.now());
  }

  private nextDelay(state: UserActivityScheduleState): number {
    const now = this.now();
    const due = Math.max(this.startupReadyAt, state.cooldownUntil,
      state.lastAttemptAt ? state.lastAttemptAt + MIN_INTERVAL_MS : 0,
      state.attempts >= DAILY_WINDOW_LIMIT || state.date > reportDate(now) ? nextReportDay(now) : 0);
    return Math.max(0, due - now);
  }

  private isCurrent(generation: number, userId: string): boolean {
    if (!this.running || generation !== this.generation) return false;
    const credential = this.options.getCredential();
    return Boolean(credential && credential.authType !== 'api-key' && credential.userAccount === userId);
  }

  private async syncActivity(generation: number): Promise<number> {
    let controller: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const startupDelay = this.startupReadyAt - this.now();
      if (startupDelay > 0) return startupDelay;
      let state = this.readState();
      const delay = this.nextDelay(state);
      if (delay > 0) return delay;
      if (!this.options.isIdle()) return IDLE_RECHECK_MS;
      const payload = await readUserActivityPayload(
        this.options.userInfoPath, this.options.productName, this.options.version,
      );
      if (!payload || !this.isCurrent(generation, payload.user_id)) return IDLE_RECHECK_MS;
      const apiBaseUrl = buildActivityApiBaseUrl(this.options.baseUrl);
      const endpointPath = ACTIVITY_REPORTING_CONFIG.endpointPath;
      if (!/^\/(?!\/)[A-Za-z0-9._~/-]+$/.test(endpointPath) ||
          endpointPath.split('/').some(segment => segment === '.' || segment === '..')) {
        this.noteDeferred('invalid endpoint configuration');
        return DAY_MS;
      }
      // Reserve before any native statistics work. Preparation failures and unchanged
      // snapshots consume a window too, bounding both collection and HTTP attempts.
      state = this.readState();
      const currentDelay = this.nextDelay(state);
      if (currentDelay > 0) return currentDelay;
      if (!this.options.isIdle()) return IDLE_RECHECK_MS;
      const reserved = { ...state, attempts: state.attempts + 1, lastAttemptAt: this.now() };
      this.options.stateStore.write(reserved);
      controller = new AbortController();
      this.requestController = controller;
      const signal = controller.signal;
      timeout = setTimeout(() => controller?.abort(), COLLECTION_TIMEOUT_MS);
      timeout.unref();
      const collected = this.options.collectMetadata
        ? await abortable(this.options.collectMetadata(signal), signal) : {};
      clearTimeout(timeout);
      timeout = undefined;
      if (!this.isCurrent(generation, payload.user_id)) return MIN_INTERVAL_MS;
      if (signal.aborted || collected === null) {
        return Math.max(IDLE_RECHECK_MS, this.nextDelay(this.readState()));
      }
      const metadata = { ...this.options.getMetadata?.(), ...collected, ...payload.metadata,
        clientTime: new Date(this.now()).toISOString() };
      const body = JSON.stringify({ event_id: randomUUID(), user_id: payload.user_id,
        event_type: 'usage.snapshot', metadata }, (_key, value: unknown) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid activity number');
        return value;
      });
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('Activity body too large');
      const fingerprint = createHash('sha256').update(JSON.stringify({ user_id: payload.user_id, metadata },
        (key, value: unknown) => {
          if (SNAPSHOT_TIME_FIELDS.has(key)) return undefined;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
          }
          return value;
        })).digest('hex');
      if (state.fingerprint === fingerprint && this.now() - state.lastSuccessAt < DAY_MS) {
        return Math.max(IDLE_RECHECK_MS, this.nextDelay(this.readState()));
      }
      // Collection can outlive a login, token renewal or an idle interval.
      if (!this.isCurrent(generation, payload.user_id) || !this.options.isIdle() ||
          reserved.date !== reportDate(this.now())) return MIN_INTERVAL_MS;
      const credential = this.options.getCredential();
      if (!credential || credential.authType === 'api-key' || credential.userAccount !== payload.user_id) {
        return MIN_INTERVAL_MS;
      }
      timeout = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
      timeout.unref();
      const response = await abortable(this.request(`${apiBaseUrl}${endpointPath}`, {
        method: 'POST',
        headers: { ...buildBuiltinModelRequestHeaders(credential), 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal,
      }, { maxResponseBytes: MAX_RESPONSE_BYTES }).then(value => {
        if (signal.aborted) void value.body?.cancel().catch((): void => undefined);
        return value;
      }), signal);
      if (!this.isCurrent(generation, payload.user_id)) {
        void response.body?.cancel().catch((): void => undefined);
        return MIN_INTERVAL_MS;
      }
      if (!response.ok) {
        void response.body?.cancel().catch((): void => undefined);
        if (!this.isCurrent(generation, payload.user_id)) return MIN_INTERVAL_MS;
        this.noteDeferred(`HTTP ${response.status}`);
        if (DEFERRED_HTTP_STATUSES.has(response.status)) {
          this.options.stateStore.write({ ...this.readState(), cooldownUntil: this.now() + DAY_MS });
        }
        return Math.max(IDLE_RECHECK_MS, this.nextDelay(this.readState()));
      }
      const acknowledged = await acknowledgesActivity(response, signal);
      if (!this.isCurrent(generation, payload.user_id)) return MIN_INTERVAL_MS;
      if (!acknowledged) {
        this.noteDeferred('response not acknowledged');
        this.options.stateStore.write({ ...this.readState(), cooldownUntil: this.now() + DAY_MS });
        return DAY_MS;
      }
      this.options.stateStore.write({ ...this.readState(), fingerprint, lastSuccessAt: this.now() });
      this.reportedStatus = null;
      return Math.max(IDLE_RECHECK_MS, this.nextDelay(this.readState()));
    } catch {
      if (generation !== this.generation) return MIN_INTERVAL_MS;
      this.noteDeferred('unavailable');
      try {
        return Math.max(IDLE_RECHECK_MS, this.nextDelay(this.readState()));
      } catch {
        return IDLE_RECHECK_MS;
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.requestController === controller) this.requestController = null;
    }
  }
}
