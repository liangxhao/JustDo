import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { verifyItemResult } from './batch-snapshot.js';
import { resultTransportBudget, resultTransportCost } from './batch-contract.js';
import type { Flow, NodeStatus } from './contract.js';
import { FLOW_RPC } from './contract.js';
import type { FlowEngine } from './engine.js';
import { resultPage } from './result-page.js';
import type { FlowStore } from './store.js';

export const RESULT_TOOL = 'swarm_workflow_results';
export function registerBatchApi(
  api: OpenClawPluginApi,
  host: {
    current(): { store: FlowStore; engine: FlowEngine };
    assertParent(flow: Flow): void;
    bound(
      sessionKey: string,
      callId: string,
    ): { runId: string; contextTokens?: number; assertCurrent(): void };
  },
) {
  for (const method of [FLOW_RPC.batch, FLOW_RPC.retryBatch])
    api.registerGatewayMethod(
      method,
      ({ params, respond }) => {
        try {
          if (
            !Array.isArray(params.parentKeys) ||
            !params.parentKeys.length ||
            params.parentKeys.length > 8 ||
            !params.parentKeys.every(
              key => typeof key === 'string' && /^agent:[^:]+:justdo:[^:]+$/.test(key),
            ) ||
            typeof params.id !== 'string' ||
            typeof params.stageId !== 'string'
          )
            throw new Error('Invalid batch request.');
          const { store, engine } = host.current();
          const flow = store.get(params.id);
          if (!flow || !params.parentKeys.includes(flow.parentKey))
            throw new Error('Batch does not belong to this conversation.');
          if (method === FLOW_RPC.batch) {
            if (
              (params.status !== undefined && typeof params.status !== 'string') ||
              (params.search !== undefined && typeof params.search !== 'string') ||
              (params.cursor !== undefined && typeof params.cursor !== 'string')
            )
              throw new Error('Invalid batch page.');
            respond(
              true,
              store.batches.page(flow, params.stageId, {
                status: params.status as NodeStatus | undefined,
                search: params.search as string | undefined,
                cursor: params.cursor as string | undefined,
              }),
            );
          } else {
            if (!Number.isSafeInteger(params.revision) || typeof params.operationId !== 'string')
              throw new Error('Invalid batch operation.');
            host.assertParent(flow);
            respond(
              true,
              engine.retryBatch(
                flow.id,
                params.stageId,
                params.revision as number,
                params.operationId,
                params.itemIds as string[] | undefined,
              ),
            );
          }
        } catch (error) {
          respond(false, undefined, { code: 'swarm_workflow_error', message: String(error) });
        }
      },
      { scope: method === FLOW_RPC.batch ? 'operator.read' : 'operator.admin' },
    );

  api.registerTool(
    {
      contextVersion: 2,
      create: ctx => {
        if (!ctx.sessionKey || !/^agent:[^:]+:subagent:swarm-workflow-/.test(ctx.sessionKey))
          return null;
        const current = host.current();
        const owner = current.store.batches.owner(ctx.sessionKey);
        const flow = owner
          ? current.store.get(owner.flowId, owner.nodeId)
          : current.store
              .all()
              .find(flow => flow.nodes.some(node => node.sessionKey === ctx.sessionKey));
        const node = flow?.nodes.find(node => node.sessionKey === ctx.sessionKey);
        if (!node || !flow || !['work', 'verify'].includes(node.kind)) return null;
        return {
          name: RESULT_TOOL,
          label: 'Read batch results',
          description:
            'Read accepted dependency results. Supply stageId for at most 20 verified batch item results and artifact references, OR nodeId for a bounded text fragment of a normal stage result. Follow cursor to read every page. Inspect actual files before aggregation or verification. Changed batch artifacts fail this query. Never infer complete coverage from one page.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              stageId: { type: 'string', maxLength: 80 },
              nodeId: { type: 'string', maxLength: 80 },
              cursor: { type: 'string', maxLength: 2048 },
            },
          },
          async execute(callId: string, input: unknown, signal?: AbortSignal) {
            try {
              const args = input as { stageId?: unknown; nodeId?: unknown; cursor?: unknown };
              if (
                !args ||
                Boolean(args.stageId) === Boolean(args.nodeId) ||
                [args.stageId, args.nodeId].some(
                  id => id !== undefined && (typeof id !== 'string' || !id || id.length > 80),
                ) ||
                Object.keys(args).some(key => !['stageId', 'nodeId', 'cursor'].includes(key)) ||
                (args.cursor !== undefined &&
                  (typeof args.cursor !== 'string' || args.cursor.length > 2048))
              )
                throw new Error('Invalid result index arguments.');
              const authority = host.bound(ctx.sessionKey!, callId);
              const budget = resultTransportBudget(authority.contextTokens);
              const guard = () => {
                signal?.throwIfAborted();
                ctx.assertInvocationCurrent();
                authority.assertCurrent();
                const active = host
                  .current()
                  .engine.submissionOwner(ctx.sessionKey!, authority.runId);
                host.assertParent(active.flow);
              };
              guard();
              const active = host
                .current()
                .engine.submissionOwner(ctx.sessionKey!, authority.runId);
              if (typeof args.nodeId === 'string') {
                const result = resultPage(
                  active.flow,
                  active.node,
                  args.nodeId,
                  args.cursor as string | undefined,
                  budget,
                );
                guard();
                return {
                  details: result,
                  content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                };
              }
              if (active.node.batchItem)
                throw new Error(
                  'Batch items may read only their normal stage dependencies, not sibling batch results.',
                );
              const stage = active.flow.nodes.find(
                node => node.id === args.stageId && node.kind === 'batch',
              );
              if (
                !stage ||
                stage.status !== 'done' ||
                (active.node.kind !== 'verify' && !active.node.deps.includes(stage.id))
              )
                throw new Error('Batch is not an accepted dependency of this node.');
              const identity = [active.flow.id, stage.id, stage.batchInput!.version];
              let after = -1;
              if (args.cursor) {
                const cursor = JSON.parse(
                  Buffer.from(args.cursor as string, 'base64url').toString(),
                );
                if (
                  !Array.isArray(cursor) ||
                  cursor.length !== 4 ||
                  identity.some((value, index) => cursor[index] !== value) ||
                  !Number.isSafeInteger(cursor[3]) ||
                  cursor[3] < 0
                )
                  throw new Error('Result cursor belongs to another batch version.');
                after = cursor[3];
              }
              const page = host
                .current()
                .store.batches.results(active.flow, stage.id, after, budget);
              for (const item of page.items as Array<{ id: string }>) {
                const f = host.current().store.get(active.flow.id, item.id)!;
                await verifyItemResult(
                  f,
                  f.nodes.find(node => node.id === item.id)!,
                  guard,
                );
              }
              guard();
              const result = {
                flowId: active.flow.id,
                stageId: stage.id,
                manifestVersion: stage.batchInput?.version,
                total: stage.batchCounts?.total,
                items: page.items,
                ...(page.after === undefined
                  ? {}
                  : {
                      cursor: Buffer.from(JSON.stringify([...identity, page.after])).toString(
                        'base64url',
                      ),
                    }),
              };
              if (resultTransportCost(result) > budget)
                throw new Error('Result transport envelope exceeds this model context budget.');
              return {
                details: result,
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              };
            } catch (error) {
              const result = { accepted: false, error: String(error) };
              return {
                details: result,
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              };
            }
          },
        };
      },
    },
    { name: RESULT_TOOL },
  );
}
