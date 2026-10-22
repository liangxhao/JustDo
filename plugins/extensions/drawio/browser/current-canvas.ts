import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';

import {
  type DiagramSnapshot,
  DRAWIO_APPLY_TOOL,
  DRAWIO_CANVAS_EVENT,
  DRAWIO_SNAPSHOT_TOOL,
  type PreparedDiagramCanvas,
} from '../contracts';

type Source = {
  serverName: string;
  toolName: string;
  uiResourceUri: string;
  originSessionKey: string;
};
interface CanvasHost {
  source: Readonly<Source>;
  viewId: () => string;
  diagramId: string;
  bridge: AppBridge;
  current: () => boolean;
  priority: () => number;
  request: <T>(input: Record<string, unknown>) => Promise<T>;
  release: (token: string) => Promise<unknown>;
  subscribe: (listener: (event: { event: string }) => void) => () => void;
  onSuspend: (listener: () => void) => () => void;
  register: (prepare: () => Promise<PreparedDiagramCanvas & { priority: number }>) => () => void;
}
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
function readSnapshot(value: unknown, diagramId: string): DiagramSnapshot {
  const item = object(value);
  if (
    item.diagramId !== diagramId ||
    typeof item.xml !== 'string' ||
    new TextEncoder().encode(item.xml).length > 1024 * 1024 ||
    typeof item.title !== 'string' ||
    typeof item.contentStamp !== 'string' ||
    item.contentStamp.length > 128
  )
    throw new Error('Invalid diagram snapshot');
  return item as unknown as DiagramSnapshot;
}

/** Browser-only plugin adapter; the host supplies the already-admitted native identity. */
export function connectCurrentDiagram(host: CanvasHost) {
  let token = '';
  let retiredToken = '';
  let retireOnPrepare = false;
  let epoch = 0;
  let disposed = false;
  let polling = false;
  const current = () => !disposed && host.current();
  const retire = () => {
    epoch++;
    retireOnPrepare = true;
    if (token) retiredToken = token;
    token = '';
    // Exact-owner cleanup also cancels preparations whose response was lost.
    void host.release('').catch(() => undefined);
  };
  const stopSuspension = host.onSuspend(retire);
  const unregister = host.register(async () => {
    const revision = epoch;
    const unchanged = () => current() && revision === epoch;
    if (!current()) throw new Error('Diagram editor unavailable');
    const result = await host.bridge.callTool({ name: DRAWIO_SNAPSHOT_TOOL, arguments: {} });
    if (!unchanged() || result.isError) throw new Error('Could not prepare diagram');
    const snapshot = readSnapshot(result.structuredContent, host.diagramId);
    const prepared = await host.request<{ token: string }>({
      action: 'prepare',
      source: host.source,
      snapshot,
      token: token || retiredToken,
      retire: retireOnPrepare,
    });
    if (!unchanged() || typeof prepared.token !== 'string') {
      if (typeof prepared.token === 'string')
        void host.release(prepared.token).catch(() => undefined);
      throw new Error('Diagram preparation changed');
    }
    token = prepared.token;
    retiredToken = '';
    retireOnPrepare = false;
    return { token, viewId: host.viewId(), selected: false, priority: host.priority() };
  });
  const poll = async () => {
    if (!token || !current() || polling) return;
    const revision = epoch;
    const activeToken = token;
    const unchanged = () => current() && revision === epoch && token === activeToken;
    polling = true;
    try {
      const result = await host.request<{ operation: Record<string, unknown> | null }>({
        action: 'next',
        token: activeToken,
      });
      if (!unchanged() || !result.operation) return;
      const operation = result.operation;
      if (operation.diagramId !== host.diagramId || typeof operation.operationId !== 'string')
        return;
      // Readiness/binding are checked again after the authenticated take. The
      // server marks take as dispatched, so failures here are never replayed.
      if (!unchanged()) return;
      const applied = await host.bridge.callTool({ name: DRAWIO_APPLY_TOOL, arguments: operation });
      if (!unchanged() || applied.isError) return;
      const ack = object(applied.structuredContent);
      if (ack.operationId !== operation.operationId) return;
      if (ack.status === 'applied') readSnapshot(ack.snapshot, host.diagramId);
      else if (ack.status !== 'conflict' && ack.status !== 'failed') return;
      await host.request({
        action: 'ack',
        token: activeToken,
        operationId: operation.operationId,
        result: ack,
      });
    } catch {
      /* An unconfirmed dispatch remains unknown; never apply it again. */
    } finally {
      polling = false;
    }
  };
  const unsubscribe = host.subscribe(event => {
    if (event.event === DRAWIO_CANVAS_EVENT) void poll();
  });
  // Notifications are hints. A missed hint can only trigger another authenticated
  // status read; take never returns an already-dispatched operation again.
  const timer = setInterval(() => void poll(), 3000);
  return () => {
    disposed = true;
    retire();
    clearInterval(timer);
    unsubscribe();
    unregister();
    stopSuspension();
  };
}
