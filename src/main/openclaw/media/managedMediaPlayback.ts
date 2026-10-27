import { randomBytes } from 'node:crypto';

import {
  type OpenClawAssistantMediaPlaybackRequest,
  type OpenClawAssistantMediaPlaybackResult,
  type OpenClawAssistantMediaReleaseResult,
  parseManagedOutgoingMediaSource,
} from '../../../shared/openclaw/assistantMedia';
import { EnginePhase } from '../../../shared/openclaw/engineStatus';
import type { OpenClawEngineManager } from '../runtime/openclawEngineManager';

type PlaybackManager = Pick<
  OpenClawEngineManager,
  'getStatus' | 'getGatewayConnectionInfo' | 'getGatewayLifecycleGeneration' |
  'getGatewayProcessGeneration' | 'on' | 'removeListener'
>;
type PlaybackOwner = Electron.WebContents;
type PlaybackFrame = Electron.WebFrameMain;
type PlaybackGrant = OpenClawAssistantMediaPlaybackRequest & {
  owner: PlaybackOwner;
  frame: PlaybackFrame;
  manager: PlaybackManager;
  generation: number;
  processGeneration: number;
  port: number;
  controllers: Set<AbortController>;
};
type OwnerBinding = { grants: Set<string>; stop: () => void };
type ByteRange = { start?: number; end?: number };

const MAX_PLAYBACK_GRANTS = 512;
const MAX_OWNER_PLAYBACK_GRANTS = 256;
const RESPONSE_HEADER_TIMEOUT_MS = 15_000;
const PLAYBACK_URL = /^localmedia:\/\/gateway\/([a-f0-9]{64})$/u;

function readRange(value: string | null): ByteRange | null | false {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : undefined;
  const end = match[2] ? Number(match[2]) : undefined;
  if (
    (start !== undefined && !Number.isSafeInteger(start)) ||
    (end !== undefined && !Number.isSafeInteger(end)) ||
    (start === undefined && !end) ||
    (start !== undefined && end !== undefined && start > end)
  ) return false;
  return { start, end };
}

function unsignedInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** Owns short-lived playback capabilities; the URL never contains Gateway credentials. */
export class ManagedMediaPlayback {
  private readonly grants = new Map<string, PlaybackGrant>();
  private readonly owners = new Map<PlaybackOwner, OwnerBinding>();
  private readonly managers = new Map<PlaybackManager, () => void>();

  constructor(private readonly deps: {
    getManager: () => PlaybackManager;
    isTrustedFrame: (owner: PlaybackOwner, frame: PlaybackFrame) => boolean;
    fetch?: typeof fetch;
  }) {}

  private current(grant: PlaybackGrant): boolean {
    try {
      return !grant.owner.isDestroyed() &&
        grant.owner.mainFrame === grant.frame &&
        this.deps.isTrustedFrame(grant.owner, grant.frame) &&
        this.deps.getManager() === grant.manager &&
        grant.manager.getStatus().phase === EnginePhase.Running &&
        grant.manager.getGatewayProcessGeneration() === grant.processGeneration &&
        grant.manager.getGatewayLifecycleGeneration() === grant.generation;
    } catch {
      return false;
    }
  }

  private revoke(id: string): void {
    const grant = this.grants.get(id);
    if (!grant) return;
    this.grants.delete(id);
    grant.controllers.forEach(controller => controller.abort());
    const binding = this.owners.get(grant.owner);
    binding?.grants.delete(id);
    if (binding?.grants.size === 0) {
      binding.stop();
      this.owners.delete(grant.owner);
    }
    if (![...this.grants.values()].some(item => item.manager === grant.manager)) {
      this.managers.get(grant.manager)?.();
      this.managers.delete(grant.manager);
    }
  }

  private bindOwner(owner: PlaybackOwner): OwnerBinding {
    const existing = this.owners.get(owner);
    if (existing) return existing;
    const revoke = () => {
      const binding = this.owners.get(owner);
      [...(binding?.grants ?? [])].forEach(id => this.revoke(id));
    };
    const navigation = (
      _event: Electron.Event,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean,
    ) => {
      if (mainFrame && !inPlace) revoke();
    };
    const binding: OwnerBinding = {
      grants: new Set(),
      stop: () => {
        owner.removeListener('destroyed', revoke);
        owner.removeListener('render-process-gone', revoke);
        owner.removeListener('did-start-navigation', navigation);
      },
    };
    this.owners.set(owner, binding);
    owner.on('destroyed', revoke);
    owner.on('render-process-gone', revoke);
    owner.on('did-start-navigation', navigation);
    return binding;
  }

