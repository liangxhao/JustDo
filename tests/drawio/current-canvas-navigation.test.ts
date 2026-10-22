import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ dispatch: vi.fn(), entry: vi.fn() }));
vi.mock('openclaw/plugin-sdk/gateway-method-runtime', () => ({
  dispatchGatewayMethod: sdk.dispatch,
}));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({ getSessionEntry: sdk.entry }));

import { connectCurrentDiagram } from '../../plugins/extensions/drawio/browser/current-canvas';
import { DRAWIO_CANVAS_METHOD } from '../../plugins/extensions/drawio/contracts';
import { registerDiagramEditing } from '../../plugins/extensions/drawio/editing';
import type {
  GatewayClient,
  GatewayRequestOptions,
} from '../../src/renderer/libs/openclaw-chat/gateway/client';
import { McpAppSession } from '../../src/renderer/libs/openclaw-chat/gateway/mcp-app/mcp-app-session';

const scope = { sessionKey: 'agent:main:canvas', sessionId: 'physical', agentId: 'main' };
const snapshot = {
  diagramId: 'diagram-one',
  xml: '<mxGraphModel><root/></mxGraphModel>',
  title: 'Current',
  contentStamp: 'base',
};
const source = {
  serverName: 'drawio',
  toolName: 'open_editor',
  uiResourceUri: 'ui://drawio/editor',
  originSessionKey: scope.sessionKey,
};
type Handler = (request: Record<string, unknown>) => Promise<void>;
let handler: Handler;
let service: { start: (context: unknown) => void; stop: () => void };
const cleanups: Array<() => void> = [];

beforeEach(() => {
  sdk.entry.mockReturnValue({ sessionId: scope.sessionId, lifecycleRevision: 'same-incarnation' });
  sdk.dispatch.mockImplementation(async (method, params) => {
    if (method === 'chat.history') return { ok: true, payload: scope };
    if (method === 'mcp.app.view')
      return { ok: true, payload: { toolResult: { structuredContent: snapshot } } };
    if (method === 'mcp.app.readResource')
      return {
        ok: true,
        payload: {
          contents: [
            {
              uri: params.uri,
              text: JSON.stringify({ diagramId: snapshot.diagramId, toolName: 'open_editor' }),
            },
          ],
        },
      };
    throw new Error('Unexpected method');
  });
  registerDiagramEditing({
    runtime: { config: { current: () => ({ mcp: { apps: { enabled: true } } }) } },
    registerService: (value: typeof service) => {
      service = value;
    },
    registerTool: () => {},
    registerGatewayMethod: (name: string, value: Handler) => {
      if (name === DRAWIO_CANVAS_METHOD) handler = value;
    },
  } as never);
  service.start({});
});
afterEach(() => {
  cleanups.splice(0).forEach(dispose => dispose());
  service.stop();
  vi.clearAllMocks();
});

async function fixture(holdFirstPrepareResponse = false) {
  const backend: Promise<void>[] = [];
  let held = false;
  const request = vi.fn(
    (method: string, params: unknown, options?: GatewayRequestOptions): Promise<unknown> => {
      if (method !== DRAWIO_CANVAS_METHOD) return Promise.resolve({});
      // Match the actual client: local cancellation rejects the wait while the
      // native handler keeps running without per-request backend cancellation.
      return new Promise((resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(new Error('Local request aborted')),
          { once: true },
        );
        backend.push(
          handler({
            params,
            client: { connId: 'original-connection' },
            hasCurrentClientAuthority: () => true,
            respond: (ok: boolean, payload: unknown) => {
              if (
                ok &&
                holdFirstPrepareResponse &&
                !held &&
                (params as { action?: string }).action === 'prepare'
              ) {
                held = true;
                return;
              }
              ok ? resolve(payload) : reject(new Error('RPC unavailable'));
            },
          }),
        );
      });
    },
  );
  const client = {
    generation: 1,
    gatewayUrl: 'ws://127.0.0.1:1',
    request,
    subscribeEvents: () => () => {},
  } as unknown as GatewayClient;
  const apps = new McpAppSession(() => ({
    ...scope,
    client,
    generation: 1,
    isCurrent: () => true,
  }));
  const attach = async (viewId: string) => {
    const view = apps.bind(viewId);
    await view.view();
    view.preservePresentation = true;
    let prepare!: () => Promise<unknown>;
    const stop = connectCurrentDiagram({
      source,
      viewId: () => viewId,
      diagramId: snapshot.diagramId,
      bridge: { callTool: async () => ({ structuredContent: snapshot }) } as never,
      current: () => view.isCurrent(),
      priority: () => 2,
      request: input => view.diagramRequest(input),
      release: token => view.releaseDiagram(token),
      onSuspend: listener => view.onSuspend(listener),
      subscribe: listener => view.subscribe(listener),
      register: callback => {
        prepare = callback;
        return apps.registerCanvasPreparation(viewId, callback, () => view.isCurrent());
      },
    });
    cleanups.push(stop);
    return { view, prepare: () => prepare() };
  };
  return { apps, attach, backend, held: () => held };
}

describe('actual session cancellation with background draw.io preparation', () => {
  it.each(['resume', 'reopen'])(
    'cleans a binding created before its response was lost, then can %s',
    async action => {
      const { apps, attach, backend, held } = await fixture(true);
      const original = await attach('mcp-app-original');
      const pending = original.prepare();
      const rejected = expect(pending).rejects.toThrow('aborted');
      await vi.waitFor(() => expect(held()).toBe(true));
      apps.invalidate(true);
      await rejected;
      await Promise.all(backend);
      if (action === 'resume') {
        expect(apps.resume(original.view)).toBe(true);
        await expect(original.prepare()).resolves.toHaveProperty('token');
      } else {
        await original.view.close();
        await Promise.all(backend);
        const reopened = await attach('mcp-app-reopened');
        await expect(reopened.prepare()).resolves.toHaveProperty('token');
      }
    },
  );

  it.each(['resume', 'reopen'])(
    'retires an unreceived prepare and can %s after the backend completes',
    async action => {
      const { apps, attach, backend } = await fixture();
      const original = await attach('mcp-app-original');
      let finish!: () => void;
      let blocked = false;
      const dispatch = sdk.dispatch.getMockImplementation()!;
      sdk.dispatch.mockImplementation(async (method, params) => {
        if (method === 'mcp.app.view' && !blocked) {
          blocked = true;
          await new Promise<void>(resolve => {
            finish = resolve;
          });
        }
        return dispatch(method, params);
      });
      const pending = original.prepare();
      const rejected = expect(pending).rejects.toThrow('aborted');
      await vi.waitFor(() => expect(blocked).toBe(true));
      apps.invalidate(true);
      await rejected;
      finish();
      await Promise.all(backend);
      if (action === 'resume') {
        expect(apps.resume(original.view)).toBe(true);
        await expect(original.prepare()).resolves.toHaveProperty('token');
      } else {
        await original.view.close();
        await Promise.all(backend);
        const reopened = await attach('mcp-app-reopened');
        await expect(reopened.prepare()).resolves.toHaveProperty('token');
      }
    },
  );
});
