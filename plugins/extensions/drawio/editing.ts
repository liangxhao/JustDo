import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import { type CanvasOwner, DiagramCanvasState } from './canvas-state';
import {
  type DiagramSnapshot,
  type DiagramSource,
  DRAWIO_CANVAS_METHOD,
  DRAWIO_EDIT_TOOL,
  DRAWIO_ENTRY_TOOLS,
  DRAWIO_RESOURCE,
  DRAWIO_SEND_METHOD,
  DRAWIO_SERVER,
  type PreparedDiagramCanvas,
} from './contracts';
// Bundled by the plugin build; no application imports or filesystem XML reads.
import { validateDiagram } from './editor-resource.mjs';
import { diagramUpdateReference } from './update-result';

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown, max = 512) =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : '';
const id = (v: unknown) => (/^diagram-[a-zA-Z0-9-]{1,100}$/.test(text(v)) ? (v as string) : '');
function snapshot(value: unknown): DiagramSnapshot {
  const input = object(value);
  const diagram = validateDiagram(input);
  if (!id(input.diagramId) || !text(input.contentStamp, 128))
    throw new Error('Invalid diagram snapshot');
  return {
    ...diagram,
    diagramId: input.diagramId as string,
    contentStamp: input.contentStamp as string,
  };
}

// The public SDK projects this native retryable admission error to code/message.
// Only these two read-only preparation methods may wait for the same authority.
async function readPreparedView(
  method: 'mcp.app.view' | 'mcp.app.readResource',
  params: Record<string, unknown>,
  assertCurrent: () => void,
) {
  for (let attempt = 0; ; attempt++) {
    assertCurrent();
    const result = await dispatchGatewayMethod(method, params);
    assertCurrent();
    if (
      attempt >= 4 ||
      result.ok ||
      result.error?.code !== 'UNAVAILABLE' ||
      result.error.message !== 'Session access is refreshing; retry the operation shortly.'
    )
      return result;
    await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
  }
}
export type DiagramEditingState = {
  canvases: DiagramCanvasState;
  recovered: Map<string, { source: DiagramSource; diagramId: string }>;
  admissions: Map<
    string,
    { owner: CanvasOwner; source: Readonly<DiagramSource>; dispose: () => void }
  >;
  owner?: symbol;
};
const STATE = Symbol.for('drawio.canvas-state');
export function getDiagramEditingState(): DiagramEditingState {
  const global = globalThis as typeof globalThis & { [STATE]?: DiagramEditingState };
  return (global[STATE] ??= {
    canvases: new DiagramCanvasState(),
    recovered: new Map(),
    admissions: new Map(),
  });
}

type AdmissionOwner = Pick<
  CanvasOwner,
  'connectionId' | 'sessionKey' | 'sessionId' | 'agentId' | 'viewId'
>;
const admissionKey = (owner: AdmissionOwner, diagramId: string) =>
  JSON.stringify([
    owner.connectionId,
    owner.sessionKey,
    owner.sessionId,
    owner.agentId,
    owner.viewId,
    diagramId,
  ]);

/** Provenance of one live local editor; grants no native MCP tool or context access. */
export function readAdmittedDiagramSource(owner: AdmissionOwner, diagramId: string) {
  const admission = getDiagramEditingState().admissions.get(admissionKey(owner, diagramId));
  if (!admission) throw new Error('Diagram source is not admitted');
  admission.owner.assertCurrent();
  return admission.source;
}

