import type { WidgetNetworkBinding } from '@shared/widgets/network';

import {
  HTML_PAGE_KIND,
  HTML_PAGE_PLUGIN_KIND,
  HTML_PAGE_RESOURCE,
  HTML_PAGE_SURFACE,
} from '../../../../../../plugins/extensions/widget-kit/document/contracts';
import { BOARD_WIDGET_NAME } from '../../pipeline/native-board';
import {
  MAX_WIDGET_BYTES,
  type NativeWidgetContext,
  resolveNativeSandboxUrl,
} from '../native-widget/host';

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}
export function gatewayOrigin(context: NativeWidgetContext): string {
  const url = new URL(context.client.gatewayUrl);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid Gateway');
  return url.origin;
}
export function boardScope(context: NativeWidgetContext): string {
  if (
    !context.agentId ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(context.agentId) ||
    !context.sessionKey.trim() ||
    context.sessionKey === 'global' ||
    context.sessionKey === `agent:${context.agentId}:global`
  )
    throw new Error('Missing native owner');
  const agent = /^agent:([^:]+):(.+)$/.exec(context.sessionKey);
  if (agent && agent[1] !== context.agentId) throw new Error('Native owner changed');
  return agent ? context.sessionKey : `agent:${context.agentId}:${context.sessionKey}`;
}
export type BoardWidgetMetadata = {
  name: string;
  revision: number;
  instanceId: string;
  grantState: 'none' | 'pending' | 'granted' | 'rejected';
  netOrigins: string[];
  registered: boolean;
  viewGeneration?: string;
  frameUrl?: string;
  sandboxUrl?: string;
};
export type BoardRead = { widget?: BoardWidgetMetadata; lifecycleRevision: string };

export function normalizeOrigins(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid native origins');
  const origins = value.map(raw => {
    if (typeof raw !== 'string') throw new Error('Invalid native origin');
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.origin !== raw || url.username || url.password)
      throw new Error('Invalid native origin');
    return url.origin;
  });
  if (new Set(origins).size !== origins.length) throw new Error('Duplicate native origins');
  return origins.sort();
}
export function readBoardWidget(
  snapshot: unknown,
  context: NativeWidgetContext,
  name: string,
  hostOrigin: string,
): BoardWidgetMetadata | undefined {
  const board = record(snapshot);
  if (board?.sessionKey !== boardScope(context) || !Array.isArray(board.widgets))
    throw new Error('Invalid native board scope');
  const matches = board.widgets.filter(raw => record(raw)?.name === name);
  if (!matches.length) return;
  if (matches.length !== 1 || !BOARD_WIDGET_NAME.test(name))
    throw new Error('Invalid native board');
  const raw = record(matches[0])!;
  const registered =
    raw.contentOwner === 'registered' &&
    raw.contentKind === 'plugin' &&
    raw.registeredContentKind === HTML_PAGE_KIND &&
    raw.pluginKind === HTML_PAGE_PLUGIN_KIND;
  if (!(
    registered ||
    (raw.contentKind === 'html' && raw.contentOwner === 'html')
  ))
    throw new Error('Unsupported native widget');
  const declared = record(raw.declared);
  if (raw.declared !== undefined && !declared) throw new Error('Invalid widget capabilities');
  if (declared?.tools !== undefined && (!Array.isArray(declared.tools) || declared.tools.length))
    throw new Error('Unsupported widget capabilities');
  if (
    !Number.isSafeInteger(raw.revision) ||
    Number(raw.revision) < 1 ||
    !nonempty(raw.instanceId) ||
    !['none', 'pending', 'granted', 'rejected'].includes(String(raw.grantState))
  )
    throw new Error('Invalid native widget identity');
  const netOrigins = normalizeOrigins(declared?.netOrigins);
  if (raw.grantState === 'none' && netOrigins.length) throw new Error('Unapproved native origins');
  const widget: BoardWidgetMetadata = {
    name,
    revision: raw.revision as number,
    instanceId: raw.instanceId,
    grantState: raw.grantState as BoardWidgetMetadata['grantState'],
    netOrigins,
    registered,
  };
  if (
    (widget.grantState === 'none' || widget.grantState === 'granted') &&
    raw.frameUrl !== undefined
  ) {
    if (
      typeof raw.viewGeneration !== 'string' ||
      !/^[a-f0-9]{32}$/.test(raw.viewGeneration) ||
      typeof raw.frameUrl !== 'string'
    )
      throw new Error('Native document unavailable');
    widget.viewGeneration = raw.viewGeneration;
    widget.frameUrl = validateFrameUrl(raw.frameUrl, context, name);
    widget.sandboxUrl = resolveNativeSandboxUrl(raw, context.client.gatewayUrl, hostOrigin);
  }
  return widget;
}
export function validateFrameUrl(raw: string, context: NativeWidgetContext, name: string): string {
  const origin = gatewayOrigin(context);
  const url = new URL(raw, origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !==
      `/__openclaw__/board/${encodeURIComponent(boardScope(context))}/${encodeURIComponent(name)}/index.html` ||
    [...url.searchParams.keys()].length !== 1 ||
    !url.searchParams.has('bt') ||
    !url.searchParams.get('bt')?.trim() ||
    url.searchParams.get('bt')!.length > 2048
  )
    throw new Error('Invalid native document URL');
  return url.href;
}
export async function readCurrentBoard(
  context: NativeWidgetContext,
  name: string,
  hostOrigin: string,
  current: () => boolean,
  expectedRevision?: string,
): Promise<BoardRead> {
  const scope = boardScope(context);
  if (!context.sessionId?.trim() || !current()) throw new Error('Native session unavailable');
  const params = { key: context.sessionKey, agentId: context.agentId };
  const describe = async () => {
    const result = record(await context.client.request('sessions.describe', params));
    const session = record(result?.session);
    if (
      !current() ||
      !session ||
      session.sessionId !== context.sessionId ||
      !nonempty(session.lifecycleRevision) ||
      (session.key !== scope && session.key !== context.sessionKey) ||
      session.agentId !== context.agentId ||
      (expectedRevision !== undefined && session.lifecycleRevision !== expectedRevision)
    )
      throw new Error('Native session changed');
    return session.lifecycleRevision;
  };
  const before = await describe();
  const snapshot = await context.client.request('board.get', {
    sessionKey: context.sessionKey,
    agentId: context.agentId,
  });
  const after = await describe();
  if (!current() || before !== after) throw new Error('Native session changed');
  return {
    widget: readBoardWidget(snapshot, context, name, hostOrigin),
    lifecycleRevision: before,
  };
}
export function networkBinding(
  context: NativeWidgetContext,
  read: BoardRead,
): WidgetNetworkBinding {
  const widget = read.widget;
  if (
    !widget ||
    widget.grantState !== 'granted' ||
    !widget.viewGeneration ||
    !context.agentId ||
    !context.sessionId
  )
    throw new Error('Native widget is not granted');
  return {
    connectionGeneration: context.generation,
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    lifecycleRevision: read.lifecycleRevision,
    name: widget.name,
    revision: widget.revision,
    instanceId: widget.instanceId,
    viewGeneration: widget.viewGeneration,
    grantState: 'granted',
    netOrigins: widget.netOrigins,
  };
}
export function sameBoardIdentity(left: BoardRead, right: BoardRead): boolean {
  const a = left.widget,
    b = right.widget;
  return Boolean(
    a &&
    b &&
    left.lifecycleRevision === right.lifecycleRevision &&
    a.name === b.name &&
    a.revision === b.revision &&
    a.instanceId === b.instanceId &&
    a.viewGeneration === b.viewGeneration &&
    a.grantState === b.grantState &&
    JSON.stringify(a.netOrigins) === JSON.stringify(b.netOrigins),
  );
}
const surfaceRefreshes = new WeakMap<object, { generation: number; pending?: Promise<string[]> }>();

