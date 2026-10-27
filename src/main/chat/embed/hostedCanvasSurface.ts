import type { GatewayClientLike } from '../../engine/gateway/types';
import { canonicalHostedCanvasResource } from './hostedCanvasPaths';

const CANVAS_SURFACE = 'canvas';
const REFRESH_METHOD = 'plugin.surface.refresh';
const REFRESH_TIMEOUT_MS = 10_000;
const RENEWAL_LEAD_MS = 15_000;
const UNKNOWN_EXPIRY_MS = 60_000;

/** Main-only authenticated transport. Never serialize this object or its URLs. */
export interface HostedCanvasBinding {
  readonly gatewayOrigin: string;
  readonly generation: number;
  readonly profileId: string;
  isCurrent(): boolean;
  getResourceUrl(canonicalPath: string): Promise<URL>;
  onRetired(listener: () => void): () => void;
}

interface SurfaceRegistration {
  client: GatewayClientLike;
  generation: number;
  profileId: string;
  gatewayUrl: string | null;
  hello: unknown;
  isCurrent(): boolean;
}

function canvasUrlFrom(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const surfaces = (value as { pluginSurfaceUrls?: unknown }).pluginSurfaceUrls;
  if (!surfaces || typeof surfaces !== 'object') return null;
  const canvas = (surfaces as { canvas?: unknown }).canvas;
  return typeof canvas === 'string' ? canvas : null;
}

function gatewayHttpOrigin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      !['ws:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      url.hostname !== '127.0.0.1'
    )
      return null;
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    return url.origin;
  } catch {
    return null;
  }
}

function validateSurfaceUrl(raw: string | null, gatewayOrigin: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      url.origin !== gatewayOrigin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/__openclaw__\/cap\/[A-Za-z0-9_-]{16,256}$/.test(url.pathname)
    )
      return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

class HostedCanvasSurfaceLease implements HostedCanvasBinding {
  readonly gatewayOrigin: string;
  readonly generation: number;
  readonly profileId: string;
  private surfaceUrl: string;
  private expiresAtMs = 0;
  private refresh: Promise<void> | null = null;
  private retired = false;
  private readonly retiredListeners = new Set<() => void>();

  constructor(
    private readonly registration: SurfaceRegistration,
    origin: string,
    surfaceUrl: string,
  ) {
    this.gatewayOrigin = origin;
    this.generation = registration.generation;
    this.profileId = registration.profileId;
    this.surfaceUrl = surfaceUrl;
  }

  isCurrent(): boolean {
    if (!this.retired && !this.registration.isCurrent()) this.retire();
    return !this.retired;
  }

  onRetired(listener: () => void): () => void {
    if (!this.isCurrent()) {
      listener();
      return () => {};
    }
    this.retiredListeners.add(listener);
    return () => {
      this.retiredListeners.delete(listener);
    };
  }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.surfaceUrl = '';
    for (const listener of this.retiredListeners) {
      try {
        listener();
      } catch {
        /* Retirement cannot prevent other owners from retiring. */
      }
    }
    this.retiredListeners.clear();
  }

  async getResourceUrl(canonicalPath: string): Promise<URL> {
    if (!this.isCurrent()) throw new Error('Hosted document connection is unavailable.');
    const documentId = /^\/__openclaw__\/canvas\/documents\/([^/]+)\//.exec(canonicalPath)?.[1];
    if (!documentId || canonicalHostedCanvasResource(canonicalPath, documentId) !== canonicalPath) {
      throw new Error('Hosted document path is invalid.');
    }
    if (Date.now() + RENEWAL_LEAD_MS >= this.expiresAtMs) await this.renew();
    if (!this.isCurrent()) throw new Error('Hosted document connection is unavailable.');
    return new URL(`${this.surfaceUrl}${canonicalPath}`);
  }

  private async renew(): Promise<void> {
    if (this.refresh) return this.refresh;
    const observedUrl = this.surfaceUrl;
    const pending = Promise.resolve()
      .then(async () => {
        let response: unknown;
        try {
          response = await this.registration.client.request(
            REFRESH_METHOD,
            { surface: CANVAS_SURFACE, observedUrl },
            { timeoutMs: REFRESH_TIMEOUT_MS },
          );
        } catch {
          throw new Error('Hosted document authorization is unavailable.');
        }
        if (
          !this.isCurrent() ||
          this.surfaceUrl !== observedUrl ||
          !response ||
          typeof response !== 'object'
        ) {
          throw new Error('Hosted document authorization is unavailable.');
        }
        const result = response as { surface?: unknown; expiresAtMs?: unknown };
        const nextUrl = validateSurfaceUrl(canvasUrlFrom(response), this.gatewayOrigin);
        const expiresAtMs =
          result.expiresAtMs === undefined ? Date.now() + UNKNOWN_EXPIRY_MS : result.expiresAtMs;
        if (
          result.surface !== CANVAS_SURFACE ||
          !nextUrl ||
          typeof expiresAtMs !== 'number' ||
          !Number.isSafeInteger(expiresAtMs) ||
          expiresAtMs <= Date.now()
        ) {
          throw new Error('Hosted document authorization is unavailable.');
        }
        this.surfaceUrl = nextUrl;
        this.expiresAtMs = expiresAtMs;
      })
      .finally(() => {
        if (this.refresh === pending) this.refresh = null;
      });
    this.refresh = pending;
    return pending;
  }
}

const surfaces = new WeakMap<GatewayClientLike, HostedCanvasSurfaceLease>();

export function rememberHostedCanvasSurface(registration: SurfaceRegistration): void {
  retireHostedCanvasSurface(registration.client);
  const origin = gatewayHttpOrigin(registration.gatewayUrl);
  const surfaceUrl = origin ? validateSurfaceUrl(canvasUrlFrom(registration.hello), origin) : null;
  if (!origin || !surfaceUrl || !registration.profileId || !registration.isCurrent()) return;
  surfaces.set(registration.client, new HostedCanvasSurfaceLease(registration, origin, surfaceUrl));
}

export function retireHostedCanvasSurface(client: GatewayClientLike | null): void {
  if (!client) return;
  surfaces.get(client)?.retire();
  surfaces.delete(client);
}

/** Does not connect, launch, or restart Gateway. Only the accepted hello grants a binding. */
export function captureHostedCanvasBinding(
  client: GatewayClientLike | null,
  generation: number,
  profileId: string,
): HostedCanvasBinding | null {
  const binding = client ? surfaces.get(client) : null;
  return binding &&
    binding.generation === generation &&
    binding.profileId === profileId &&
    binding.isCurrent()
    ? binding
    : null;
}
