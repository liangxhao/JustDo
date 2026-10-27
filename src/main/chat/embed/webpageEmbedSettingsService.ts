import {
  readExternalEmbedUrlsAllowed,
  type WebpageEmbedSettings,
  type WebpageEmbedSettingsErrorCode,
  type WebpageEmbedSettingsResult,
} from '../../../shared/browser/webpageEmbedSettings';
import type { GatewayClientLike } from '../../engine/gateway/types';

type Connection = { client: Pick<GatewayClientLike, 'request'>; isCurrent: () => boolean };
type Request = <T>(method: string, params?: unknown) => Promise<T>;
type Dependencies = {
  getConnection: () => Connection | null;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const errorCode = (error: unknown): WebpageEmbedSettingsErrorCode => {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid webpage embed configuration/i.test(message)) return 'configuration';
  if (/baseHash|config.*changed|revision.*(?:mismatch|conflict)|conflict/i.test(message)) return 'conflict';
  if (/forbidden|unauthorized|permission|scope|not authorized/i.test(message)) return 'forbidden';
  if (/disconnect|not connected|not running|unavailable|timeout|timed out|ENGINE_NOT_READY/i.test(message)) return 'unavailable';
  return 'unknown';
};

/** Native config is the only setting authority; this service never starts a client. */
export class WebpageEmbedSettingsService {
  private writing = false;

  constructor(private readonly deps: Dependencies) {}

  private async result(
    operation: (request: Request) => Promise<WebpageEmbedSettings>,
  ): Promise<WebpageEmbedSettingsResult> {
    try {
      const value = await this.deps.exclusive(async () => {
        const connection = this.deps.getConnection();
        if (!connection?.isCurrent()) throw new Error('Gateway is unavailable');
        const request: Request = async <T>(method: string, params?: unknown): Promise<T> => {
          if (!connection.isCurrent()) throw new Error('Gateway is unavailable');
          const response = await connection.client.request<T>(method, params);
          if (!connection.isCurrent()) throw new Error('Gateway is unavailable');
          return response;
        };
        return operation(request);
      });
      return { success: true, value };
    } catch (error) {
      return { success: false, code: errorCode(error) };
    }
  }

  private async read(request: Request): Promise<WebpageEmbedSettings> {
    const snapshot = await request<{
      config?: unknown; valid?: unknown; hash?: unknown;
      configRevisionHash?: unknown; appliedConfigHash?: unknown;
    }>('config.get', {});
    if (!snapshot || snapshot.valid !== true || !isRecord(snapshot.config) ||
      typeof snapshot.hash !== 'string' || !snapshot.hash.trim()) {
      throw new Error('Invalid webpage embed configuration');
    }
    return {
      allowExternalEmbedUrls: readExternalEmbedUrlsAllowed(snapshot.config),
      revision: snapshot.hash,
      applied: typeof snapshot.configRevisionHash === 'string' && !!snapshot.configRevisionHash &&
        snapshot.configRevisionHash === snapshot.appliedConfigHash,
    };
  }

  getSettings = (): Promise<WebpageEmbedSettingsResult> => this.result(request => this.read(request));

  saveSettings = async (input: unknown): Promise<WebpageEmbedSettingsResult> => {
    if (!isRecord(input) || typeof input.allowExternalEmbedUrls !== 'boolean' ||
      typeof input.revision !== 'string' || !input.revision.trim() || input.revision.length > 1024 ||
      Object.keys(input).some(key => !['allowExternalEmbedUrls', 'revision'].includes(key))) {
      return { success: false, code: 'invalid' };
    }
    if (this.writing) return { success: false, code: 'busy' };
    this.writing = true;
    try {
      return await this.result(async request => {
        await request('config.patch', {
          baseHash: input.revision,
          raw: JSON.stringify({ gateway: { controlUi: { allowExternalEmbedUrls: input.allowExternalEmbedUrls } } }),
        });
        // An uncertain write is never replayed; the user can read current native state.
        const confirmed = await this.read(request);
        if (confirmed.allowExternalEmbedUrls !== input.allowExternalEmbedUrls)
          throw new Error('Webpage embed config changed after saving');
        return confirmed;
      });
    } finally {
      this.writing = false;
    }
  };
}
