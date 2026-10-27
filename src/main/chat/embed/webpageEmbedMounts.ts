import type { WebContents } from 'electron';

import {
  isWebpageEmbedMountId,
  WEBPAGE_EMBED_PAGE,
  type WebpageEmbedMount,
  type WebpageEmbedRequest,
} from '../../../shared/browser/webpageEmbed';
import type { createWebpageEmbedGuests } from '../../core/window/webpageEmbedGuest';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { createHostedCanvasForwarder } from './hostedCanvasForwarder';
import type { HostedCanvasBinding } from './hostedCanvasSurface';
import { captureWebpageEmbedSession } from './webpageEmbedSessions';

export type WebpageEmbedConnection = {
  client: GatewayClientLike;
  gatewayOrigin: string;
  canvas: HostedCanvasBinding | null;
  isCurrent: () => boolean;
};

type Target =
  { kind: 'hosted'; documentId: string; entryPath: string } | { kind: 'web'; url: string };
const documentIdValid = (value: string) =>
  /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/u.test(value) && value !== '.' && value !== '..';

/** URL wins over ref; a rejected explicit URL cannot borrow another identity. */
export function resolveWebpageEmbedTarget(
  input: Pick<WebpageEmbedRequest, 'url' | 'ref'>,
  gatewayOrigin: string,
): Target {
  const raw =
    input.url !== undefined
      ? input.url
      : documentIdValid(input.ref ?? '')
        ? `/__openclaw__/canvas/documents/${input.ref}/index.html`
        : '';
  if (typeof raw !== 'string' || !raw || raw.length > 8192 || /[\\\u0000-\u0020\u007f]/u.test(raw))
    throw new Error('Invalid webpage target');
  const relative = raw.startsWith('/') && !raw.startsWith('//');
  const url = new URL(raw, relative ? gatewayOrigin : undefined);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid webpage target');
  if (relative || url.origin === gatewayOrigin) {
    if (url.search || url.hash || /%/u.test(raw) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(raw))
      throw new Error('Invalid hosted document');
    const match = /^\/__openclaw__\/canvas\/documents\/([^/]+)\/(.+)$/u.exec(url.pathname);
    if (
      !match ||
      !documentIdValid(match[1]) ||
      match[2]
        .split('/')
        .some(segment => !/^[A-Za-z0-9_.-]+$/u.test(segment) || segment === '.' || segment === '..')
    )
      throw new Error('Invalid hosted document');
    return { kind: 'hosted', documentId: match[1], entryPath: match[2] };
  }
  return { kind: 'web', url: url.href };
}

