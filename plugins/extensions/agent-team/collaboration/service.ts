import { randomUUID } from 'node:crypto';

import type { OpenClawPluginApi, OpenClawPluginGatewayEvents } from 'openclaw/plugin-sdk/core';
import { isAcpSessionKey, isSubagentSessionKey } from 'openclaw/plugin-sdk/routing';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { createSessionVisibilityChecker } from 'openclaw/plugin-sdk/session-visibility';
import { Type } from 'typebox';

import { readTeamLaunchCatalogMode } from '../../runtime-services/agent-team/launch/agent-team-launch-state';
import { hasUnsupportedDiscussionSourcePolicy } from '../discussion/discussion-source-policy';
import { CollaborationCallError, collaborationCallFailure } from './call-failure';

const managed = (key?: string) => Boolean(key && /^agent:[^:]+:justdo:[^:]+$/.test(key));
const DISCUSSION = 'team_discussion';
const CREATE = 'assistants_create';
const ASSISTANTS = 'task_assistants';
const DISCUSSION_ACTIONS = ['create', 'send', 'read', 'stop', 'configure'];
const DISCUSSION_LAUNCH_ACTIONS = ['create', 'read', 'stop'];
const DISCUSSION_READ_ACTIONS = ['read'];
const HOST_REQUEST_TIMEOUT_MS = 8000;
const HOST_PREPARATION_TIMEOUT_MS = 60000;
const GATEWAY_PREPARATION_TIMEOUT_MS = 75000;
const PREPARATION_OPERATIONS = new Set(['create', 'discussion', 'ensure']);
// Native outcomes can arrive after recovery. This identity grants no access
// and outlives the 60-second send grant.
const NATIVE_RECEIPT_TTL_MS = 10 * 60 * 1000;

