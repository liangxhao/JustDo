import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { BuiltinModelAuthConfig } from '../../config/builtinModelAuth';
import {
  type BuiltinModelCredential,
  clearActiveBuiltinModelCredential,
  getActiveBuiltinModelCredential,
  getBuiltinModelCredentialRefreshAtSeconds,
  setActiveBuiltinModelCredential,
  setActiveBuiltinModelDevelopmentApiKey,
  validateBuiltinModelCredential,
} from './builtinModelCredential';

const MAX_RESPONSE_BYTES = 32_768;
const EXCHANGE_TIMEOUT_MS = 15_000;

type Login = { mtoken: string; account: string; identity: string };
type Dependencies = {
  userInfoPath: string;
  deviceIdPath: string;
  getConfig: () => BuiltinModelAuthConfig;
  getDevelopmentApiKey?: () => string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
};

const readLogin = (file: string): Login | null => {
  try {
    if (fs.statSync(file).size > 256 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const mtoken = typeof value?.mtoken === 'string' ? value.mtoken.trim() : '';
    const account = typeof value?.['X-User-Account'] === 'string'
      ? value['X-User-Account'].trim() : '';
    if (!mtoken || mtoken.length > 32_768 || !account || account.length > 512) return null;
    return { mtoken, account, identity: createHash('sha256').update(JSON.stringify([mtoken, account])).digest('hex') };
  } catch {
    return null;
  }
};

/** Installation identity, not a hardware fingerprint or proof of device possession. */
export const getOrCreateBuiltinModelDeviceId = (file: string): string => {
  const read = (): string => {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value?.deviceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.deviceId)) {
      throw new Error('Invalid model authentication device identity.');
    }
    return value.deviceId;
  };
  if (fs.existsSync(file)) return read();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deviceId = randomUUID();
  try {
    fs.writeFileSync(file, JSON.stringify({ deviceId }), { flag: 'wx', mode: 0o600 });
    return deviceId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return read();
    throw new Error('Unable to save model authentication device identity.');
  }
};

const readResponse = async (response: Response): Promise<unknown> => {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch((): void => undefined);
    reader.releaseLock();
  }
};

/** Only Main exchanges the login mtoken; neither request nor response is logged. */
export class BuiltinModelTokenExchange {
  private identity: string | null = null;
  private generation = 0;
  private suspendedIdentity: string | null = null;
  private pending: { identity: string; controller: AbortController; promise: Promise<BuiltinModelCredential | null> } | null = null;

  constructor(private readonly dependencies: Dependencies) {}

  invalidate(): void {
    this.generation += 1;
    this.pending?.controller.abort();
    this.pending = null;
    this.identity = null;
    clearActiveBuiltinModelCredential();
  }

  suspend(): void {
    this.suspendedIdentity = readLogin(this.dependencies.userInfoPath)?.identity ?? null;
    this.invalidate();
  }

  resume(): void {
    this.suspendedIdentity = null;
  }

  async refresh(): Promise<BuiltinModelCredential | null> {
    let config: BuiltinModelAuthConfig;
    try {
      config = this.dependencies.getConfig();
    } catch {
      this.invalidate();
      throw new Error('Invalid model authentication configuration.');
    }
    const developmentApiKey = this.dependencies.getDevelopmentApiKey?.() ?? '';
    if (developmentApiKey) {
      const identity = createHash('sha256').update(developmentApiKey).digest('hex');
      if (this.identity !== identity || getActiveBuiltinModelCredential()?.authType !== 'api-key') {
        this.invalidate();
        this.identity = identity;
        return setActiveBuiltinModelDevelopmentApiKey(developmentApiKey);
      }
      return getActiveBuiltinModelCredential();
    }
    const login = readLogin(this.dependencies.userInfoPath);
    if (!login || !config.tokenExchangeUrl) {
      this.invalidate();
      return null;
    }
    if (login.identity === this.suspendedIdentity) return null;
    const identity = JSON.stringify([login.identity, config]);
    if (this.identity !== identity) {
      this.invalidate();
      this.identity = identity;
    }
    if (this.pending?.identity === identity) return this.pending.promise;
    const active = getActiveBuiltinModelCredential();
    if (active && getBuiltinModelCredentialRefreshAtSeconds(active) > Date.now() / 1000) return active;

    const generation = this.generation;
    const controller = new AbortController();
    const promise = this.exchange(login, config, controller.signal, generation);
    this.pending = { identity, controller, promise };
    try {
      return await promise;
    } finally {
      if (this.pending?.promise === promise) this.pending = null;
    }
  }

  private async exchange(login: Login, config: BuiltinModelAuthConfig, signal: AbortSignal, generation: number): Promise<BuiltinModelCredential | null> {
    try {
      const endpoint = new URL(config.tokenExchangeUrl);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
      const requestedAt = Math.floor(Date.now() / 1000);
      const response = await this.dependencies.fetch(endpoint.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          mtoken: login.mtoken,
          deviceId: getOrCreateBuiltinModelDeviceId(this.dependencies.deviceIdPath),
        }),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        await response.body?.cancel().catch((): void => undefined);
        if ([400, 401, 403].includes(response.status) && generation === this.generation) clearActiveBuiltinModelCredential();
        throw new Error();
      }
      const value = await readResponse(response) as Record<string, unknown> | null;
      if (!value || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' ||
        typeof value.expires_in !== 'number' || !Number.isInteger(value.expires_in) || value.expires_in <= 15 ||
        (value.uid !== undefined && value.uid !== login.account)) throw new Error();
      const credential = validateBuiltinModelCredential(value.access_token, login.account, undefined, config.maxJwtLifetimeSeconds);
      if (!credential || credential.expiresAt > requestedAt + value.expires_in + 30) throw new Error();
      // Re-read identity after the request: a late response must not restore a logged-out account.
      if (generation !== this.generation) return null;
      if (readLogin(this.dependencies.userInfoPath)?.identity !== login.identity ||
        JSON.stringify(this.dependencies.getConfig()) !== JSON.stringify(config)) {
        this.invalidate();
        return null;
      }
      setActiveBuiltinModelCredential(credential, config.maxJwtLifetimeSeconds);
      return getActiveBuiltinModelCredential();
    } catch {
      if (generation !== this.generation) return null;
      try {
        if (JSON.stringify(this.dependencies.getConfig()) !== JSON.stringify(config)) this.invalidate();
      } catch {
        this.invalidate();
      }
      // Clear locally expired credentials even when the exchange server is unavailable.
      getActiveBuiltinModelCredential();
      throw new Error('Model authentication token exchange failed.');
    }
  }
}