export function createWebpageEmbedMounts(options: {
  owner: WebContents;
  guests: ReturnType<typeof createWebpageEmbedGuests>;
  getConnection: () => WebpageEmbedConnection | null;
}) {
  const mounts = new Map<string, { release: () => void }>();
  const pending = new Map<string, { release: () => void }>();
  let disposed = false;
  return {
    async prepare(input: WebpageEmbedRequest): Promise<WebpageEmbedMount> {
      if (
        !input ||
        !isWebpageEmbedMountId(input.mountId) ||
        typeof input.sessionKey !== 'string' ||
        !input.sessionKey.trim() ||
        input.sessionKey.length > 2048 ||
        (input.sessionId !== undefined &&
          (typeof input.sessionId !== 'string' ||
            !input.sessionId ||
            input.sessionId.length > 256)) ||
        disposed ||
        mounts.has(input.mountId) ||
        pending.has(input.mountId) ||
        mounts.size + pending.size >= 64
      )
        throw new Error('Invalid webpage mount');
      const ownerUrl = options.owner.getURL();
      const shell = new URL(WEBPAGE_EMBED_PAGE, ownerUrl);
      if (!['http:', 'https:'].includes(shell.protocol))
        throw new Error('Webpage viewer unavailable');
      shell.searchParams.set('mount', input.mountId);
      const connection = options.getConnection();
      if (!connection?.isCurrent()) throw new Error('Gateway is unavailable');
      const target = resolveWebpageEmbedTarget(input, connection.gatewayOrigin);
      const session = captureWebpageEmbedSession(
        connection.client,
        input.sessionKey,
        input.sessionId,
      );
      const isCurrent = () =>
        !disposed &&
        session.isCurrent() &&
        !options.owner.isDestroyed() &&
        options.owner.getURL() === ownerUrl &&
        connection.isCurrent();
      const preparation = { release: session.release };
      pending.set(input.mountId, preparation);
      const isPending = () => pending.get(input.mountId) === preparation;
      let forwarder: Awaited<ReturnType<typeof createHostedCanvasForwarder>> | undefined;
      try {
        const resolved = await connection.client.request<{ ok?: boolean; key?: string }>(
          'sessions.resolve',
          {
            ...(input.sessionId ? { sessionId: input.sessionId } : { key: input.sessionKey }),
            allowMissing: true,
            includeUnknown: true,
          },
        );
        if (
          !isCurrent() ||
          !isPending() ||
          resolved.ok !== true ||
          resolved.key !== input.sessionKey
        )
          throw new Error('Conversation is unavailable');
        const described = await connection.client.request<{ session?: unknown }>(
          'sessions.describe',
          { key: input.sessionKey },
        );
        if (!isCurrent() || !isPending() || !session.bind(described.session))
          throw new Error('Conversation changed');
        if (target.kind === 'web') {
          // Native config.get resolves JSON5/includes; the root file is not a
          // second policy authority. Read through this exact live connection.
          const snapshot = await connection.client.request<{
            valid?: boolean;
            config?: { gateway?: { controlUi?: { allowExternalEmbedUrls?: boolean } } };
          }>('config.get', {});
          if (
            !isCurrent() || !isPending() || snapshot?.valid !== true ||
            snapshot.config?.gateway?.controlUi?.allowExternalEmbedUrls !== true
          )
            throw new Error('External webpage embedding is disabled');
        }
        if (target.kind === 'hosted') {
          if (!connection.canvas?.isCurrent())
            throw new Error('Hosted document service is unavailable');
          forwarder = await createHostedCanvasForwarder({
            documentId: target.documentId,
            entryPath: target.entryPath,
            binding: connection.canvas,
            isMountCurrent: () =>
              isCurrent() && (isPending() || mounts.has(input.mountId)),
          });
        }
        if (!isCurrent() || !isPending())
          throw new Error('Webpage mount superseded');
        let stopSession = () => {};
        const close = () => {
          stopSession();
          session.release();
          mounts.delete(input.mountId);
          void forwarder?.close();
        };
        const result = options.guests.registerMount({
          mountId: input.mountId,
          owner: options.owner,
          shellUrl: shell.href,
          targetUrl: target.kind === 'web' ? target.url : forwarder!.entryUrl,
          shareBrowserSession: target.kind === 'web',
          gatewayOrigin: connection.gatewayOrigin,
          isCurrent,
          ...(forwarder
            ? {
                allowsHostedRequest: forwarder.isAllowedUrl,
                hostedRequestHeaders: forwarder.requestHeaders,
              }
            : {}),
          dispose: close,
        });
        mounts.set(input.mountId, {
          release: () => options.guests.release(options.owner, input.mountId),
        });
        stopSession = session.onRetired(() => {
          options.guests.release(options.owner, input.mountId);
          mounts.delete(input.mountId);
          void forwarder?.close();
        });
        return { mountId: input.mountId, partition: result.partition, viewerUrl: result.viewerUrl ?? shell.href };
      } catch {
        session.release();
        await forwarder?.close();
        // Do not return transport errors containing native capability URLs.
        throw new Error('Webpage viewer unavailable');
      } finally {
        if (isPending()) pending.delete(input.mountId);
      }
    },
    release(mountId: string): void {
      pending.get(mountId)?.release();
      pending.delete(mountId);
      mounts.get(mountId)?.release();
      mounts.delete(mountId);
    },
    dispose(): void {
      disposed = true;
      for (const preparation of pending.values()) preparation.release();
      pending.clear();
      for (const mount of mounts.values()) mount.release();
      mounts.clear();
    },
  };
}