export function registerCollaborationService(api: OpenClawPluginApi): void {
  const nativeCalls = new Map<
    string,
    {
      deliveryId: string;
      target: string;
      expectedSessionId: string;
      runId: string;
      expiresAt: number;
    }
  >();
  const hookCalls: typeof nativeCalls = new Map();
  // Keep the admitted receipt identity after revoking send access so a native
  // outcome cannot name an unrelated delivery or regain a send grant.
  const admittedCalls = new Map<
    string,
    {
      deliveryId: string;
      runId: string;
      target: string;
      expiresAt: number;
    }
  >();
  let serviceGeneration = 0;
  let removeAccess: (() => void) | undefined;
  const registerAccess = () =>
    createSessionVisibilityChecker.registerScopedAccessProvider(request => {
      if (request.action !== 'send') return;
      const active = [...nativeCalls.entries()].find(
        ([key, call]) =>
          key.startsWith(`${request.requesterSessionKey}|`) &&
          call.target === request.targetSessionKey &&
          call.expiresAt > Date.now(),
      );
      if (!active) return;
      return { expectedSessionId: active[1].expectedSessionId };
    });
  let emit: OpenClawPluginGatewayEvents['emit'] | undefined;
  // Gateway methods own this state. Hook and tool factories may use different plugin instances.
  const calls = new Map<string, { runId: string; expiresAt: number }>();
  const pending = new Map<
    string,
    { resolve: (result: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const requestHost = (payload: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (!emit) return reject(new Error('Collaboration service unavailable.'));
      const requestId = randomUUID();
      const timeoutMs = PREPARATION_OPERATIONS.has(String(payload.operation))
        ? HOST_PREPARATION_TIMEOUT_MS
        : HOST_REQUEST_TIMEOUT_MS;
      const expiresAt = Date.now() + timeoutMs;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Collaboration host did not respond.'));
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      try {
        // The host must stop native preparation before this request expires; a late
        // completion must not dispatch work after the model has received a timeout.
        emit('requested', { ...payload, requestId, expiresAt }, { scope: 'operator.read' });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  const rpc = async (method: string, params: Record<string, unknown>) => {
    try {
      return await api.runtime.gateway.request(method, params, {
        scopes: ['operator.admin', 'operator.read', 'operator.write'],
        ...(PREPARATION_OPERATIONS.has(String(params.operation))
          ? { timeoutMs: GATEWAY_PREPARATION_TIMEOUT_MS }
          : {}),
      });
    } catch (error) {
      const failure = collaborationCallFailure(error);
      api.logger.warn(
        `[AgentTeam] native RPC failed method=${method} reason=${failure.reason} reference=${failure.reference}`,
      );
      throw new CollaborationCallError(method, error);
    }
  };
  api.registerService({
    id: 'agent-team',
    start(ctx) {
      removeAccess ??= registerAccess();
      emit = ctx.gatewayEvents?.emit;
    },
    stop() {
      serviceGeneration += 1;
      removeAccess?.();
      removeAccess = undefined;
      nativeCalls.clear();
      hookCalls.clear();
      admittedCalls.clear();
      emit = undefined;
      calls.clear();
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve({ error: 'Collaboration stopped.' });
      }
      pending.clear();
    },
  });
  api.registerGatewayMethod(
    'collaboration.resolve',
    ({ params, respond }) => {
      const item = typeof params.requestId === 'string' ? pending.get(params.requestId) : undefined;
      if (!item) {
        respond(true, { stale: true });
        return;
      }
      pending.delete(params.requestId as string);
      clearTimeout(item.timer);
      item.resolve(params.result);
      respond(true, { ok: true });
    },
    { scope: 'operator.write' },
  );
  api.registerGatewayMethod(
    'collaboration.health',
    ({ respond }) => respond(true, { version: 2 }),
    { scope: 'operator.read' },
  );
  api.registerGatewayMethod(
    'collaboration.release',
    ({ params, respond }) => {
      const key = `${params.sessionKey}|${params.toolCallId}`;
      const call = nativeCalls.get(key);
      if (call?.runId === params.runId) nativeCalls.delete(key);
      const bindingKey = `${params.sessionKey}:${params.toolCallId}`;
      if (calls.get(bindingKey)?.runId === params.runId) calls.delete(bindingKey);
      respond(true, { ok: true });
    },
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    'collaboration.bind',
    ({ params, respond }) => {
      if (!emit) {
        respond(false, undefined, {
          code: 'invalid_request',
          message: 'Collaboration service unavailable.',
        });
        return;
      }
      if (
        typeof params.sessionKey !== 'string' ||
        !managed(params.sessionKey) ||
        typeof params.toolCallId !== 'string' ||
        !params.toolCallId ||
        params.toolCallId.length > 256 ||
        typeof params.runId !== 'string' ||
        !params.runId ||
        params.runId.length > 256
      ) {
        respond(false, undefined, {
          code: 'invalid_request',
          message: 'Missing native call identity.',
        });
        return;
      }
      for (const [key, call] of calls) if (call.expiresAt < Date.now()) calls.delete(key);
      const key = `${params.sessionKey}:${params.toolCallId}`;
      if (calls.has(key) || calls.size >= 512) {
        respond(false, undefined, {
          code: 'invalid_request',
          message: 'Native call identity is already bound.',
        });
        return;
      }
      calls.set(key, { runId: params.runId, expiresAt: Date.now() + 30000 });
      respond(true, { ok: true });
    },
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    'collaboration.dispatch',
    async ({ params, respond }) => {
      try {
        if (typeof params.sessionKey !== 'string' || !managed(params.sessionKey))
          throw new Error('Invalid collaboration session.');
        if (params.operation === 'members') {
          respond(true, await requestHost({ operation: 'members', sessionKey: params.sessionKey }));
          return;
        }
        if (
          ![
            'create',
            'discussion',
            'ensure',
            'seal',
            'review',
            'native-send',
            'native-result',
          ].includes(String(params.operation)) ||
          typeof params.toolCallId !== 'string'
        )
          throw new Error('Invalid collaboration operation.');
        const key = `${params.sessionKey}:${params.toolCallId}`;
        const identity = calls.get(key);
        calls.delete(key);
        if (!identity || identity.expiresAt < Date.now())
          throw new Error('The native tool call is no longer active.');
        const entry = getSessionEntry({
          sessionKey: params.sessionKey,
          readConsistency: 'latest',
        }) as
          { pluginExtensions?: { 'plan-mode'?: { state?: { enabled?: boolean } } } } | undefined;
        if (
          entry?.pluginExtensions?.['plan-mode']?.state?.enabled === true &&
          params.operation !== 'native-result'
        )
          throw new Error('Collaboration sending is unavailable in Plan mode.');
        const callKey = `${params.sessionKey}|${params.toolCallId}`;
        const input = params.input as Record<string, unknown> | undefined;
        if (
          params.operation === 'discussion' &&
          ['create', 'send', 'configure'].includes(String(input?.action)) &&
          hasUnsupportedDiscussionSourcePolicy(entry)
        )
          throw new Error('teamDiscussionSourcePolicyUnsupported');
        if (params.operation === 'native-result') {
          const admitted = admittedCalls.get(callKey);
          if (
            !admitted ||
            admitted.expiresAt <= Date.now() ||
            admitted.runId !== identity.runId ||
            admitted.deliveryId !== input?.deliveryId ||
            admitted.target !== input?.targetSessionKey
          )
            throw new Error('The native collaboration receipt is no longer active.');
          nativeCalls.delete(callKey);
          admittedCalls.delete(callKey);
        }
        // Admission and the scoped provider must share the Gateway-owned map:
        // execution hooks can be materialized in another plugin registration.
        const target =
          params.operation === 'native-send' && typeof input?.sessionKey === 'string'
            ? input.sessionKey
            : undefined;
        const expectedSessionId = target
          ? getSessionEntry({
              sessionKey: target,
              readConsistency: 'latest',
            })?.sessionId
          : undefined;
        if (params.operation === 'native-send' && !expectedSessionId)
          throw new Error('Collaboration target is unavailable.');
        const generation = serviceGeneration;
        const result = (await requestHost({
          operation: params.operation,
          sessionKey: params.sessionKey,
          sourceRunId: identity.runId,
          toolCallId: params.toolCallId,
          input,
        })) as { error?: string; deliveryId?: string; sessionKey?: string };
        if (generation !== serviceGeneration || !emit) throw new Error('Collaboration stopped.');
        if (params.operation === 'native-send' && !result.error) {
          if (!target || !result.deliveryId || result.sessionKey !== target || !expectedSessionId)
            throw new Error('Invalid collaboration admission.');
          for (const [key, call] of nativeCalls)
            if (call.expiresAt <= Date.now()) nativeCalls.delete(key);
          for (const [key, call] of admittedCalls)
            if (call.expiresAt <= Date.now()) admittedCalls.delete(key);
          if (admittedCalls.size >= 512) throw new Error('Too many active collaboration calls.');
          admittedCalls.set(callKey, {
            deliveryId: result.deliveryId,
            runId: identity.runId,
            target,
            expiresAt: Date.now() + NATIVE_RECEIPT_TTL_MS,
          });
          nativeCalls.set(callKey, {
            deliveryId: result.deliveryId,
            target,
            expectedSessionId,
            runId: identity.runId,
            expiresAt: Date.now() + 60000,
          });
        }
        respond(
          true,
          params.operation === 'native-send' && !result.error
            ? { ...result, expectedSessionId }
            : result,
        );
      } catch (error) {
        respond(false, undefined, {
          code: 'invalid_request',
          message: error instanceof Error ? error.message : 'Collaboration failed.',
        });
      }
    },
    { scope: 'operator.write' },
  );
  api.on('before_tool_call', async (event, ctx) => {
    if (
      ![CREATE, ASSISTANTS, DISCUSSION, 'sessions_send'].includes(event.toolName) ||
      !managed(ctx.sessionKey)
    )
      return;
    // Native child-session messaging is not peer collaboration. OpenClaw
    // checks ownership and visibility for both native and ACP children.
    if (
      event.toolName === 'sessions_send' &&
      typeof event.params?.sessionKey === 'string' &&
      (isSubagentSessionKey(event.params.sessionKey) || isAcpSessionKey(event.params.sessionKey))
    )
      return;
    // Peer receipts identify a newly admitted turn. Steering keeps the active
    // owner run, notifications have no run, and resume belongs to native tasks.
    // Reject those modes before reserving a room delivery or scoped access.
    if (
      event.toolName === 'sessions_send' &&
      event.params?.mode !== undefined &&
      event.params.mode !== 'followup'
    )
      return {
        block: true,
        blockReason:
          'Task peers support sessions_send with mode=followup or no mode. Other modes require native child-session coordination.',
      };
    if (
      event.toolName === ASSISTANTS &&
      !event.params?.agentId &&
      event.params?.seal !== true &&
      !event.params?.review
    )
      return;
    if (!ctx.runId || !ctx.toolCallId)
      return { block: true, blockReason: 'Missing native call identity.' };
    if (ctx.abortSignal?.aborted)
      return { block: true, blockReason: 'The tool call was cancelled.' };
    if (event.toolName === 'sessions_send' && typeof event.params.sessionKey !== 'string')
      return {
        block: true,
        blockReason: 'Use task_assistants to prepare a task peer, then pass its exact sessionKey.',
      };
    try {
      await rpc('collaboration.bind', {
        sessionKey: ctx.sessionKey,
        runId: ctx.runId,
        toolCallId: ctx.toolCallId,
      });
      if (event.toolName === 'sessions_send') {
        const admission = (await rpc('collaboration.dispatch', {
          operation: 'native-send',
          sessionKey: ctx.sessionKey,
          toolCallId: ctx.toolCallId,
          input: event.params,
        })) as {
          error?: string;
          deliveryId: string;
          sessionKey: string;
          expectedSessionId: string;
        };
        if (admission.error) return { block: true, blockReason: admission.error };
        if (ctx.abortSignal?.aborted) {
          try {
            await rpc('collaboration.release', {
              sessionKey: ctx.sessionKey,
              toolCallId: ctx.toolCallId,
              runId: ctx.runId,
            });
          } catch {
            // The bound result also revokes access if eager release failed.
          }
          await rpc('collaboration.bind', {
            sessionKey: ctx.sessionKey,
            toolCallId: ctx.toolCallId,
            runId: ctx.runId,
          });
          await rpc('collaboration.dispatch', {
            operation: 'native-result',
            sessionKey: ctx.sessionKey,
            toolCallId: ctx.toolCallId,
            input: {
              deliveryId: admission.deliveryId,
              targetSessionKey: admission.sessionKey,
              status: 'cancelled',
            },
          });
          return { block: true, blockReason: 'The tool call was cancelled.' };
        }
        for (const [key, call] of hookCalls)
          if (call.expiresAt <= Date.now()) hookCalls.delete(key);
        hookCalls.set(`${ctx.sessionKey}|${ctx.toolCallId}`, {
          deliveryId: admission.deliveryId,
          target: admission.sessionKey,
          expectedSessionId: admission.expectedSessionId,
          runId: ctx.runId,
          expiresAt: Date.now() + NATIVE_RECEIPT_TTL_MS,
        });
        return {
          params: {
            sessionKey: admission.sessionKey,
            message: event.params.message,
            timeoutSeconds: 0,
            watch: false,
          },
        };
      }
    } catch (error) {
      return {
        block: true,
        blockReason:
          error instanceof CollaborationCallError
            ? error.message
            : 'Could not authorize the native collaboration call. Report this error and stop retrying within this run.',
      };
    }
  });
  api.on('after_tool_call', async (event, ctx) => {
    if (event.toolName !== 'sessions_send' || !ctx.sessionKey || !ctx.toolCallId) return;
    const key = `${ctx.sessionKey}|${ctx.toolCallId}`;
    const call = hookCalls.get(key);
    if (!call || call.runId !== ctx.runId) return;
    hookCalls.delete(key);
    try {
      await rpc('collaboration.release', {
        sessionKey: ctx.sessionKey,
        toolCallId: ctx.toolCallId,
        runId: call.runId,
      });
    } catch {
      // Report the native outcome even if eager revocation fails. The
      // native-result dispatcher also revokes this grant before host delivery.
    }
    const result = event.result as
      { details?: Record<string, unknown>; content?: Array<{ text?: string }> } | undefined;
    let outcome = result?.details;
    if (!outcome) {
      try {
        outcome = JSON.parse(result?.content?.find(item => item.text)?.text ?? '{}');
      } catch {
        /* Transport outcome remains unknown. */
      }
    }
    await rpc('collaboration.bind', {
      sessionKey: ctx.sessionKey,
      runId: call.runId,
      toolCallId: ctx.toolCallId,
    });
    await rpc('collaboration.dispatch', {
      operation: 'native-result',
      sessionKey: ctx.sessionKey,
      toolCallId: ctx.toolCallId,
      input: {
        deliveryId: call.deliveryId,
        targetSessionKey: call.target,
        status: outcome?.status ?? 'unknown',
        ...(typeof outcome?.runId === 'string' ? { runId: outcome.runId } : {}),
        ...(typeof outcome?.sentBeforeError === 'boolean'
          ? { sentBeforeError: outcome.sentBeforeError }
          : {}),
      },
    });
  });
  api.registerTool(
    ctx => {
      if (!managed(ctx.sessionKey)) return null;
      const catalogMode = readTeamLaunchCatalogMode(api.runtime.state.resolveStateDir(), {
        sessionKey: ctx.sessionKey!,
        sessionId: ctx.sessionId,
      });
      if (catalogMode === 'blocked') return null;
      const readOnly = catalogMode === 'collaboration';
      const actions = readOnly
        ? DISCUSSION_READ_ACTIONS
        : catalogMode === 'discussion'
          ? DISCUSSION_LAUNCH_ACTIONS
          : DISCUSSION_ACTIONS;
      return {
        name: DISCUSSION,
        label: 'Team discussion',
        description: readOnly
          ? 'Read existing group discussion context for task collaboration. Use action:"read" and the existing roomId. Optionally filter batches with exact discussionIds.'
          : catalogMode === 'discussion'
            ? 'Organize the selected group discussion. Discover real assistant IDs with task_assistants first. Use action:"create" with a topic and 2–6 assistant IDs, excluding the source assistant. If organizerParticipates:true, include 1–5 other assistants. Omit organizerParticipates and rounds to follow the user’s settings; task_assistants returns current limits. The discussion inherits the source project, permissions and tool/execution configuration without group-specific tool restrictions. Results automatically return here with the source tools available to continue any outstanding user-authorized task. Use the existing roomId with action:"read" for public replies or action:"stop" to end a discussion. After an accepted launch, return control so its result handoff can resume the task; accepted means started, not completed.'
            : 'Organize a group discussion from the main task. Discover real assistant IDs with task_assistants first. create selects 2–6 participants (exclude this source assistant from agentIds; organizerParticipates:true counts the same source conversation as one participant, allowing 1–5 other assistants). When omitted, organizerParticipates uses the user’s Agent Team settings (factory default false); task_assistants returns current limits. configure changes organizerParticipates only while idle. Completed or partially failed discussions automatically hand their results back to this source conversation, which can use its normal tools to continue the user’s outstanding task. read accepts exact discussionIds for delayed summaries. create sends the initial topic, inheriting the source project, permissions and tool/execution configuration. Discussion and handoff turns add no tool restrictions; native permissions and approvals still apply. The user can participate directly in the team panel. send explicitly forwards context to an existing room; do not automatically broadcast every user message. read returns public replies; stop ends discussion. Omitted rounds use the user’s configured default. Respect task_assistants limits: rounds have a product ceiling of 4, but the user may set a lower maximum. Member, response and concurrency limits are enforced by the host. Accepted means started, not completed. Do not poll in a loop; return control after starting so the result handoff can resume the task. Existing collaboration uses task_assistants plus sessions_send, not this tool. teamDiscussionSourcePolicyUnsupported means the source has creation-owned isolation or a runtime that independent group sessions cannot safely inherit. Explain the limitation and remain in the current conversation; do not weaken those restrictions.',
        parameters: Type.Object(
          {
            action: Type.Union(actions.map(value => Type.Literal(value))),
            roomId: readOnly
              ? Type.String({ minLength: 1 })
              : Type.Optional(Type.String({ minLength: 1 })),
            discussionIds: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
                minItems: 1,
                maxItems: 20,
              }),
            ),
            ...(!readOnly
              ? {
                  title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
                  organizerParticipates: Type.Optional(Type.Boolean()),
                  agentIds: Type.Optional(
                    Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 6 }),
                  ),
                  message: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
                  rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
                }
              : {}),
            ...(catalogMode === undefined
              ? {
                  selectedAgentIds: Type.Optional(
                    Type.Array(Type.String({ minLength: 1 }), { maxItems: 6 }),
                  ),
                }
              : {}),
          },
          { additionalProperties: false },
        ),
        async execute(toolCallId: string, input: unknown, signal?: AbortSignal) {
          if (signal?.aborted) throw new Error('The tool call was cancelled.');
          const result = await rpc('collaboration.dispatch', {
            operation: 'discussion',
            sessionKey: ctx.sessionKey,
            toolCallId,
            input,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
            isError: Boolean((result as { error?: unknown })?.error),
          };
        },
      };
    },
    { name: DISCUSSION },
  );
  for (const operation of ['members', 'create'] as const) {
    api.registerTool(
      ctx => {
        if (!managed(ctx.sessionKey)) return null;
        const catalogMode = readTeamLaunchCatalogMode(api.runtime.state.resolveStateDir(), {
          sessionKey: ctx.sessionKey!,
          sessionId: ctx.sessionId,
        });
        if (catalogMode === 'blocked') return null;
        const discoveryOnly = operation === 'members' && catalogMode === 'discussion';
        return {
          name: operation === 'create' ? CREATE : ASSISTANTS,
          label: operation === 'create' ? 'Create assistant' : 'Collaboration members',
          description:
            operation === 'create'
              ? 'Create a persistent assistant when the user requests one. Native OpenClaw manages its workspace. Supply a name, description and AGENTS.md instructions; optionally choose an available provider/model. Omit model to use the configured default. This does not start a task or add the assistant to collaboration. Reusing a name returns the existing assistant without changing it. On incomplete creation, retry the same fields to resume; never claim success from an error.'
              : discoveryOnly
                ? 'Discover available assistants, exact assistant IDs and current Agent Team settings for the selected group discussion. Call with no arguments, then use the returned identities and limits with team_discussion.'
                : 'List task peers, recent exact delivery/execution receipts, review reports and available assistants. With agentId, prepare a peer without starting it, then use native sessions_send. An independent reviewer invited by the organizer may report its final review with review:{deliveryIds:[exact worker receipt IDs],verdict:"passed"|"changes_requested"|"unverified"}; keep findings and evidence in native replies. Only completed worker runs in the same batch can be reviewed; never review your own work or the organizer. Report once per reviewer run, then send findings to the organizer and finish. A report is pending until the whole reviewer run settles. The organizer seals the batch with seal:true only after required results and reviews arrive; sealing is not proof of quality and does not stop accepted work. Do not combine agentId, seal and review.',
          parameters:
            operation === 'create'
              ? Type.Object(
                  {
                    name: Type.String({ minLength: 1, maxLength: 80 }),
                    description: Type.String({ maxLength: 2000 }),
                    instructions: Type.String({ minLength: 1, maxLength: 100000 }),
                    model: Type.Optional(Type.String({ maxLength: 256 })),
                  },
                  { additionalProperties: false },
                )
              : discoveryOnly
                ? Type.Object({}, { additionalProperties: false })
                : Type.Object(
                    {
                      agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
                      seal: Type.Optional(Type.Boolean()),
                      review: Type.Optional(
                        Type.Object(
                          {
                            deliveryIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
                              minItems: 1,
                              maxItems: 16,
                              uniqueItems: true,
                            }),
                            verdict: Type.Union([
                              Type.Literal('passed'),
                              Type.Literal('changes_requested'),
                              Type.Literal('unverified'),
                            ]),
                          },
                          { additionalProperties: false },
                        ),
                      ),
                    },
                    { additionalProperties: false },
                  ),
          async execute(toolCallId: string, input: unknown, signal?: AbortSignal) {
            if (signal?.aborted) throw new Error('The tool call was cancelled.');
            const result = await rpc('collaboration.dispatch', {
              operation:
                operation === 'members' && (input as { review?: unknown })?.review
                  ? 'review'
                  : operation === 'members' && (input as { seal?: boolean })?.seal === true
                    ? 'seal'
                    : operation === 'members' && (input as { agentId?: string })?.agentId
                      ? 'ensure'
                      : operation,
              sessionKey: ctx.sessionKey,
              toolCallId,
              input,
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result) }],
              details: result,
              isError: Boolean((result as { error?: unknown })?.error),
            };
          },
        };
      },
      { name: operation === 'create' ? CREATE : ASSISTANTS },
    );
  }
}
