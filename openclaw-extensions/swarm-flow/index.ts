import path from 'node:path';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import {
  DEFAULT_FLOW_AGENT,
  type Flow,
  FLOW_LIMITS,
  FLOW_MANAGEMENT_TOOLS,
  FLOW_RPC,
  FLOW_TOOLS,
  type FlowAction,
  type FlowAgent,
  type FlowNode,
  viewFlow,
} from './contract.js';
import { FlowEngine } from './engine.js';
import { interventionAvailability } from './intervention.js';
import { createManagementTools, MANAGEMENT_GUIDANCE } from './management.js';
import { FlowNotifier } from './notifications.js';
import { assertCrossAgentPolicy, parentPolicy } from './policy.js';
import { FlowStore } from './store.js';
import {
  lastSubmissionError,
  SUBMISSION_LIMITS,
  submissionCorrectionInstructions,
  submissionInstructions,
  validateSubmission,
} from './submission.js';

const managed = (key: unknown): key is string =>
  typeof key === 'string' && /^agent:[^:]+:justdo:[^:]+$/.test(key);
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const entry = (key: string) =>
  getSessionEntry({ sessionKey: key, readConsistency: 'latest' }) as
    Record<string, unknown> | undefined;

type SubmissionCall = { runId: string; expiresAt: number; signal?: AbortSignal };
type SharedService = {
  store?: FlowStore;
  engine?: FlowEngine;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  notifier?: FlowNotifier;
  pendingNotice?: Promise<void>;
  generation: number;
  submissionCalls: Map<string, SubmissionCall>;
  managementCalls: Map<string, SubmissionCall>;
};
// Native agent registries register separate tool/hook instances in this process.
// They must all address the service started by the Gateway registry, while each
// invocation still proves its own native session/run authority before writing.
const serviceKey = Symbol.for('justdo.swarm-flow.service');
const processServices = globalThis as typeof globalThis & {
  [key: symbol]: SharedService | undefined;
};
const state = (processServices[serviceKey] ??= {
  generation: 0,
  submissionCalls: new Map<string, SubmissionCall>(),
  managementCalls: new Map<string, SubmissionCall>(),
});