function validateSurface(raw: unknown, context: NativeWidgetContext): URL {
  if (typeof raw !== 'string') throw new Error('Widget HTML resource unavailable');
  const scoped = new URL(raw);
  if (
    scoped.origin !== gatewayOrigin(context) ||
    scoped.username ||
    scoped.password ||
    scoped.search ||
    scoped.hash ||
    !/^\/__openclaw__\/cap\/[A-Za-z0-9_-]{24}$/.test(scoped.pathname)
  )
    throw new Error('Invalid widget surface');
  return scoped;
}

export async function refreshHtmlResources(context: NativeWidgetContext): Promise<string[]> {
  if (!context.methods?.includes('plugin.surface.refresh'))
    throw new Error('Widget HTML resource unavailable');
  // This anchor comes only from this connection's authenticated hello. Passing
  // the same observation lets native reuse an already refreshed, valid surface
  // instead of invalidating another document's in-flight adapter request.
  const observed = validateSurface(context.pluginSurfaceUrls?.[HTML_PAGE_SURFACE], context);
  let state = surfaceRefreshes.get(context.client);
  if (!state || state.generation !== context.generation) {
    state = { generation: context.generation };
    surfaceRefreshes.set(context.client, state);
  }
  if (state.pending) return state.pending;
  const request = (async () => {
    const result = record(
      await context.client.request('plugin.surface.refresh', {
        surface: HTML_PAGE_SURFACE,
        observedUrl: observed.href,
      }),
    );
    if (result?.surface !== HTML_PAGE_SURFACE) throw new Error('Widget HTML resource unavailable');
    const scoped = validateSurface(record(result?.pluginSurfaceUrls)?.[HTML_PAGE_SURFACE], context);
    return [`${scoped.href}${HTML_PAGE_RESOURCE}`];
  })();
  state.pending = request;
  try {
    return await request;
  } finally {
    if (state.pending === request) state.pending = undefined;
  }
}

/** Ticket stays inside this short-lived trusted read, never in viewer state. */
export async function readBoardHtml(
  url: string,
  signal: AbortSignal,
  fetchDocument: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchDocument(url, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal,
  });
  if (response.status === 401)
    throw Object.assign(new Error('Native ticket expired'), { status: 401 });
  if (
    !response.ok ||
    !/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
    !response.body
  )
    throw new Error('Invalid native document');
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_WIDGET_BYTES))
    throw new Error('Native document too large');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_WIDGET_BYTES || signal.aborted)
        throw new Error('Native document too large or cancelled');
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const content = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(content);
}