  prepare(
    owner: PlaybackOwner,
    frame: PlaybackFrame | null,
    value: unknown,
  ): OpenClawAssistantMediaPlaybackResult {
    if (!frame || !this.deps.isTrustedFrame(owner, frame))
      return { success: false, error: 'Invalid media playback caller' };
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { success: false, error: 'Invalid media playback request' };
    const request = value as Record<string, unknown>;
    if (
      Object.keys(request).some(key => !['source', 'sessionKey', 'kind'].includes(key)) ||
      typeof request.sessionKey !== 'string' ||
      !parseManagedOutgoingMediaSource(request.source, request.sessionKey) ||
      (request.kind !== 'audio' && request.kind !== 'video')
    ) return { success: false, error: 'Invalid media playback request' };
    for (const [id, grant] of this.grants) if (!this.current(grant)) this.revoke(id);
    if (
      this.grants.size >= MAX_PLAYBACK_GRANTS ||
      (this.owners.get(owner)?.grants.size ?? 0) >= MAX_OWNER_PLAYBACK_GRANTS
    ) return { success: false, error: 'Media playback limit reached' };
    const manager = this.deps.getManager();
    const { port, token } = manager.getGatewayConnectionInfo();
    if (
      owner.isDestroyed() || owner.mainFrame !== frame ||
      manager.getStatus().phase !== EnginePhase.Running ||
      !Number.isInteger(port) || port < 1 || port > 65_535 || !token
    ) return { success: false, error: 'Gateway media is unavailable' };
    const id = randomBytes(32).toString('hex');
    this.grants.set(id, {
      source: request.source as string,
      sessionKey: request.sessionKey,
      kind: request.kind,
      owner,
      frame,
      manager,
      port,
      generation: manager.getGatewayLifecycleGeneration(),
      processGeneration: manager.getGatewayProcessGeneration(),
      controllers: new Set(),
    });
    this.bindOwner(owner).grants.add(id);
    if (!this.managers.has(manager)) {
      const changed = () => {
        for (const [key, grant] of this.grants)
          if (grant.manager === manager && !this.current(grant)) this.revoke(key);
      };
      manager.on('status', changed);
      this.managers.set(manager, () => manager.removeListener('status', changed));
    }
    return { success: true, url: `localmedia://gateway/${id}` };
  }

  release(owner: PlaybackOwner, frame: PlaybackFrame | null, value: unknown): OpenClawAssistantMediaReleaseResult {
    if (!frame || !this.deps.isTrustedFrame(owner, frame) ||
      !value || typeof value !== 'object' || Array.isArray(value)) return { success: false };
    const request = value as Record<string, unknown>;
    if (Object.keys(request).some(key => key !== 'url') || typeof request.url !== 'string')
      return { success: false };
    const id = PLAYBACK_URL.exec(request.url)?.[1];
    const grant = id ? this.grants.get(id) : undefined;
    if (!id || !grant || grant.owner !== owner || grant.frame !== frame) return { success: false };
    this.revoke(id);
    return { success: true };
  }

  /** protocol.handle lacks request frame identity; the session WebRequest owner checks it first. */
  authorize(details: Pick<Electron.OnBeforeRequestListenerDetails, 'url' | 'webContentsId' | 'webContents' | 'frame'>): boolean {
    const id = PLAYBACK_URL.exec(details.url)?.[1];
    const grant = id ? this.grants.get(id) : undefined;
    if (!id || !grant) return false;
    if (!this.current(grant)) {
      this.revoke(id);
      return false;
    }
    return details.webContentsId === grant.owner.id &&
      (details.webContents === undefined || details.webContents === grant.owner) &&
      details.frame === grant.frame;
  }

