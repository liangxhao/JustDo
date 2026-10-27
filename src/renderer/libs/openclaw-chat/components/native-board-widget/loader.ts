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
  grantState: 'none' | 'granted';
  viewGeneration?: string;
  frameUrl?: string;
  sandboxUrl?: string;
};
export type BoardRead = { widget?: BoardWidgetMetadata; lifecycleRevision: string };

export class UnsupportedBoardWidgetError extends Error {
  constructor() {
    super('Unsupported native widget');
    this.name = 'UnsupportedBoardWidgetError';
  }
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
  if (raw.contentKind !== 'html' || raw.contentOwner !== 'html')
    throw new UnsupportedBoardWidgetError();
  const declared = record(raw.declared);
  if (raw.declared !== undefined && !declared) throw new Error('Invalid widget capabilities');
  if (declared?.tools !== undefined && (!Array.isArray(declared.tools) || declared.tools.length))
    throw new UnsupportedBoardWidgetError();
  if (
    declared?.netOrigins !== undefined &&
    (!Array.isArray(declared.netOrigins) || declared.netOrigins.length)
  )
    throw new UnsupportedBoardWidgetError();
  if (
    !Number.isSafeInteger(raw.revision) ||
    Number(raw.revision) < 1 ||
    !nonempty(raw.instanceId) ||
    !['none', 'pending', 'granted', 'rejected'].includes(String(raw.grantState))
  )
    throw new Error('Invalid native widget identity');
  if (raw.grantState !== 'none' && raw.grantState !== 'granted')
    throw new UnsupportedBoardWidgetError();
  const widget: BoardWidgetMetadata = {
    name,
    revision: raw.revision as number,
    instanceId: raw.instanceId,
    grantState: raw.grantState,
  };
  if (raw.frameUrl !== undefined) {
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
    a.grantState === b.grantState,
  );
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
