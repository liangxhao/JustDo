import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ dispatch: vi.fn(), entry: vi.fn() }));
vi.mock('openclaw/plugin-sdk/gateway-method-runtime', () => ({
  dispatchGatewayMethod: sdk.dispatch,
}));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({ getSessionEntry: sdk.entry }));

import type {
  GatewayClient,
  GatewayEventFrame,
  GatewayRequestOptions,
} from '@/libs/openclaw-chat/gateway/client';
import { McpAppSession } from '@/libs/openclaw-chat/gateway/mcp-app/mcp-app-session';
import { registerMcpAppAdapter } from '@/libs/openclaw-chat/pipeline/mcp-app-adapters';

import { mcpAppAdapter } from '../../../../plugins/extensions/drawio/browser/mcp-app-adapter';
import {
  DRAWIO_APPLY_TOOL,
  DRAWIO_CANVAS_EVENT,
  DRAWIO_CANVAS_METHOD,
  DRAWIO_CURRENT_METHOD,
  DRAWIO_SNAPSHOT_TOOL,
} from '../../../../plugins/extensions/drawio/contracts';
import { registerDiagramEditing } from '../../../../plugins/extensions/drawio/editing';

const editorResource = { html: 'editor', sandboxUrl: '/sandbox', sandboxPort: 1234 };
const scope = { sessionKey: 'agent:main:canvas', sessionId: 'physical', agentId: 'main' };
const snapshot = {
  diagramId: 'diagram-one',
  xml: '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>',
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
type DiagramTool = {
  prepareBeforeToolCallParams: (
    params: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ) => unknown;
  execute: (
    callId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
};
let handlers: Map<string, Handler>;
let factory: { create: (context: Record<string, unknown>) => DiagramTool };
let service: { start: (context: unknown) => void; stop: () => void };
let listeners: Set<(event: GatewayEventFrame) => void>;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  cleanups.push(registerMcpAppAdapter(mcpAppAdapter));
  handlers = new Map();
  listeners = new Set();
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
    if (method === 'chat.send') return { ok: true, payload: { runId: params.idempotencyKey } };
    throw new Error('Unexpected method');
  });
  registerDiagramEditing({
    runtime: { config: { current: () => ({ mcp: { apps: { enabled: true } } }) } },
    registerService: (value: typeof service) => {
      service = value;
    },
    registerTool: (value: typeof factory) => {
      factory = value;
    },
    registerGatewayMethod: (name: string, value: Handler) => handlers.set(name, value),
  } as never);
  service.start({
    gatewayEvents: {
      emit: (_event: string, payload: unknown) => {
        for (const listener of listeners)
          listener({ event: DRAWIO_CANVAS_EVENT, payload } as GatewayEventFrame);
      },
    },
  });
});
afterEach(() => {
  cleanups.splice(0).forEach(dispose => dispose());
  service.stop();
  vi.clearAllMocks();
});