  async respond(request: Request): Promise<Response> {
    const id = PLAYBACK_URL.exec(request.url)?.[1];
    const grant = id ? this.grants.get(id) : undefined;
    if (!id || !grant || !this.current(grant)) {
      if (id) this.revoke(id);
      return new Response(null, { status: 404 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    // Native Gateway follows HTTP semantics: Range only applies to GET, not HEAD.
    const range = request.method === 'GET' ? readRange(request.headers.get('Range')) : null;
    if (range === false) return new Response(null, { status: 416 });
    const controller = new AbortController();
    grant.controllers.add(controller);
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    let cancelReader: (() => void) | undefined;
    const cleanup = () => {
      grant.controllers.delete(controller);
      request.signal.removeEventListener('abort', abort);
      if (cancelReader) controller.signal.removeEventListener('abort', cancelReader);
    };
    const headerTimeout = setTimeout(abort, RESPONSE_HEADER_TIMEOUT_MS);
    const active = () => this.grants.get(id) === grant && this.current(grant) && !controller.signal.aborted;
    let response: Response | undefined;
    try {
      const { port, token } = grant.manager.getGatewayConnectionInfo();
      if (port !== grant.port || !token || request.signal.aborted) throw new Error('Playback expired');
      response = await (this.deps.fetch ?? fetch)(`http://127.0.0.1:${grant.port}${grant.source}`, {
        method: request.method,
        headers: {
          Accept: `${grant.kind}/*`,
          Authorization: `Bearer ${token}`,
          'x-openclaw-requester-session-key': grant.sessionKey,
          ...(range ? { Range: request.headers.get('Range')! } : {}),
        },
        redirect: 'error',
        signal: controller.signal,
      });
      clearTimeout(headerTimeout);
      if (!active()) throw new Error('Playback expired');
      const headers = new Headers({
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (response.status === 416) {
        const match = /^bytes \*\/(\d+)$/u.exec(response.headers.get('content-range') ?? '');
        const size = unsignedInteger(match?.[1] ?? null);
        if (!range || size === null || range.start === undefined || range.start < size)
          throw new Error('Invalid media range response');
        headers.set('Content-Range', `bytes */${size}`);
        await response.body?.cancel();
        if (!active()) throw new Error('Playback expired');
        cleanup();
        return new Response(null, { status: 416, headers });
      }
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      const length = unsignedInteger(response.headers.get('content-length'));
      if (!mime.startsWith(`${grant.kind}/`) || length === null ||
        (range ? response.status !== 206 : response.status !== 200))
        throw new Error('Invalid media playback response');
      headers.set('Content-Type', mime);
      headers.set('Content-Length', String(length));
      headers.set('Accept-Ranges', 'bytes');
      if (range) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') ?? '');
        const start = unsignedInteger(match?.[1] ?? null);
        const end = unsignedInteger(match?.[2] ?? null);
        const total = unsignedInteger(match?.[3] ?? null);
        if (start === null || end === null || total === null || start > end || end >= total ||
          length !== end - start + 1 ||
          start !== (range.start ?? Math.max(0, total - range.end!)) ||
          end !== (range.start === undefined || range.end === undefined ? total - 1 : Math.min(range.end, total - 1)))
          throw new Error('Invalid media range response');
        headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
      }
      if (request.method === 'HEAD') {
        await response.body?.cancel();
        if (!active()) throw new Error('Playback expired');
        cleanup();
        return new Response(null, { status: response.status, headers });
      }
      if (!response.body) throw new Error('Empty media playback response');
      const reader = response.body.getReader();
      cancelReader = () => { void reader.cancel().catch((): undefined => undefined); };
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      let received = 0;
      const body = new ReadableStream<Uint8Array>({
        pull: async stream => {
          try {
            if (!active()) throw new Error('Playback expired');
            const chunk = await reader.read();
            if (!active()) throw new Error('Playback expired');
            if (chunk.done) {
              if (received !== length) throw new Error('Incomplete media response');
              cleanup();
              stream.close();
            } else {
              received += chunk.value.byteLength;
              if (received > length) throw new Error('Invalid media response length');
              stream.enqueue(chunk.value);
            }
          } catch {
            controller.abort();
            await reader.cancel().catch((): undefined => undefined);
            cleanup();
            stream.error(new Error('Media playback is unavailable'));
          }
        },
        cancel: async () => {
          controller.abort();
          await reader.cancel().catch((): undefined => undefined);
          cleanup();
        },
      });
      return new Response(body, { status: response.status, headers });
    } catch {
      controller.abort();
      await response?.body?.cancel().catch((): undefined => undefined);
      cleanup();
      return new Response(null, { status: 502 });
    } finally {
      clearTimeout(headerTimeout);
    }
  }
}