export function registerDiagramEditing(api: OpenClawPluginApi) {
  const state = getDiagramEditingState();
  // Only the latest prepare/owner cleanup on this authenticated socket may
  // finish. Native request cancellation does not cancel background RPC work.
  const preparations = new Map<string, object>();
  const serviceOwner = Symbol('drawio-canvas-service');
  api.registerService({
    id: 'drawio-canvas',
    start(ctx) {
      state.owner = serviceOwner;
      state.canvases.emit = viewId =>
        ctx.gatewayEvents?.emit('canvas-changed', { viewId }, { scope: 'operator.admin' });
    },
    stop() {
      if (state.owner !== serviceOwner) return;
      preparations.clear();
      for (const admission of state.admissions.values()) admission.dispose();
      state.admissions.clear();
      state.canvases.close();
      state.recovered.clear();
      state.owner = undefined;
    },
  });

  const unavailable = {
    code: 'UNAVAILABLE',
    message: 'Diagram operation unavailable. Reopen or prepare the current canvas.',
  };
  type Invocation = Parameters<Parameters<OpenClawPluginApi['registerGatewayMethod']>[1]>[0];
  async function ownerFor(invocation: Invocation, viewId: string): Promise<CanvasOwner> {
    const { params, client, hasCurrentClientAuthority } = invocation;
    const sessionKey = text(params.sessionKey);
    const sessionId = text(params.sessionId);
    const agentId = text(params.agentId, 128);
    if (!sessionKey.startsWith(`agent:${agentId}:`) || !sessionId || !agentId || !client?.connId)
      throw new Error('Invalid diagram owner');
    const history = await dispatchGatewayMethod('chat.history', { sessionKey, agentId, limit: 1 });
    const identity = object(history.payload);
    if (!history.ok || identity.sessionKey !== sessionKey || identity.sessionId !== sessionId)
      throw new Error('Diagram session changed');
    const initial = getSessionEntry({ sessionKey, agentId, readConsistency: 'latest' });
    if (initial?.sessionId !== sessionId) throw new Error('Diagram session changed');
    const lifecycleRevision = initial.lifecycleRevision;
    const assertCurrent = () => {
      const cfg = api.runtime.config.current();
      const entry = getSessionEntry({ sessionKey, agentId, readConsistency: 'latest' });
      if (
        state.owner !== serviceOwner ||
        client.connectionSignal?.aborted ||
        hasCurrentClientAuthority?.() === false ||
        cfg.mcp?.apps?.enabled !== true ||
        cfg.plugins?.enabled === false ||
        cfg.plugins?.entries?.drawio?.enabled === false ||
        entry?.sessionId !== sessionId ||
        entry.lifecycleRevision !== lifecycleRevision
      )
        throw new Error('Diagram owner changed');
    };
    assertCurrent();
    return { sessionKey, sessionId, agentId, connectionId: client.connId, viewId, assertCurrent };
  }

  async function verifySource(
    owner: CanvasOwner,
    diagramId: string,
    admitted: Record<string, unknown>,
    assertCurrent: () => void,
  ): Promise<DiagramSource> {
    const result = await readPreparedView(
      'mcp.app.view',
      {
        sessionKey: owner.sessionKey,
        agentId: owner.agentId,
        viewId: owner.viewId,
      },
      assertCurrent,
    );
    assertCurrent();
    const initial = object(object(object(result.payload).toolResult).structuredContent);
    if (!result.ok || initial.diagramId !== diagramId) throw new Error('Diagram view mismatch');
    const recovered = state.recovered.get(owner.viewId);
    if (recovered) {
      if (
        recovered.diagramId !== diagramId ||
        recovered.source.sessionId !== owner.sessionId ||
        recovered.source.agentId !== owner.agentId ||
        recovered.source.sessionKey !== owner.sessionKey
      )
        throw new Error('Recovered diagram mismatch');
      return recovered.source;
    }
    // Resolve the original mint on the admitted view's exact native connection.
    const uri = `diagram://origin/${diagramId}`;
    const origin = await readPreparedView(
      'mcp.app.readResource',
      {
        sessionKey: owner.sessionKey,
        agentId: owner.agentId,
        viewId: owner.viewId,
        uri,
      },
      assertCurrent,
    );
    assertCurrent();
    if (!origin.ok) throw new Error('Diagram mint unavailable');
    const contents = object(origin.payload).contents;
    const resource = Array.isArray(contents) && contents.length === 1 ? object(contents[0]) : {};
    const mint = object(JSON.parse(text(resource.text, 2048)));
    if (resource.uri !== uri || mint.diagramId !== diagramId || mint.toolName !== admitted.toolName)
      throw new Error('Diagram mint unavailable');
    return {
      kind: 'desktop-native-admission',
      diagramId,
      serverName: DRAWIO_SERVER,
      toolName: admitted.toolName as DiagramSource['toolName'],
      uiResourceUri: DRAWIO_RESOURCE,
      originViewId: owner.viewId,
      sessionKey: owner.sessionKey,
      sessionId: owner.sessionId,
      agentId: owner.agentId,
    };
  }

  api.registerGatewayMethod(
    DRAWIO_CANVAS_METHOD,
    async invocation => {
      const { params, respond } = invocation;
      const preparationKey = JSON.stringify([
        invocation.client?.connId,
        params.sessionKey,
        params.sessionId,
        params.agentId,
        params.viewId,
      ]);
      const gatesPreparation =
        params.action === 'admit' ||
        params.action === 'prepare' ||
        (params.action === 'detach' && (!params.token || params.forgetSource === true));
      const gate = {};
      try {
        const viewId = text(params.viewId);
        if (!/^mcp-app-[A-Za-z0-9-]{1,100}$/.test(viewId)) throw new Error('Invalid diagram view');
        if (gatesPreparation) {
          if (!preparations.has(preparationKey) && preparations.size >= 64)
            throw new Error('Too many diagram preparations');
          preparations.set(preparationKey, gate);
        }
        const owner = await ownerFor(invocation, viewId);
        const assertPreparation = () => {
          owner.assertCurrent();
          if (gatesPreparation && preparations.get(preparationKey) !== gate)
            throw new Error('Diagram preparation superseded');
        };
        assertPreparation();
        const token = text(params.token, 128);
        if (params.action === 'admit' || params.action === 'prepare') {
          const diagramId =
            params.action === 'admit'
              ? id(params.diagramId)
              : id(object(params.snapshot).diagramId);
          if (!diagramId) throw new Error('Invalid diagram identity');
          const admitted = object(params.source);
          if (
            admitted.serverName !== DRAWIO_SERVER ||
            admitted.uiResourceUri !== DRAWIO_RESOURCE ||
            !DRAWIO_ENTRY_TOOLS.includes(admitted.toolName as never) ||
            admitted.originSessionKey !== owner.sessionKey
          )
            throw new Error('Not an admitted draw.io view');
          const key = admissionKey(owner, diagramId);
          if (params.action === 'admit' && !state.admissions.has(key)) {
            // Admission records only immutable provenance. Model selection can
            // retire native App interaction grants without changing this editor.
            const source = Object.freeze({
              ...(await verifySource(owner, diagramId, admitted, assertPreparation)),
            });
            assertPreparation();
            for (const [previousKey, previous] of state.admissions) {
              try {
                previous.owner.assertCurrent();
              } catch {
                previous.dispose();
                state.admissions.delete(previousKey);
              }
            }
            if (state.admissions.size >= 64) throw new Error('Too many admitted diagram editors');
            const signal = invocation.client?.connectionSignal;
            const revoked = () => {
              if (state.admissions.get(key) === admission) state.admissions.delete(key);
              admission.dispose();
            };
            const admission = {
              owner,
              source,
              dispose: () => signal?.removeEventListener('abort', revoked),
            };
            state.admissions.set(key, admission);
            signal?.addEventListener('abort', revoked, { once: true });
            assertPreparation();
          }
          const source = readAdmittedDiagramSource(owner, diagramId);
          if (
            source.toolName !== admitted.toolName ||
            source.serverName !== admitted.serverName ||
            source.uiResourceUri !== admitted.uiResourceUri ||
            source.sessionKey !== admitted.originSessionKey
          )
            throw new Error('Diagram source changed');
          assertPreparation();
          if (params.action === 'admit') {
            respond(true, { admitted: true });
            return;
          }
          const current = snapshot(params.snapshot);
          respond(true, {
            token: state.canvases.prepare(
              owner,
              source,
              current,
              token || undefined,
              params.retire === true,
            ),
          });
        } else if (params.action === 'next') {
          respond(true, { operation: state.canvases.take(owner, token) });
        } else if (params.action === 'ack') {
          const ack = object(params.result);
          const status = ack.status;
          if (status !== 'applied' && status !== 'conflict' && status !== 'failed')
            throw new Error('Invalid diagram acknowledgement');
          state.canvases.acknowledge(
            owner,
            token,
            text(params.operationId, 128),
            status === 'applied' ? { status, snapshot: snapshot(ack.snapshot) } : { status },
          );
          respond(true, {});
        } else if (params.action === 'detach') {
          if (token) state.canvases.detach(owner, token);
          else state.canvases.detachOwner(owner);
          if (params.forgetSource === true) {
            for (const [key, admission] of state.admissions) {
              if (
                admission.owner.connectionId === owner.connectionId &&
                admission.owner.sessionKey === owner.sessionKey &&
                admission.owner.sessionId === owner.sessionId &&
                admission.owner.agentId === owner.agentId &&
                admission.owner.viewId === owner.viewId
              ) {
                admission.dispose();
                state.admissions.delete(key);
              }
            }
          }
          respond(true, {});
        } else throw new Error('Unknown diagram action');
      } catch {
        respond(false, undefined, unavailable);
      } finally {
        if (preparations.get(preparationKey) === gate) preparations.delete(preparationKey);
      }
    },
    { scope: 'operator.admin' },
  );

  api.registerGatewayMethod(
    DRAWIO_SEND_METHOD,
    async invocation => {
      const { params, respond } = invocation;
      let runId = '';
      let issued = false;
      try {
        const owner = await ownerFor(invocation, '');
        const send = object(params.send);
        runId = text(send.idempotencyKey, 256);
        if (
          !runId ||
          send.sessionKey !== owner.sessionKey ||
          send.sessionId !== owner.sessionId ||
          !Array.isArray(params.canvases)
        )
          throw new Error('Invalid prepared send');
        const prepared = params.canvases.map(value => {
          const entry = object(value);
          if (!text(entry.token, 128) || !text(entry.viewId) || typeof entry.selected !== 'boolean')
            throw new Error('Invalid prepared canvas');
          return entry as unknown as PreparedDiagramCanvas;
        });
        state.canvases.freeze(owner, runId, prepared);
        owner.assertCurrent();
        issued = true;
        const result = await dispatchGatewayMethod('chat.send', send);
        if (!result.ok || object(result.payload).runId !== runId) {
          state.canvases.markUnknown(runId);
          respond(false, undefined, result.error ?? unavailable);
          return;
        }
        respond(true, result.payload);
      } catch {
        if (issued) state.canvases.markUnknown(runId);
        respond(false, undefined, unavailable);
      }
    },
    { scope: 'operator.admin' },
  );

  api.registerTool(
    {
      contextVersion: 2,
      create: ctx => {
        if (!ctx.sessionKey || !ctx.sessionId || !ctx.agentId) return null;
        const identity = {
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
        };
        const calls = new Map<string, string>();
        return {
          name: DRAWIO_EDIT_TOOL,
          label: 'draw.io',
          catalogMode: 'direct-only',
          description:
            'Read or update an existing draw.io canvas in this chat. Before drawing or editing, use action=read to find the current prepared canvas, including a blank sidebar canvas. Read returns diagramId, prepared XML and contentStamp. Update that diagram in place with action=update, diagramId, baseContentStamp and complete XML. Preserve other pages, cell IDs and layout unless asked to change them. A successful update has already been applied in the existing editor; do not call create_diagram or open another editor for it. Explicitly new diagrams use create_diagram. A conflict preserves manual edits: explain it and wait for a new explicit user request to prepare the changed canvas; reads in this run still use the frozen snapshot. Never retry a conflict or unknown result in this run. Missing/ambiguous targets require user selection.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['read', 'update'] },
              diagramId: { type: 'string' },
              baseContentStamp: { type: 'string' },
              xml: { type: 'string' },
              title: { type: 'string' },
            },
            required: ['action'],
          } as never,
          prepareBeforeToolCallParams(params, metadata) {
            const hook = object(metadata.hookContext);
            const runId = text(hook.runId, 256);
            if (
              !metadata.toolCallId ||
              !runId ||
              hook.sessionId !== identity.sessionId ||
              hook.sessionKey !== identity.sessionKey ||
              hook.agentId !== identity.agentId
            )
              throw new Error('Diagram tool requires exact native run identity');
            ctx.assertInvocationCurrent();
            calls.set(metadata.toolCallId, runId);
            return params;
          },
          async execute(toolCallId, params, signal) {
            const runId = calls.get(toolCallId);
            calls.delete(toolCallId);
            try {
              ctx.assertInvocationCurrent();
              if (!runId) throw new Error('Native diagram tool identity unavailable');
              const input = object(params);
              if (input.action === 'read') {
                const current = state.canvases.read(
                  runId,
                  identity,
                  text(input.diagramId) || undefined,
                ).snapshot;
                return {
                  content: [{ type: 'text', text: JSON.stringify(current) }],
                  details: { diagramId: current.diagramId },
                };
              }
              if (
                input.action !== 'update' ||
                !id(input.diagramId) ||
                !text(input.baseContentStamp, 128)
              )
                throw new Error('Invalid diagram update');
              const diagram = validateDiagram(input);
              const receipt = await state.canvases.update(
                runId,
                toolCallId,
                identity,
                {
                  ...diagram,
                  diagramId: input.diagramId as string,
                  baseContentStamp: input.baseContentStamp as string,
                },
                ctx.assertInvocationCurrent,
                signal,
              );
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(diagramUpdateReference(receipt)),
                  },
                ],
                details: { diagramUpdate: receipt },
              };
            } catch (error) {
              throw error instanceof Error ? error : new Error('Diagram update unavailable');
            }
          },
        };
      },
    },
    { name: DRAWIO_EDIT_TOOL },
  );
}
