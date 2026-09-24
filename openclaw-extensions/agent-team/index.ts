import { randomUUID } from 'node:crypto';

import type { OpenClawPluginApi, OpenClawPluginGatewayEvents } from 'openclaw/plugin-sdk/core';
import { isSubagentSessionKey } from 'openclaw/plugin-sdk/routing';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { createSessionVisibilityChecker } from 'openclaw/plugin-sdk/session-visibility';
import { Type } from 'typebox';

const managed = (key?: string) => Boolean(key && /^agent:[^:]+:justdo:[^:]+$/.test(key));
const CREATE = 'assistants_create';
const ASSISTANTS = 'task_assistants';
const HOST_REQUEST_TIMEOUT_MS = 8000;
const plugin = {
  id: 'agent-team',
  name: 'Agent Team',
  register(api: OpenClawPluginApi) {
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
        const timeoutMs = payload.operation === 'create' ? 60000 : HOST_REQUEST_TIMEOUT_MS;
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
    const rpc = (method: string, params: Record<string, unknown>) =>
      api.runtime.gateway.request(method, params, {
        scopes: ['operator.admin', 'operator.read', 'operator.write'],
        ...(params.operation === 'create' ? { timeoutMs: 75000 } : {}),
      });
    api.registerService({
      id: 'agent-team',
      start(ctx) {
        removeAccess ??= registerAccess();
        emit = ctx.gatewayEvents?.emit;
      },
      stop() {
        removeAccess?.();
        removeAccess = undefined;
        nativeCalls.clear();
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
        const item =
          typeof params.requestId === 'string' ? pending.get(params.requestId) : undefined;
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
      'collaboration.bind',
      ({ params, respond }) => {
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
            respond(
              true,
              await requestHost({ operation: 'members', sessionKey: params.sessionKey }),
            );
            return;
          }
          if (
            !['create', 'ensure', 'native-send', 'native-result'].includes(
              String(params.operation),
            ) ||
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
          }) as { justdoPlanMode?: { enabled?: boolean } } | undefined;
          if (entry?.justdoPlanMode?.enabled && params.operation !== 'native-result')
            throw new Error('Collaboration sending is unavailable in Plan mode.');
          respond(
            true,
            await requestHost({
              operation: params.operation,
              sessionKey: params.sessionKey,
              sourceRunId: identity.runId,
              toolCallId: params.toolCallId,
              input: params.input,
            }),
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
        ![CREATE, ASSISTANTS, 'sessions_send'].includes(event.toolName) ||
        !managed(ctx.sessionKey)
      )
        return;
      // Native child-session messaging is not peer collaboration. Keep its
      // ownership/visibility checks in OpenClaw and do not consume team budget.
      if (
        event.toolName === 'sessions_send' &&
        typeof event.params?.sessionKey === 'string' &&
        isSubagentSessionKey(event.params.sessionKey)
      )
        return;
      if (event.toolName === ASSISTANTS && !event.params?.agentId) return;
      if (!ctx.runId || !ctx.toolCallId)
        return { block: true, blockReason: 'Missing native call identity.' };
      if (ctx.abortSignal?.aborted)
        return { block: true, blockReason: 'The tool call was cancelled.' };
      try {
        await rpc('collaboration.bind', {
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          toolCallId: ctx.toolCallId,
        });
        if (event.toolName === 'sessions_send') {
          if (typeof event.params.sessionKey !== 'string')
            return {
              block: true,
              blockReason:
                'Use task_assistants to prepare a task peer, then pass its exact sessionKey.',
            };
          // Pin the incarnation before host admission awaits. A reset must not
          // silently redirect an already admitted send to the replacement session.
          const targetEntry = getSessionEntry({
            sessionKey: event.params.sessionKey,
            readConsistency: 'latest',
          });
          if (!targetEntry?.sessionId) throw new Error('Collaboration target is unavailable.');
          const expectedSessionId = targetEntry.sessionId;
          const admission = (await rpc('collaboration.dispatch', {
            operation: 'native-send',
            sessionKey: ctx.sessionKey,
            toolCallId: ctx.toolCallId,
            input: event.params,
          })) as { error?: string; deliveryId: string; sessionKey: string };
          if (admission.error) return { block: true, blockReason: admission.error };
          if (ctx.abortSignal?.aborted)
            return { block: true, blockReason: 'The tool call was cancelled.' };
          for (const [key, call] of nativeCalls)
            if (call.expiresAt <= Date.now()) nativeCalls.delete(key);
          nativeCalls.set(`${ctx.sessionKey}|${ctx.toolCallId}`, {
            deliveryId: admission.deliveryId,
            target: admission.sessionKey,
            expectedSessionId,
            runId: ctx.runId,
            expiresAt: Date.now() + 60000,
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
      } catch {
        return { block: true, blockReason: 'Could not bind the native collaboration call.' };
      }
    });
    api.on('after_tool_call', async (event, ctx) => {
      if (event.toolName !== 'sessions_send' || !ctx.sessionKey || !ctx.toolCallId) return;
      const key = `${ctx.sessionKey}|${ctx.toolCallId}`;
      const call = nativeCalls.get(key);
      if (!call) return;
      nativeCalls.delete(key);
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
          status: outcome?.status ?? 'unknown',
          ...(typeof outcome?.runId === 'string' ? { runId: outcome.runId } : {}),
          ...(typeof outcome?.sentBeforeError === 'boolean'
            ? { sentBeforeError: outcome.sentBeforeError }
            : {}),
        },
      });
    });
    for (const operation of ['members', 'create'] as const) {
      api.registerTool(
        ctx => {
          if (!managed(ctx.sessionKey)) return null;
          return {
            name: operation === 'create' ? CREATE : ASSISTANTS,
            label: operation === 'create' ? 'Create assistant' : 'Collaboration members',
            description:
              operation === 'create'
                ? 'Create a persistent assistant when the user requests one. Native OpenClaw manages its workspace. Supply a name, description and AGENTS.md instructions; optionally choose an available provider/model. Omit model to use the configured default. This does not start a task or add the assistant to collaboration. Reusing a name returns the existing assistant without changing it. On incomplete creation, retry the same fields to resume; never claim success from an error.'
                : 'List task peers and available assistants. With agentId, prepare that assistant for this task and return its exact sessionKey. Does not send a message or start work. Then use native sessions_send. Prefer exact agentId; a unique display name is also accepted.',
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
                : Type.Object(
                    { agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) },
                    { additionalProperties: false },
                  ),
            async execute(toolCallId: string, input: unknown, signal?: AbortSignal) {
              if (signal?.aborted) throw new Error('The tool call was cancelled.');
              const result = await rpc('collaboration.dispatch', {
                operation:
                  operation === 'members' && (input as { agentId?: string })?.agentId
                    ? 'ensure'
                    : operation,
                sessionKey: ctx.sessionKey,
                toolCallId,
                input,
              });
              return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                isError: Boolean((result as { error?: unknown })?.error),
              };
            },
          };
        },
        { name: operation === 'create' ? CREATE : ASSISTANTS },
      );
    }
  },
};
export default plugin;
