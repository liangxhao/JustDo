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
const DIAGNOSTIC_REPEAT_MS = 30 * 60 * 1000;
const ActivityEvent = {
  Started: 'started', Waiting: 'waiting', Collecting: 'collecting', Sending: 'sending',
  Succeeded: 'succeeded', Failed: 'failed', Skipped: 'skipped', Stopped: 'stopped', Disabled: 'disabled',
} as const;
type ActivityEvent = (typeof ActivityEvent)[keyof typeof ActivityEvent];
type ActivityLogFields = {
  reason?: string;
  phase?: string;
  nextCheckAt?: string;
  lastSuccessAt?: string;
  attempt?: number;
  dailyLimit?: number;
  httpStatus?: number;
  gatewayConnected?: boolean;
  activeSessions?: boolean;
  idleSeconds?: number;
};

export const logDisabledUserActivity = (reason: 'reporting-disabled' | 'provider-disabled'): void => {
  try { console.info(`[UserActivity] ${JSON.stringify({ event: ActivityEvent.Disabled, reason })}`); } catch { /* Optional diagnostics. */ }
};

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
  getIdleStatus?: () => { gatewayConnected: boolean; activeSessions: boolean; idleSeconds: number };
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
  } catch {
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
  private reportedAt = 0;

  constructor(private readonly options: UserActivityServiceOptions) {
    this.request = options.fetch ?? mainProcessFetch;
    this.now = options.now ?? Date.now;
    this.startupReadyAt = this.now() + STARTUP_DELAY_MS;
  }

  start(): void {
    if (!ACTIVITY_REPORTING_CONFIG.enabled) {
      this.note(ActivityEvent.Disabled, { reason: 'reporting-disabled' });
      return;
    }
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.note(ActivityEvent.Started);
    void this.sync();
  }

  stop(): void {
    if (this.running) this.note(ActivityEvent.Stopped);
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
          this.note(ActivityEvent.Failed, { reason: 'unavailable', phase: 'scheduling' });
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

  private note(event: ActivityEvent, fields: ActivityLogFields = {}): void {
    try {
      // Variable timestamps/idle seconds do not defeat same-state rate limiting.
      const status = `${event}:${fields.reason ?? ''}:${fields.phase ?? ''}:${fields.httpStatus ?? ''}:` +
        `${fields.gatewayConnected ?? ''}:${fields.activeSessions ?? ''}`;
      const now = this.now();
      if (status === this.reportedStatus && now - this.reportedAt < DIAGNOSTIC_REPEAT_MS) return;
      this.reportedStatus = status;
      this.reportedAt = now;
      console.info(`[UserActivity] ${JSON.stringify({ event, ...fields })}`);
    } catch { /* Logging must not change scheduling, authentication or request results. */ }
  }

  private noteWaiting(reason: string, delay: number, state?: UserActivityScheduleState): void {
    try {
      const fields: ActivityLogFields = { reason, nextCheckAt: new Date(this.now() + delay).toISOString() };
      if (state) {
        fields.attempt = state.attempts;
        fields.dailyLimit = DAILY_WINDOW_LIMIT;
        if (state.lastSuccessAt > 0) fields.lastSuccessAt = new Date(state.lastSuccessAt).toISOString();
      }
      if (reason === 'not-idle') {
        try {
          const status = this.options.getIdleStatus?.();
          if (status) {
            if (typeof status.gatewayConnected === 'boolean') fields.gatewayConnected = status.gatewayConnected;
            if (typeof status.activeSessions === 'boolean') fields.activeSessions = status.activeSessions;
            if (Number.isFinite(status.idleSeconds) && status.idleSeconds >= 0) fields.idleSeconds = Math.floor(status.idleSeconds);
          }
        } catch { /* Idle diagnostics are independent of the eligibility check. */ }
      }
      this.note(ActivityEvent.Waiting, fields);
    } catch { /* Optional diagnostics. */ }
  }

  private noteScheduleWait(state: UserActivityScheduleState, delay: number): void {
    try {
      const now = this.now();
      const reason = state.cooldownUntil > now ? 'endpoint-cooldown' :
        state.attempts >= DAILY_WINDOW_LIMIT ? 'daily-limit' : 'minimum-interval';
      this.noteWaiting(reason, delay, state);
    } catch { /* Optional diagnostics. */ }
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
    let phase = 'schedule-read';
    let timedOut = false;
    try {
      const startupDelay = this.startupReadyAt - this.now();
      if (startupDelay > 0) {
        this.noteWaiting('startup-delay', startupDelay);
        return startupDelay;
      }
      let state = this.readState();
      const delay = this.nextDelay(state);
      if (delay > 0) {
        this.noteScheduleWait(state, delay);
        return delay;
      }
      phase = 'idle-check';
      if (!this.options.isIdle()) {
        this.noteWaiting('not-idle', IDLE_RECHECK_MS, state);
        return IDLE_RECHECK_MS;
      }
      phase = 'login-read';
      const payload = await readUserActivityPayload(
        this.options.userInfoPath, this.options.productName, this.options.version,
      );
      if (generation !== this.generation || !this.running) return IDLE_RECHECK_MS;
      if (!payload) {
        this.noteWaiting('login-unavailable', IDLE_RECHECK_MS, state);
        return IDLE_RECHECK_MS;
      }
      phase = 'credential-check';
      if (!this.isCurrent(generation, payload.user_id)) {
        const credential = this.options.getCredential();
        this.noteWaiting(!credential ? 'jwt-unavailable' : credential.authType === 'api-key' ? 'api-key-mode' :
          'identity-changed', IDLE_RECHECK_MS, state);
        return IDLE_RECHECK_MS;
      }
      phase = 'configuration';
      const apiBaseUrl = buildActivityApiBaseUrl(this.options.baseUrl);
      const endpointPath = ACTIVITY_REPORTING_CONFIG.endpointPath;
      if (!/^\/(?!\/)[A-Za-z0-9._~/-]+$/.test(endpointPath) ||
          endpointPath.split('/').some(segment => segment === '.' || segment === '..')) {
        this.note(ActivityEvent.Failed, { reason: 'invalid-endpoint', phase,
          nextCheckAt: new Date(this.now() + DAY_MS).toISOString() });
        return DAY_MS;
      }
      // Reserve before any native statistics work. Preparation failures and unchanged
      // snapshots consume a window too, bounding both collection and HTTP attempts.
      phase = 'schedule-read';
      state = this.readState();
      const currentDelay = this.nextDelay(state);
      if (currentDelay > 0) {
        this.noteScheduleWait(state, currentDelay);
        return currentDelay;
      }
      phase = 'idle-check';
      if (!this.options.isIdle()) {
        this.noteWaiting('not-idle', IDLE_RECHECK_MS, state);
        return IDLE_RECHECK_MS;
      }
      const reserved = { ...state, attempts: state.attempts + 1, lastAttemptAt: this.now() };
      phase = 'window-reservation';
      this.options.stateStore.write(reserved);
      this.note(ActivityEvent.Collecting, { attempt: reserved.attempts, dailyLimit: DAILY_WINDOW_LIMIT });
      controller = new AbortController();
      this.requestController = controller;
      const signal = controller.signal;
      phase = 'collection';
      timeout = setTimeout(() => { timedOut = true; controller?.abort(); }, COLLECTION_TIMEOUT_MS);
      timeout.unref();
      const collected = this.options.collectMetadata
        ? await abortable(this.options.collectMetadata(signal), signal) : {};
      clearTimeout(timeout);
      timeout = undefined;
      if (!this.isCurrent(generation, payload.user_id)) return MIN_INTERVAL_MS;
      if (signal.aborted || collected === null) {
        this.note(ActivityEvent.Skipped, { reason: signal.aborted ? 'collection-cancelled' : 'statistics-unavailable',
          nextCheckAt: new Date(this.now() + Math.max(IDLE_RECHECK_MS, this.nextDelay(reserved))).toISOString() });
        phase = 'schedule-read';
        return Math.max(IDLE_RECHECK_MS, this.nextDelay(this.readState()));
      }
      phase = 'payload';
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
        this.note(ActivityEvent.Skipped, { reason: 'unchanged',
          nextCheckAt: new Date(this.now() + Math.max(IDLE_RECHECK_MS, this.nextDelay(reserved))).toISOString() });
        phase = 'schedule-read';
        return Math.max(IDLE_RECHECK_MS, this.nextDelay(this.readState()));
      }
      // Collection can outlive a login, token renewal or an idle interval.
      phase = 'credential-check';
      if (!this.isCurrent(generation, payload.user_id)) {
        if (generation === this.generation) this.note(ActivityEvent.Skipped, { reason: 'identity-changed' });
        return MIN_INTERVAL_MS;
      }
      phase = 'idle-check';
      if (!this.options.isIdle() || reserved.date !== reportDate(this.now())) {
        this.note(ActivityEvent.Skipped, { reason: reserved.date !== reportDate(this.now()) ? 'day-changed' : 'no-longer-idle' });
        return MIN_INTERVAL_MS;
      }
      phase = 'credential-check';
      const credential = this.options.getCredential();
      if (!credential || credential.authType === 'api-key' || credential.userAccount !== payload.user_id) {
        this.note(ActivityEvent.Skipped, { reason: 'credential-changed' });
        return MIN_INTERVAL_MS;
      }
      phase = 'request';
      this.note(ActivityEvent.Sending, { attempt: reserved.attempts, dailyLimit: DAILY_WINDOW_LIMIT });
      timeout = setTimeout(() => { timedOut = true; controller?.abort(); }, REQUEST_TIMEOUT_MS);
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
        this.note(ActivityEvent.Failed, { reason: 'http-rejected', phase, httpStatus: response.status,
          nextCheckAt: new Date(DEFERRED_HTTP_STATUSES.has(response.status) ? this.now() + DAY_MS :
            this.now() + Math.max(IDLE_RECHECK_MS, this.nextDelay(reserved))).toISOString() });
        if (DEFERRED_HTTP_STATUSES.has(response.status)) {
          phase = 'schedule-read';
          const latest = this.readState();
          phase = 'cooldown-persistence';
          this.options.stateStore.write({ ...latest, cooldownUntil: this.now() + DAY_MS });
        }
        phase = 'schedule-read';
        return Math.max(IDLE_RECHECK_MS, this.nextDelay(this.readState()));
      }
      phase = 'acknowledgement';
      const acknowledged = await acknowledgesActivity(response, signal);
      if (!this.isCurrent(generation, payload.user_id)) return MIN_INTERVAL_MS;
      if (!acknowledged) {
        this.note(ActivityEvent.Failed, { reason: 'response-not-acknowledged', phase, httpStatus: response.status,
          nextCheckAt: new Date(this.now() + DAY_MS).toISOString() });
        phase = 'schedule-read';
        const latest = this.readState();
        phase = 'cooldown-persistence';
        this.options.stateStore.write({ ...latest, cooldownUntil: this.now() + DAY_MS });
        return DAY_MS;
      }
      this.note(ActivityEvent.Succeeded, { httpStatus: response.status, attempt: reserved.attempts,
        dailyLimit: DAILY_WINDOW_LIMIT });
      phase = 'schedule-read';
      const latest = this.readState();
      phase = 'success-persistence';
      this.options.stateStore.write({ ...latest, fingerprint, lastSuccessAt: this.now() });
      phase = 'schedule-read';
      return Math.max(IDLE_RECHECK_MS, this.nextDelay(this.readState()));
    } catch {
      if (generation !== this.generation) return MIN_INTERVAL_MS;
      const reason = timedOut ? 'timeout' : phase === 'configuration' ? 'invalid-configuration' :
        phase === 'window-reservation' || phase === 'success-persistence' || phase === 'cooldown-persistence' ? 'state-write-failed' :
          phase === 'schedule-read' ? 'state-read-failed' : phase === 'payload' ? 'payload-invalid' :
            phase === 'request' ? 'network-error' : 'unavailable';
      this.note(ActivityEvent.Failed, { reason, phase });
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
