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

type CustomerPayload = {
  user_id: string;
  metadata: {
    userName: string;
    loginTime: string;
    productName: string;
    version: string;
  };
};

type CustomerRegistrationServiceOptions = {
  getCredential: () => BuiltinModelCredential | null;
  baseUrl: string;
  productName: string;
  version: string;
  userInfoPath: string;
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

export const buildCustomerApiBaseUrl = (modelBaseUrl: string): string => {
  const url = new URL(modelBaseUrl.trim());
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return url.toString().replace(/\/$/, '');
};

const readCustomerPayload = async (
  userInfoPath: string,
  productName: string,
  version: string,
): Promise<CustomerPayload | null> => {
  let parsed: UserInfoFile;
  try {
    const value: unknown = JSON.parse(await fs.promises.readFile(userInfoPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    parsed = value as UserInfoFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[CustomerRegistration] Failed to read user info file.');
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

export class CustomerRegistrationService {
  private readonly request: typeof mainProcessFetch;
  private readonly syncIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private retryAttempt = 0;
  private syncPromise: Promise<void> | null = null;
  private activityEventId = randomUUID();
  private activityStarted = false;
  private activityUserId: string | null = null;
  private requestController: AbortController | null = null;

  constructor(private readonly options: CustomerRegistrationServiceOptions) {
    this.request = options.fetch ?? mainProcessFetch;
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  }

  start(): void {
    if (!ACTIVITY_REPORTING_CONFIG.enabled) return;
    if (this.running) return;
    this.running = true;
    this.retryAttempt = 0;
    void this.sync();
  }

  stop(): void {
    this.running = false;
    this.requestController?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  sync(): Promise<void> {
    if (!ACTIVITY_REPORTING_CONFIG.enabled) {
      this.stop();
      return Promise.resolve();
    }
    if (this.syncPromise) return this.syncPromise;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.syncPromise = this.syncCustomer()
      .then((success) => {
        if (!this.running) return;

        let delay = this.syncIntervalMs;
        if (!success && this.retryAttempt < RETRY_DELAYS_MS.length) {
          delay = RETRY_DELAYS_MS[this.retryAttempt++];
        } else {
          this.retryAttempt = 0;
        }

        this.timer = setTimeout(() => void this.sync(), delay);
        this.timer.unref();
      })
      .finally(() => {
        this.syncPromise = null;
      });
    return this.syncPromise;
  }

  private async syncCustomer(): Promise<boolean> {
    try {
      const payload = await readCustomerPayload(
        this.options.userInfoPath,
        this.options.productName,
        this.options.version,
      );
      if (!payload) {
        console.warn('[CustomerRegistration] Skipped sync because user_id is unavailable.');
        return false;
      }

      const credential = this.options.getCredential();
      if (!credential || credential.authType === 'api-key' || credential.userAccount !== payload.user_id) {
        return false;
      }

      const apiBaseUrl = buildCustomerApiBaseUrl(this.options.baseUrl);
      if (this.activityUserId !== payload.user_id) {
        this.activityUserId = payload.user_id;
        this.activityEventId = randomUUID();
        this.activityStarted = false;
      }
      // The server registers the authenticated Customer. Retain the event
      // identity until acknowledged so retries cannot inflate startup counts.
      const reportActivity = async (): Promise<boolean> => {
        const controller = new AbortController();
        this.requestController = controller;
        try {
          const response = await this.request(`${apiBaseUrl}/customer/activity`, {
            method: 'POST',
            headers: {
              ...buildBuiltinModelRequestHeaders(credential),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              event_id: this.activityEventId,
              user_id: payload.user_id,
              event_type: this.activityStarted ? 'heartbeat' : 'startup',
              metadata: {
                ...payload.metadata,
                clientTime: new Date().toISOString(),
              },
            }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
          if (response.ok) {
            this.activityStarted = true;
            this.activityEventId = randomUUID();
            return true;
          } else {
            console.warn(`[CustomerRegistration] Activity reporting rejected: status=${response.status}.`);
          }
        } catch {
          console.warn('[CustomerRegistration] Activity reporting failed.');
        } finally {
          if (this.requestController === controller) this.requestController = null;
        }
        return false;
      };
      return reportActivity();
    } catch {
      console.warn('[CustomerRegistration] Customer sync failed.');
    }
    return false;
  }
}
