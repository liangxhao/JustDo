import fs from 'fs';

import { mainProcessFetch } from './mainProcessFetch';

const DEFAULT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

type CustomerMetadata = {
  userName: string;
  loginTime: string;
  productName: string;
  version: string;
};

type CustomerPayload = {
  user_id: string;
  alias: string;
  metadata: CustomerMetadata;
};

type CustomerRegistrationServiceOptions = {
  apiKey: string;
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
    alias: `${productName} ${version}`,
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncPromise: Promise<void> | null = null;

  constructor(private readonly options: CustomerRegistrationServiceOptions) {
    this.request = options.fetch ?? mainProcessFetch;
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.syncIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  sync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.syncCustomer().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async syncCustomer(): Promise<void> {
    try {
      const payload = await readCustomerPayload(
        this.options.userInfoPath,
        this.options.productName,
        this.options.version,
      );
      if (!payload) {
        console.warn('[CustomerRegistration] Skipped sync because user_id is unavailable.');
        return;
      }

      const apiBaseUrl = buildCustomerApiBaseUrl(this.options.baseUrl);
      const updateResponse = await this.post(`${apiBaseUrl}/customer/update`, payload);
      if (updateResponse.ok) {
        console.log('[CustomerRegistration] Customer information updated.');
        return;
      }
      if (updateResponse.status !== 404) {
        console.warn(
          `[CustomerRegistration] Customer update rejected: status=${updateResponse.status}.`,
        );
        return;
      }

      const createResponse = await this.post(`${apiBaseUrl}/customer/new`, payload);
      if (!createResponse.ok) {
        console.warn(
          `[CustomerRegistration] Customer creation rejected: status=${createResponse.status}.`,
        );
        return;
      }
      console.log('[CustomerRegistration] Customer information created.');
    } catch {
      console.warn('[CustomerRegistration] Customer sync failed.');
    }
  }

  private post(url: string, payload: CustomerPayload): Promise<Response> {
    return this.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}