export default {
  id: 'swarm-flow',
  name: 'Swarm Flow',
  register(api: OpenClawPluginApi) {
    let ownedGeneration: number | undefined;
    const submissionCalls = state.submissionCalls;
    const managementCalls = state.managementCalls;
    const callKey = (sessionKey: string, toolCallId: string, name: string) =>
      JSON.stringify([sessionKey, toolCallId, name]);
    const rpc = <T = Record<string, unknown>>(method: string, params: Record<string, unknown>) =>
      api.runtime.gateway.request<T>(method, params, {
        scopes: ['operator.admin', 'operator.read', 'operator.write'],
        timeoutMs: 15000,
      });
    const assertParentIdentity = (flow: Flow) => {
      const current = entry(flow.parentKey);
      if (!current || current.sessionId !== flow.parentId)
        throw new Error('Parent identity changed. Flow management is blocked.');
      return current;
    };
    const assertParent = (flow: Flow) => {
      const current = assertParentIdentity(flow);
      if (
        current.permissionMode !== flow.permissionMode ||
        current.sessionRoot !== flow.cwd ||
        parentPolicy(current) !== flow.policy ||
        (current.justdoPlanMode as { enabled?: boolean } | undefined)?.enabled
      )
        throw new Error(
          'Parent identity, permissions or project changed. Flow admission is blocked.',
        );
    };
    const ensure = () => {
      if (!state.engine || !state.store) throw new Error('Swarm flow service is unavailable.');
      return { engine: state.engine, store: state.store };
    };
    const availableAgents = async (): Promise<FlowAgent[]> => {
      const result = await rpc<{ agents?: Array<Record<string, unknown>> }>('agents.list', {});
      if (!Array.isArray(result.agents)) throw new Error('Native agent roster is unavailable.');
      // Product availability only gates new Swarm stages; native history and
      // authorization for other entry points remain owned by OpenClaw.
      const configured =
        api.runtime.config.current().plugins?.entries?.['swarm-flow']?.config?.availableAgentIds;
      if (
        configured !== undefined &&
        (!Array.isArray(configured) || !configured.every(id => typeof id === 'string'))
      ) {
        throw new Error('Product agent roster is unavailable.');
      }
      const available = new Set(configured ?? [DEFAULT_FLOW_AGENT]);
      return result.agents
        .filter(
          agent =>
            typeof agent.id === 'string' &&
            /^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent.id) &&
            available.has(agent.id) &&
            !agent.admissionRefusal,
        )
        .map(agent => ({
          id: agent.id as string,
          name:
            typeof agent.name === 'string' && agent.name.trim() ? agent.name : (agent.id as string),
        }));
    };
    const prepare = async (flow: Flow, node: FlowNode) => {
      assertParent(flow);
      assertCrossAgentPolicy(api.runtime.config.current(), flow.agentId, node.agentId);
      if (!(await availableAgents()).some(agent => agent.id === node.agentId))
        throw new Error('Assigned agent is no longer available: ' + node.agentId);
      // Task access classifies scheduling and task intent, not native authority.
      // Native read-only denies even inspection commands; preserve the user's
      // selected session permission ceiling for every stage instead.
      const permissionMode = flow.permissionMode;
      const policy = JSON.parse(flow.policy!);
      const created = await rpc<{
        key?: string;
        sessionId?: string;
        entry?: Record<string, unknown>;
      }>('sessions.create', {
        key: node.sessionKey,
        agentId: node.agentId,
        // These are plugin-owned execution sessions. The workflow owns the
        // association; native parent linkage is reserved for native spawning.
        cwd: flow.cwd,
        permissionMode,
        toolOverrides: policy.toolOverrides,
        ...(node.agentId === flow.agentId && policy.model ? { model: policy.model } : {}),
        displayName: node.title,
        // A deterministic native key provides create-or-adopt identity. The optional
        // session-create idempotency token requires a device principal unavailable
        // to service-owned calls; run admission uses its separate durable run ID.
      });
      if (
        created.key !== node.sessionKey ||
        created.entry?.permissionMode !== permissionMode ||
        created.entry?.sessionRoot !== flow.cwd
      )
        throw new Error('Native child policy could not be verified.');
      assertParent(flow);
    };
    api.registerService({
      id: 'swarm-flow',
      start(ctx) {
        if (state.engine) throw new Error('Swarm flow service is already running.');
        const epoch = ++state.generation;
        ownedGeneration = epoch;
        state.store = new FlowStore(path.join(ctx.stateDir, 'swarm-flow'));
        state.engine = new FlowEngine(state.store, {
          prepare,
          launch: async (flow, node, message, assertCurrent) => {
            assertParent(flow);
            const validate = () => {
              assertCurrent();
              assertParent(flow);
              assertCrossAgentPolicy(api.runtime.config.current(), flow.agentId, node.agentId);
            };
            return api.runtime.subagent.run({
              sessionKey: node.sessionKey,
              message,
              cwd: flow.cwd,
              idempotencyKey: node.intendedRunId,
              assertCurrent: validate,
              disableTools: node.kind === 'plan' || node.kind === 'deliver',
              deliver: false,
            });
          },
          wait: runId => api.runtime.subagent.waitForRun({ runId, timeoutMs: 1 }),
          correctionInstruction: async (flow, node) => {
            const runId = node.runId ?? node.intendedRunId!;
            assertParent(flow);
            ensure().engine.submissionOwner(node.sessionKey, runId);
            let error: string | undefined;
            try {
              const history = await api.runtime.subagent.getSessionMessages({
                sessionKey: node.sessionKey,
                limit: 64,
              });
              error = lastSubmissionError(history.messages, runId);
            } catch {
              // The native conversation still owns the evidence if this read
              // is unavailable. Never manufacture a successful result.
            }
            const current = ensure().engine.submissionOwner(node.sessionKey, runId);
            assertParent(current.flow);
            return error
              ? submissionCorrectionInstructions(node.kind as 'work' | 'verify', error)
              : (current.node.submissionRepair?.instruction ??
                  submissionCorrectionInstructions(node.kind as 'work' | 'verify'));
          },
          cancel: async node => {
            await rpc('sessions.abort', {
              key: node.sessionKey,
              ...(node.runId || node.intendedRunId
                ? { runId: node.runId ?? node.intendedRunId }
                : {}),
              clearQueued: true,
            });
          },
          deliver: async (flow, message) => {
            assertParent(flow);
            await rpc('chat.inject', { sessionKey: flow.parentKey, message });
          },
        });
        state.notifier = new FlowNotifier(state.store, {
          send: async (flow, message) => {
            if (epoch !== state.generation) throw new Error('Swarm service stopped.');
            // Reporting a blocker does not admit new work under a changed policy.
            assertParentIdentity(flow);
            await rpc('chat.inject', { sessionKey: flow.parentKey, message });
          },
        });
        const tick = () => {
          if (epoch !== state.generation || !state.engine) return;
          state.pending = state.engine
            .tick()
            .then(() => {
              if (epoch !== state.generation || state.pendingNotice) return;
              // A slow notification must not delay task dispatch or recovery.
              state.pendingNotice = state
                .notifier!.tick()
                .catch(error => ctx.logger.error('[SwarmFlow] ' + String(error)))
                .finally(() => {
                  if (epoch === state.generation) state.pendingNotice = undefined;
                });
            })
            .catch(error => ctx.logger.error('[SwarmFlow] ' + String(error)))
            .finally(() => {
              if (epoch === state.generation) state.timer = setTimeout(tick, 1500);
            });
        };
        tick();
      },
      async stop() {
        if (ownedGeneration !== state.generation) return;
        ownedGeneration = undefined;
        ++state.generation;
        submissionCalls.clear();
        managementCalls.clear();
        clearTimeout(state.timer);
        state.engine?.stop();
        state.notifier?.stop();
        await Promise.all([state.pending, state.pendingNotice]);
        state.store?.close();
        state.store = undefined;
        state.engine = undefined;
        state.pending = undefined;
        state.notifier = undefined;
        state.pendingNotice = undefined;
        state.timer = undefined;
      },
    });
    api.registerGatewayMethod(
      FLOW_RPC.health,
      ({ respond }) => respond(true, { ready: Boolean(state.engine), version: 1 }),
      { scope: 'operator.read' },
    );
    api.on('before_tool_call', (event, ctx) => {
      if (
        Object.values(FLOW_MANAGEMENT_TOOLS).includes(
          event.toolName as typeof FLOW_MANAGEMENT_TOOLS.status,
        )
      ) {
        try {
          if (!managed(ctx.sessionKey) || !ctx.runId || !ctx.toolCallId || ctx.abortSignal?.aborted)
            throw new Error('Missing or cancelled native management identity.');
          ensure();
          for (const [key, value] of managementCalls)
            if (value.expiresAt <= Date.now()) managementCalls.delete(key);
          if (managementCalls.size >= 256) throw new Error('Too many pending flow operations.');
          managementCalls.set(callKey(ctx.sessionKey, ctx.toolCallId, event.toolName), {
            runId: ctx.runId,
            signal: ctx.abortSignal,
            expiresAt: Date.now() + 30000,
          });
        } catch (error) {
          return { block: true, blockReason: String(error) };
        }
      }
      const assigned = state.store
        ?.all()
        .flatMap(flow => flow.nodes)
        .find(node => node.sessionKey === ctx.sessionKey);
      if (
        ctx.runId &&
        (assigned?.submissionRepair?.runId === ctx.runId ||
          assigned?.completion?.runId === ctx.runId) &&
        ![...Object.values(FLOW_TOOLS), 'tool_call', 'tool_describe', 'tool_search'].includes(
          event.toolName,
        )
      )
        return {
          block: true,
          blockReason:
            'Submission correction only: do not repeat the task or execute additional tools. Correct the submission arguments and submit the existing result.',
        };
      if (!Object.values(FLOW_TOOLS).includes(event.toolName as typeof FLOW_TOOLS.complete)) return;
      try {
        if (!ctx.sessionKey || !ctx.runId || !ctx.toolCallId || ctx.abortSignal?.aborted)
          throw new Error('Missing or cancelled native submission identity.');
        const { flow } = ensure().engine.submissionOwner(ctx.sessionKey, ctx.runId);
        assertParent(flow);
        for (const [key, value] of submissionCalls)
          if (value.expiresAt <= Date.now()) submissionCalls.delete(key);
        if (submissionCalls.size >= 256) throw new Error('Too many pending submissions.');
        submissionCalls.set(callKey(ctx.sessionKey, ctx.toolCallId, event.toolName), {
          runId: ctx.runId,
          signal: ctx.abortSignal,
          expiresAt: Date.now() + 30000,
        });
      } catch (error) {
        return { block: true, blockReason: String(error) };
      }
    });
    api.on('after_tool_call', (event, ctx) => {
      if (ctx.sessionKey && ctx.toolCallId) {
        const key = callKey(ctx.sessionKey, ctx.toolCallId, event.toolName);
        if (submissionCalls.get(key)?.runId === ctx.runId) submissionCalls.delete(key);
        if (managementCalls.get(key)?.runId === ctx.runId) managementCalls.delete(key);
      }
    });
    api.on('before_agent_finalize', (event, ctx) => {
      if (
        !ctx.sessionKey ||
        !ctx.runId ||
        event.runId !== ctx.runId ||
        (event.sessionKey && event.sessionKey !== ctx.sessionKey) ||
        event.stopHookActive
      )
        return;
      try {
        const current = ensure().engine;
        const { flow, node } = current.submissionOwner(ctx.sessionKey, ctx.runId);
        assertParent(flow);
        if (node.completion || node.completionMode !== 'tool') return;
        const error = lastSubmissionError(event.messages, ctx.runId);
        const instruction = submissionCorrectionInstructions(node.kind as 'work' | 'verify', error);
        // Native finalize revisions may rewind and are refused after potential
        // tool side effects. Queue a submission-only continuation in this same
        // session only after the engine confirms this run conclusively settled.
        current.requireSubmissionCorrection(ctx.sessionKey, ctx.runId, instruction);
      } catch {
        // Cancellation, policy changes and stale runs must not gain another pass.
        return;
      }
    });
    api.registerTool(
      {
        contextVersion: 2,
        create: ctx => {
          const node = state.store
            ?.all()
            .flatMap(flow => flow.nodes)
            .find(item => item.sessionKey === ctx.sessionKey);
          if (!node || !['work', 'verify'].includes(node.kind)) return null;
          return [
            node.kind === 'verify' ? FLOW_TOOLS.verify : FLOW_TOOLS.complete,
            FLOW_TOOLS.block,
          ].map(name => ({
            name,
            label:
              name === FLOW_TOOLS.verify
                ? 'Submit Swarm verification'
                : name === FLOW_TOOLS.block
                  ? 'Report Swarm blocker'
                  : 'Submit Swarm task result',
            description:
              name === FLOW_TOOLS.verify
                ? 'Submit your assigned verification verdict with concrete evidence. passed=true requires the original goal to be satisfied; report passed=false with exact missing work otherwise. On acceptance end the turn; prose or JSON in the final reply cannot replace this submission.'
                : name === FLOW_TOOLS.block
                  ? 'Report a genuine unmet prerequisite or external blocker for your assigned node. Include what is needed and evidence. Do not report incomplete work as success. On acceptance end the turn.'
                  : 'Submit the completed result of your assigned task, with deliverable/evidence references and limitations. On acceptance end the turn. If rejected, correct the fields and submit again while the run is active.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                summary: {
                  type: 'string',
                  minLength: 1,
                  maxLength: SUBMISSION_LIMITS.summary,
                  description:
                    'Optional concise summary; if omitted, derived from the submitted evidence.',
                },
                evidence: {
                  description:
                    'Required concrete results, deliverable references or blocker details; text or a list of strings.',
                  anyOf: [
                    { type: 'string', minLength: 1, maxLength: SUBMISSION_LIMITS.evidenceReport },
                    {
                      type: 'array',
                      minItems: 1,
                      maxItems: SUBMISSION_LIMITS.evidenceCount,
                      items: {
                        type: 'string',
                        minLength: 1,
                        maxLength: SUBMISSION_LIMITS.evidenceItem,
                      },
                    },
                  ],
                },
                ...(name === FLOW_TOOLS.verify ? { passed: { type: 'boolean' } } : {}),
              },
              required: name === FLOW_TOOLS.verify ? ['evidence', 'passed'] : ['evidence'],
            },
            async execute(toolCallId: string, input: unknown, signal?: AbortSignal) {
              const key = callKey(ctx.sessionKey!, toolCallId, name);
              try {
                const bound = submissionCalls.get(key);
                if (
                  !bound ||
                  bound.expiresAt <= Date.now() ||
                  bound.signal?.aborted ||
                  signal?.aborted
                )
                  throw new Error('Native submission authority is unavailable or expired.');
                ctx.assertInvocationCurrent();
                const submission = validateSubmission(
                  name === FLOW_TOOLS.verify
                    ? 'verified'
                    : name === FLOW_TOOLS.block
                      ? 'blocked'
                      : 'complete',
                  input,
                );
                const current = ensure().engine;
                const { flow } = current.submissionOwner(ctx.sessionKey!, bound.runId);
                assertParent(flow);
                ctx.assertInvocationCurrent();
                current.submit(ctx.sessionKey!, bound.runId, submission);
                const result = {
                  accepted: true,
                  message:
                    'Submission persisted. End this turn now; dependent tasks wait for native execution to settle.',
                };
                return {
                  details: result,
                  content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                };
              } catch (error) {
                const result = {
                  accepted: false,
                  error: String(error),
                  message:
                    'No new terminal submission was recorded. Correct invalid fields and submit again if this run remains active; do not claim acceptance.',
                };
                return {
                  isError: true,
                  details: result,
                  content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                };
              } finally {
                submissionCalls.delete(key);
              }
            },
          }));
        },
      },
      { names: Object.values(FLOW_TOOLS) },
    );
    api.registerTool(
      {
        contextVersion: 2,
        create: ctx => {
          if (!managed(ctx.sessionKey) || !state.store) return null;
          const parentKey = ctx.sessionKey;
          return createManagementTools(parentKey, {
            current: ensure,
            assertParent,
            assertParentIdentity,
            invocation: (toolCallId, name) => {
              const bound = managementCalls.get(callKey(parentKey, toolCallId, name));
              return {
                runId: bound?.runId ?? '',
                assertCurrent: () => {
                  if (!bound || bound.expiresAt <= Date.now() || bound.signal?.aborted)
                    throw new Error('Native management authority is unavailable or expired.');
                  ctx.assertInvocationCurrent();
                  ensure();
                },
              };
            },
          });
        },
      },
      { names: Object.values(FLOW_MANAGEMENT_TOOLS) },
    );
    api.on('before_prompt_build', async (event, ctx) => {
      const assigned = state.store
        ?.all()
        .flatMap(flow => flow.nodes)
        .find(node => node.sessionKey === ctx.sessionKey);
      if (assigned && ['work', 'verify'].includes(assigned.kind)) {
        try {
          if (!ctx.runId) throw new Error('Missing run identity.');
          ensure().engine.submissionOwner(ctx.sessionKey!, ctx.runId);
          return {
            ...(assigned.submissionRepair?.runId === ctx.runId
              ? {
                  toolsAllow: [
                    assigned.kind === 'verify' ? FLOW_TOOLS.verify : FLOW_TOOLS.complete,
                    FLOW_TOOLS.block,
                  ],
                }
              : {}),
            prependSystemContext:
              (assigned.kind === 'verify'
                ? 'This is an assigned Swarm verification run. Inspect the work, then call swarm_flow_verify(passed, summary, evidence). Use swarm_flow_block for a genuine external blocker. A final prose/JSON reply does not submit a verdict. Correct rejected tool parameters and retry during this run. After an accepted submission, end the turn without further work.'
                : 'This is an assigned Swarm work run. Call swarm_flow_complete(summary, evidence) when the task meets its criteria, or swarm_flow_block(summary, evidence) for an unmet prerequisite. Final prose alone does not complete the task. Correct rejected tool parameters and retry during this run. After acceptance, end the turn without further work.') +
              ' ' +
              submissionInstructions(assigned.kind as 'work' | 'verify'),
          };
        } catch {
          return {
            toolsAllow: [],
            prependSystemContext:
              'This session does not own an active Swarm assignment. Do not execute or submit work.',
          };
        }
      }
      if (
        !managed(ctx.sessionKey) ||
        (ctx.inputProvenance && ctx.inputProvenance.kind !== 'external_user')
      )
        return;
      // The embedded runner does not yet expose the harness currentUserMessage
      // fields. Resolve only this run's exact admitted user entry via the public
      // history API; prompt text is a lookup hint, never launch authority.
      let message = event.currentUserMessage;
      let requestId = event.currentUserMessageId;
      if (message === undefined && ctx.runId && event.prompt?.includes('<justdo-swarm-flow ')) {
        try {
          const history = await rpc<{ messages?: Array<Record<string, unknown>> }>('chat.history', {
            sessionKey: ctx.sessionKey,
            limit: 20,
          });
          requestId = ctx.runId + ':user';
          const admitted = history.messages?.find(
            item => item.role === 'user' && item.idempotencyKey === requestId,
          );
          if (typeof admitted?.content === 'string') message = admitted.content;
          else if (Array.isArray(admitted?.content))
            message = admitted.content
              .filter(part => part.type === 'text' && typeof part.text === 'string')
              .map(part => part.text)
              .join('\n');
          if (message === undefined) throw new Error('Current admitted user entry is unavailable.');
        } catch {
          return {
            toolsAllow: [],
            prependSystemContext:
              'The Swarm request identity could not be confirmed. Tell the user execution has not started; do not execute this task yourself.',
          };
        }
      }
      const marker =
        typeof message === 'string'
          ? /\n\n<justdo-swarm-flow mode="(auto|research|review)"\/>$/.exec(message)
          : null;
      if (!marker || message === undefined) {
        if (state.store?.all().some(flow => flow.parentKey === ctx.sessionKey))
          return { prependSystemContext: MANAGEMENT_GUIDANCE };
        return;
      }
      try {
        if (!requestId) throw new Error('Missing stable native request identity.');
        ctx.hookInvocation?.assertActive();
        return {
          toolsAllow: ['swarm_flow_start'],
          prependSystemContext: `The user explicitly selected Swarm. Call swarm_flow_start now with mode ${JSON.stringify(marker[1])} and sourceRequestId ${JSON.stringify(requestId)}. Before calling, use this conversation and the current attachments to resolve references such as "the above plan" into a self-contained goal. Preserve the user's constraints and exact agent-assignment wording. Include accessible project file paths for attachments; describe relevant visible image details. The independent workers cannot see this conversation or its images. If essential content is inaccessible, state what is missing and do not invent it or claim a workflow started. Do not execute the task yourself or classify whether it merits Swarm. Only after the tool confirms acceptance, briefly acknowledge and end this turn. Progress appears in the Swarm tab and the final result will arrive here.`,
        };
      } catch (error) {
        return {
          toolsAllow: [],
          prependSystemContext:
            'The requested task flow could not be confirmed: ' +
            String(error) +
            '. Tell the user honestly and ask them to inspect the Swarm tab. Do not claim execution or substitute another workflow.',
        };
      }
    });
    api.registerGatewayMethod(
      FLOW_RPC.start,
      async ({ params, respond }) => {
        try {
          if (
            !managed(params.parentKey) ||
            typeof params.goal !== 'string' ||
            !params.goal.trim() ||
            params.goal.length > FLOW_LIMITS.goal ||
            (params.assignmentRequest !== undefined &&
              (typeof params.assignmentRequest !== 'string' ||
                params.assignmentRequest.length > FLOW_LIMITS.goal)) ||
            typeof params.requestId !== 'string' ||
            !params.requestId ||
            params.requestId.length > 256 ||
            !['auto', 'research', 'review'].includes(String(params.mode))
          )
            throw new Error('Invalid flow request.');
          const parent = entry(params.parentKey);
          if (
            !parent ||
            typeof parent.sessionId !== 'string' ||
            typeof parent.sessionRoot !== 'string' ||
            !path.isAbsolute(parent.sessionRoot) ||
            !['read-only', 'workspace', 'guarded', 'full'].includes(
              String(parent.permissionMode),
            ) ||
            (parent.justdoPlanMode as { enabled?: boolean } | undefined)?.enabled
          )
            throw new Error('Parent session is not ready for flow execution.');
          const agents = await availableAgents();
          if (!agents.some(agent => agent.id === DEFAULT_FLOW_AGENT))
            throw new Error('The default main agent is unavailable.');
          const result = ensure().engine.create({
            requestId: params.requestId,
            parentKey: params.parentKey,
            parentId: parent.sessionId,
            agentId: params.parentKey.split(':')[1],
            agents,
            cwd: parent.sessionRoot,
            permissionMode: String(parent.permissionMode),
            policy: parentPolicy(parent),
            goal: params.goal,
            assignmentRequest:
              typeof params.assignmentRequest === 'string' ? params.assignmentRequest : params.goal,
            mode: String(params.mode),
          });
          respond(true, viewFlow(result));
        } catch (error) {
          respond(false, undefined, { code: 'swarm_flow_error', message: String(error) });
        }
      },
      { scope: 'operator.admin' },
    );
    api.registerGatewayMethod(
      FLOW_RPC.list,
      ({ params, respond }) => {
        try {
          if (
            !Array.isArray(params.parentKeys) ||
            params.parentKeys.length > 8 ||
            !params.parentKeys.every(managed)
          )
            throw new Error('Invalid parent identities.');
          respond(true, {
            flows: ensure()
              .store.all()
              .filter(f => (params.parentKeys as string[]).includes(f.parentKey))
              .slice(0, 20)
              .map(viewFlow),
          });
        } catch (error) {
          respond(false, undefined, { code: 'swarm_flow_error', message: String(error) });
        }
      },
      { scope: 'operator.read' },
    );
    api.registerGatewayMethod(
      FLOW_RPC.detail,
      ({ params, respond }) => {
        try {
          if (
            !Array.isArray(params.parentKeys) ||
            !params.parentKeys.length ||
            params.parentKeys.length > 8 ||
            !params.parentKeys.every(managed) ||
            typeof params.id !== 'string' ||
            typeof params.nodeId !== 'string'
          )
            throw new Error('Invalid flow detail request.');
          const flow = ensure().store.get(params.id);
          if (!flow || !(params.parentKeys as string[]).includes(flow.parentKey))
            throw new Error('Flow does not belong to this conversation.');
          const node = flow.nodes.find(item => item.id === params.nodeId);
          if (!node) throw new Error('Flow node was not found.');
          if (
            params.sourceId !== undefined &&
            (typeof params.sourceId !== 'string' || !node.deps.includes(params.sourceId))
          )
            throw new Error('Flow dependency was not found.');
          respond(true, {
            flowId: flow.id,
            nodeId: node.id,
            sessionKey: node.sessionKey,
            workingDirectory: flow.cwd,
            revision: flow.revision,
            interventions: node.interventions ?? [],
            ...interventionAvailability(flow, node),
            // Launch envelopes are workflow state, not a second native transcript.
            dispatch: node.dispatch,
            submission:
              node.runId || node.endedAt
                ? 'submitted'
                : node.intendedRunId
                  ? 'uncertain'
                  : 'not_sent',
          });
        } catch (error) {
          respond(false, undefined, { code: 'swarm_flow_error', message: String(error) });
        }
      },
      { scope: 'operator.read' },
    );
    api.registerGatewayMethod(
      FLOW_RPC.intervene,
      ({ params, respond }) => {
        try {
          if (
            !Array.isArray(params.parentKeys) ||
            !params.parentKeys.length ||
            params.parentKeys.length > 8 ||
            !params.parentKeys.every(managed) ||
            typeof params.id !== 'string' ||
            typeof params.nodeId !== 'string' ||
            !Number.isSafeInteger(params.revision)
          )
            throw new Error('Invalid intervention request.');
          const { store, engine } = ensure();
          const flow = store.get(params.id);
          if (!flow || !(params.parentKeys as string[]).includes(flow.parentKey))
            throw new Error('Flow does not belong to this conversation.');
          assertParent(flow);
          respond(
            true,
            viewFlow(
              engine.intervene(
                params.id,
                params.nodeId,
                params.revision as number,
                params.intervention,
              ),
            ),
          );
        } catch (error) {
          respond(false, undefined, { code: 'swarm_flow_error', message: String(error) });
        }
      },
      { scope: 'operator.admin' },
    );
    api.registerGatewayMethod(
      FLOW_RPC.control,
      ({ params, respond }) => {
        try {
          if (
            !Array.isArray(params.parentKeys) ||
            params.parentKeys.length > 8 ||
            !params.parentKeys.every(managed) ||
            typeof params.id !== 'string' ||
            !Number.isSafeInteger(params.revision) ||
            typeof params.action !== 'string' ||
            !['pause', 'resume', 'stop', 'retry'].includes(params.action)
          )
            throw new Error('Invalid flow control.');
          const { store: currentStore, engine: currentEngine } = ensure();
          const flow = currentStore.get(params.id);
          if (!flow || !(params.parentKeys as string[]).includes(flow.parentKey))
            throw new Error('Flow does not belong to this conversation.');
          if (['pause', 'stop'].includes(String(params.action))) assertParentIdentity(flow);
          else assertParent(flow);
          respond(
            true,
            viewFlow(
              currentEngine.control(
                params.id,
                params.revision as number,
                params.action as FlowAction,
              ),
            ),
          );
        } catch (error) {
          respond(false, undefined, { code: 'swarm_flow_error', message: String(error) });
        }
      },
      { scope: 'operator.admin' },
    );
    api.registerTool(
      ctx => {
        if (!managed(ctx.sessionKey)) return null;
        return {
          name: 'swarm_flow_start',
          label: 'Start Swarm task flow',
          description:
            'Start a durable task flow ONLY when the user requests Swarm/task-flow execution. Supply a self-contained goal resolving conversation references and attachment content; workers do not inherit chat history or images. Preserve exact user agent assignments and constraints. The service independently plans, executes, verifies and delivers here. After acceptance end the turn without duplicating work. One unfinished flow per conversation. No Workboard dependency.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              goal: { type: 'string', minLength: 1, maxLength: FLOW_LIMITS.goal },
              mode: { type: 'string', enum: ['auto', 'research', 'review'] },
              sourceRequestId: { type: 'string', minLength: 1, maxLength: 256 },
            },
            required: ['goal', 'mode'],
          },
          async execute(_toolCallId: string, input: unknown, signal?: AbortSignal) {
            if (signal?.aborted) throw new Error('Flow request cancelled.');
            if (!object(input)) throw new Error('Invalid flow request.');
            const history = await rpc<{ messages?: Array<Record<string, unknown>> }>(
              'chat.history',
              {
                sessionKey: ctx.sessionKey,
                limit: 20,
              },
            );
            const latestUser = [...(history.messages ?? [])]
              .reverse()
              .find(item => item.role === 'user');
            const content =
              typeof latestUser?.content === 'string'
                ? latestUser.content
                : Array.isArray(latestUser?.content)
                  ? latestUser.content
                      .filter(part => part.type === 'text' && typeof part.text === 'string')
                      .map(part => part.text)
                      .join('\n')
                  : '';
            const sourceRequestId = latestUser?.idempotencyKey;
            if (
              typeof sourceRequestId !== 'string' ||
              !sourceRequestId ||
              sourceRequestId.length > 256 ||
              (input.sourceRequestId !== undefined && input.sourceRequestId !== sourceRequestId)
            )
              throw new Error('The source Swarm request is no longer current.');
            const sourceMarker = /\n\n<justdo-swarm-flow mode="(auto|research|review)"\/>$/.exec(
              content,
            );
            if (sourceMarker && sourceMarker[1] !== input.mode)
              throw new Error('The source Swarm mode does not match.');
            const assignmentRequest = sourceMarker ? content.slice(0, sourceMarker.index) : content;
            ctx.assertInvocationCurrent?.();
            const flow = await rpc(FLOW_RPC.start, {
              parentKey: ctx.sessionKey,
              requestId: sourceRequestId,
              assignmentRequest,
              goal: input.goal,
              mode: input.mode,
            });
            return {
              details: { flow },
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    flow,
                    message:
                      'Flow accepted. The Gateway service now owns execution. Report the flow started, then end this turn; do not duplicate the task. Final delivery will be injected into this conversation.',
                  }),
                },
              ],
            };
          },
        };
      },
      { name: 'swarm_flow_start' },
    );
  },
};