async function fixture(holdFirstPrepareResponse = false) {
  const backend: Promise<void>[] = [];
  let held = false;
  let selected = true;
  let ownerCurrent = true;
  const request = vi.fn(
    (method: string, params: unknown, options?: GatewayRequestOptions): Promise<unknown> => {
      if (method === 'mcp.app.view')
        return Promise.resolve({ ...editorResource, messageSupported: true, toolResult: { structuredContent: snapshot } });
      if (method === DRAWIO_CURRENT_METHOD)
        return Promise.resolve({ diagram: null, editorResource });
      const handler = handlers.get(method);
      if (!handler) return Promise.resolve({});
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
            hasCurrentClientAuthority: () => ownerCurrent,
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
              if (ok) resolve(payload);
              else reject(new Error('RPC unavailable'));
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
    subscribeEvents: (listener: (event: GatewayEventFrame) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as GatewayClient;
  const apps = new McpAppSession(() => ({
    ...scope,
    client,
    generation: 1,
    isCurrent: () => selected && ownerCurrent,
    isOwnerCurrent: () => ownerCurrent,
  }));
  const attach = async (viewId: string) => {
    const view = apps.bind(viewId);
    await view.view(undefined, { ...source, viewId });
    const transport = view.editorTransport(mcpAppAdapter);
    view.preservePresentation = true;
    let prepare!: (signal: AbortSignal) => Promise<unknown>;
    let currentSnapshot = { ...snapshot };
    let beforeApply: (() => Promise<void>) | undefined;
    const callTool = vi.fn(async (input: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => {
      if (input.name === DRAWIO_SNAPSHOT_TOOL)
        return { structuredContent: { ...currentSnapshot } };
      if (input.name !== DRAWIO_APPLY_TOOL) throw new Error('Unexpected browser tool');
      await beforeApply?.();
      const operation = input.arguments!;
      currentSnapshot = {
        diagramId: snapshot.diagramId,
        xml: operation.xml as string,
        title: operation.title as string,
        contentStamp: `applied-${operation.operationId}`,
      };
      return {
        structuredContent: {
          operationId: operation.operationId,
          status: 'applied',
          snapshot: { ...currentSnapshot },
        },
      };
    });
    const stop = mcpAppAdapter.connect({
      ...transport,
      source,
      viewId: () => viewId,
      contentId: snapshot.diagramId,
      bridge: { callTool } as never,
      current: () => view.isRetainedEditorCurrent(),
      canPrepare: () => view.isCurrent(),
      priority: () => 2,
      onSuspend: listener => view.onSuspend(listener),
      subscribe: listener => view.subscribeRetainedEditor(listener),
      registerPreparation: callback => {
        prepare = callback;
        return apps.registerCanvasPreparation(mcpAppAdapter, viewId, callback, () => view.isCurrent(),
          runId => view.retainPreparedRun(runId));
      },
    });
    cleanups.push(stop);
    return {
      view,
      callTool,
      transport,
      dispose: stop,
      prepare: () => prepare(new AbortController().signal),
      beforeApply: (callback: () => Promise<void>) => {
        beforeApply = callback;
      },
    };
  };
  return {
    apps,
    attach,
    backend,
    request,
    held: () => held,
    switchAway() {
      apps.invalidate(true);
      selected = false;
    },
    returnToChat() {
      selected = true;
    },
    revokeOwner() {
      ownerCurrent = false;
    },
    async send(runId: string) {
      const prepared = await apps.prepareChatSend({
        ...scope,
        idempotencyKey: runId,
        message: 'Edit the current diagram',
      });
      prepared.onRequest?.();
      await client.request(prepared.method, prepared.params);
      const tool = factory.create({ ...scope, assertInvocationCurrent: () => {} });
      return (callId: string, params: Record<string, unknown>) => {
        tool.prepareBeforeToolCallParams(params, {
          toolCallId: callId,
          hookContext: { ...scope, runId },
        });
        return tool.execute(callId, params);
      };
    },
  };
}

describe('actual session cancellation with background draw.io preparation', () => {
  it('reads and updates the original prepared canvas while another chat is selected', async () => {
    const f = await fixture();
    const original = await f.attach('mcp-app-original');
    const invoke = await f.send('run-background');

    f.switchAway();
    expect(original.view.isCurrent()).toBe(false);
    expect(original.view.isRetainedEditorCurrent()).toBe(true);
    await expect(original.prepare()).rejects.toThrow('unavailable');
    await expect(
      original.transport.request(DRAWIO_CANVAS_METHOD, { action: 'prepare', source, snapshot }),
    ).rejects.toThrow('binding expired');
    const read = await invoke('read-background', { action: 'read' });
    expect(JSON.parse(read.content[0].text)).toEqual(snapshot);

    const updated = await invoke('update-background', {
      action: 'update',
      diagramId: snapshot.diagramId,
      baseContentStamp: snapshot.contentStamp,
      xml: snapshot.xml,
      title: 'Updated in the original chat',
    });
    expect(updated.details?.diagramUpdate).toMatchObject({
      status: 'applied',
      runId: 'run-background',
      toolCallId: 'update-background',
      source: { ...scope, originViewId: 'mcp-app-original' },
    });
    expect(
      original.callTool.mock.calls.filter(([input]) => input.name === DRAWIO_APPLY_TOOL),
    ).toHaveLength(1);

    f.returnToChat();
    expect(f.apps.resume(original.view)).toBe(true);
    await expect(original.prepare()).resolves.toHaveProperty('token');
    const latest = await invoke('read-returned', { action: 'read' });
    expect(JSON.parse(latest.content[0].text).title).toBe('Updated in the original chat');
    expect(sdk.dispatch.mock.calls.filter(([method]) => method === 'mcp.app.view')).toHaveLength(1);
    expect(sdk.dispatch.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
  });

  it('keeps one dispatched apply and its acknowledgement valid across A to B to A', async () => {
    const f = await fixture();
    const original = await f.attach('mcp-app-original');
    const invoke = await f.send('run-return-during-apply');
    let finishApply!: () => void;
    const applying = new Promise<void>(resolve => {
      finishApply = resolve;
    });
    original.beforeApply(() => applying);
    const pending = invoke('update-during-navigation', {
      action: 'update',
      diagramId: snapshot.diagramId,
      baseContentStamp: snapshot.contentStamp,
      xml: snapshot.xml,
      title: 'Applied once',
    });
    await vi.waitFor(() =>
      expect(
        original.callTool.mock.calls.filter(([input]) => input.name === DRAWIO_APPLY_TOOL),
      ).toHaveLength(1),
    );

    f.switchAway();
    f.returnToChat();
    expect(f.apps.resume(original.view)).toBe(true);
    finishApply();

    await expect(pending).resolves.toMatchObject({
      details: { diagramUpdate: { status: 'applied', toolCallId: 'update-during-navigation' } },
    });
    expect(
      original.callTool.mock.calls.filter(([input]) => input.name === DRAWIO_APPLY_TOOL),
    ).toHaveLength(1);
  });

  it.each(['close', 'native owner loss'])(
    'revokes a hidden prepared canvas after %s',
    async action => {
      const f = await fixture();
      const original = await f.attach('mcp-app-original');
      const invoke = await f.send('run-revoked');
      f.switchAway();
      if (action === 'close') {
        await original.view.close();
        original.dispose();
        original.view.detach();
        await Promise.all(f.backend);
        expect(
          f.request.mock.calls.filter(
            ([method, params]) =>
              method === DRAWIO_CANVAS_METHOD &&
              (params as { action?: string }).action === 'detach',
          ),
        ).toEqual([[
          DRAWIO_CANVAS_METHOD,
          expect.objectContaining({
            ...scope, viewId: 'mcp-app-original', token: '', forgetSource: true,
          }),
          expect.anything(),
        ]]);
      } else f.revokeOwner();

      expect(original.view.isRetainedEditorCurrent()).toBe(false);
      await expect(invoke('read-revoked', { action: 'read' })).rejects.toThrow();
      await expect(original.prepare()).rejects.toThrow('unavailable');
      expect(
        original.callTool.mock.calls.filter(([input]) => input.name === DRAWIO_APPLY_TOOL),
      ).toHaveLength(0);
    },
  );

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
        if (method === 'chat.history' && !blocked) {
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
