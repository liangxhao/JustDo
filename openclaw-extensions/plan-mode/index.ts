import { randomUUID } from 'node:crypto';

import type { OpenClawPluginApi, OpenClawPluginGatewayEvents } from 'openclaw/plugin-sdk/core';
import { isReplaySafeToolCall } from 'openclaw/plugin-sdk/agent-harness-runtime';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { Type } from 'typebox';

const PLUGIN_ID = 'plan-mode';
const STATE_NAMESPACE = 'state';
const SESSION_SLOT_KEY = 'justdoPlanMode';
const PRESENT_PLAN_TOOL = 'PresentPlan';
const POLICY_ID = 'plan-mode-read-only';
const LIST_METHOD = 'planMode.list';
const RESOLVE_METHOD = 'planMode.resolve';
const MAX_PLAN_LENGTH = 64 * 1024;

type UnknownRecord = Record<string, unknown>;
type PlanDecision = 'implement' | 'revise' | 'cancel';
type PlanState = { enabled: boolean; updatedAt: number };
type PlanRequest = {
  requestId: string;
  sessionKey: string;
  plan: string;
  title?: string;
};
type PlanResponse = { decision: PlanDecision; feedback?: string };
type PendingPlan = {
  request: PlanRequest;
  resolve: (response: PlanResponse) => void;
  removeAbortListener?: () => void;
};

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isJustDoSession = (sessionKey: string | undefined): sessionKey is string =>
  Boolean(sessionKey && /^agent:[^:]+:justdo:/i.test(sessionKey));

const readPlanState = (sessionKey: string | undefined): PlanState | null => {
  if (!isJustDoSession(sessionKey)) return null;
  const entry = getSessionEntry({ sessionKey, readConsistency: 'latest' }) as
    (UnknownRecord & { justdoPlanMode?: unknown }) | undefined;
  const state = entry?.justdoPlanMode;
  if (!isRecord(state) || typeof state.enabled !== 'boolean') return null;
  return {
    enabled: state.enabled,
    updatedAt:
      typeof state.updatedAt === 'number' && Number.isFinite(state.updatedAt) ? state.updatedAt : 0,
  };
};

const PLAN_MODE_INSTRUCTIONS = `<plan_mode>
You are in Plan mode. Explore the task and repository before proposing implementation.

Rules:
- Do not modify files, run commands that mutate state, install dependencies, create commits, or perform external side effects.
- Use read-only inspection and searches to remove uncertainty. Ask the user only when a decision cannot be inferred safely.
- Produce a concrete, decision-complete implementation plan grounded in the code you inspected.
- When ready, call the directly available tool named PresentPlan exactly once with the complete Markdown plan. PresentPlan is the tool name; plan-mode is only the plugin id and must never be passed to tool_search, tool_describe, or tool_call.
- Do not implement until PresentPlan returns an explicit implementation approval.
- If PresentPlan returns revision feedback, revise the plan and call PresentPlan again.
- If it returns implementation approval, Plan mode has been disabled and you should carry out the approved plan in the current session.
</plan_mode>`;

const ALWAYS_MUTATING_TOOLS = new Set([
  'apply_patch',
  'assistants_create',
  'conversations_send',
  'conversations_turn',
  'create_goal',
  'dashboard',
  'dismiss_task',
  'edit',
  'execute',
  'heartbeat_respond',
  'openclaw',
  'progress_card',
  'sessions_send',
  'sessions_spawn',
  'sessions_yield',
  'show_widget',
  'suggest_task',
  'update_goal',
  'terminal',
  'tool_search_code',
  'tts',
  'write',
]);

// Tool Search dispatchers are intentionally absent here. OpenClaw applies trusted
// policies again to the concrete catalog target, where its real mutation semantics are known.

const REPLAY_CLASSIFIED_TOOLS = new Set([
  'automations',
  'browser',
  'canvas',
  'computer',
  'cron',
  'gateway',
  'message',
  'mobile_ui',
  'nodes',
  'portal',
  'process',
  'session_status',
  'sessions',
  'skill_workshop',
  'subagents',
  'transcripts',
]);

const READ_ONLY_SHELL_COMMANDS = new Set([
  'cat',
  'get-childitem',
  'get-content',
  'get-item',
  'grep',
  'head',
  'ls',
  'measure-object',
  'pwd',
  'rg',
  'select-object',
  'select-string',
  'sort-object',
  'stat',
  'tail',
  'wc',
]);
const UNSAFE_RG_FLAGS = new Set(['--hostname-bin', '--pre', '--pre-glob', '--search-zip', '-z']);
const SHELL_EXPANSION_PATTERN = /[;&<>\n\r`$\[\]{}()]/;

const MUTATING_NAME_PATTERN =
  /(?:^|[_.-])(create|delete|deploy|edit|generate|install|move|patch|publish|remove|rename|send|spawn|uninstall|update|write)(?:$|[_.-])/i;

const tokenizeSimpleShellCommand = (command: string): string[] | null => {
  if (SHELL_EXPANSION_PATTERN.test(command)) return null;
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '|') {
      if (current) tokens.push(current);
      tokens.push('|');
      current = '';
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens.length > 0 ? tokens : null;
};

const isReadOnlyShellCommand = (params: unknown): boolean => {
  if (!isRecord(params)) return false;
  const command = typeof params.command === 'string' ? params.command : params.cmd;
  if (typeof command !== 'string' || !command.trim()) return false;
  const tokens = tokenizeSimpleShellCommand(command.trim());
  if (!tokens) return false;
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (token === '|') {
      if (segments.at(-1)?.length === 0) return false;
      segments.push([]);
    } else {
      segments.at(-1)?.push(token);
    }
  }
  if (segments.at(-1)?.length === 0) return false;
  return segments.every(segment => {
    const executable = segment[0]?.toLowerCase();
    if (!executable || !READ_ONLY_SHELL_COMMANDS.has(executable)) return false;
    if (executable !== 'rg') return true;
    return !segment.some(token => {
      const normalized = token.toLowerCase();
      return (
        UNSAFE_RG_FLAGS.has(normalized) ||
        ['--hostname-bin', '--pre', '--pre-glob'].some(flag => normalized.startsWith(`${flag}=`))
      );
    });
  });
};

const isMutatingTool = (event: {
  toolName: string;
  toolKind?: string;
  derivedPaths?: readonly string[];
  params?: unknown;
}): boolean => {
  const normalized = event.toolName.trim().toLowerCase();
  if (normalized === 'task_assistants')
    return Boolean(isRecord(event.params) && event.params.agentId);
  if (normalized === PRESENT_PLAN_TOOL.toLowerCase()) return false;
  if (event.toolKind === 'code_mode_exec') return true;
  if (normalized === 'exec' || normalized === 'bash' || normalized === 'shell') {
    return !isReadOnlyShellCommand(event.params);
  }
  if (REPLAY_CLASSIFIED_TOOLS.has(normalized) || normalized.endsWith('_actions')) {
    return !isReplaySafeToolCall(normalized, event.params);
  }
  return (
    ALWAYS_MUTATING_TOOLS.has(normalized) ||
    MUTATING_NAME_PATTERN.test(normalized) ||
    Boolean(event.derivedPaths?.length)
  );
};

type GatewayEventEmitter = OpenClawPluginGatewayEvents['emit'];

class PlanRequestManager {
  private readonly pending = new Map<string, PendingPlan>();
  private readonly requestIdBySession = new Map<string, string>();
  private emitGatewayEvent: GatewayEventEmitter | null = null;

  constructor(private readonly logger: OpenClawPluginApi['logger']) {}

  setGatewayEventEmitter(emitter: GatewayEventEmitter | null): void {
    this.emitGatewayEvent = emitter;
  }

  list(): PlanRequest[] {
    return [...this.pending.values()].map(entry => entry.request);
  }

  get(requestId: string): PlanRequest | undefined {
    return this.pending.get(requestId)?.request;
  }

  request(
    sessionKey: string,
    plan: string,
    title: string | undefined,
    signal?: AbortSignal,
  ): Promise<PlanResponse> {
    signal?.throwIfAborted();
    if (!this.emitGatewayEvent) throw new Error('Gateway event delivery is unavailable.');
    if (this.requestIdBySession.has(sessionKey)) {
      throw new Error('This session already has a plan awaiting review.');
    }
    const request: PlanRequest = {
      requestId: `plan_${randomUUID()}`,
      sessionKey,
      plan,
      ...(title ? { title } : {}),
    };
    let resolveResponse!: (response: PlanResponse) => void;
    const response = new Promise<PlanResponse>(resolve => {
      resolveResponse = resolve;
    });
    const pending: PendingPlan = { request, resolve: resolveResponse };
    this.pending.set(request.requestId, pending);
    this.requestIdBySession.set(sessionKey, request.requestId);
    if (signal) {
      const handleAbort = () => this.settle(request.requestId, { decision: 'cancel' });
      signal.addEventListener('abort', handleAbort, { once: true });
      pending.removeAbortListener = () => signal.removeEventListener('abort', handleAbort);
    }
    try {
      this.emitGatewayEvent('requested', request, { scope: 'operator.read' });
    } catch (error) {
      this.settle(request.requestId, { decision: 'cancel' }, false);
      throw error;
    }
    return response;
  }

  resolve(requestId: string, decision: PlanDecision, feedback?: string): PlanRequest {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('The plan is no longer waiting for review.');
    this.settle(requestId, { decision, ...(feedback ? { feedback } : {}) });
    return pending.request;
  }

  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, { decision: 'cancel' }, false);
    }
  }

  private settle(requestId: string, response: PlanResponse, publish = true): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    this.requestIdBySession.delete(pending.request.sessionKey);
    pending.removeAbortListener?.();
    pending.resolve(response);
    if (!publish || !this.emitGatewayEvent) return;
    try {
      this.emitGatewayEvent(
        'resolved',
        { requestId, sessionKey: pending.request.sessionKey, decision: response.decision },
        { scope: 'operator.read' },
      );
    } catch (error) {
      this.logger.warn(`[plan-mode] failed to publish resolution: ${String(error)}`);
    }
  }
}

const formatPlanResponse = (response: PlanResponse): string => {
  if (response.decision === 'implement') {
    return 'The user approved this plan. End this planning run now. The application will reset this session context and start implementation.';
  }
  if (response.decision === 'revise') {
    return response.feedback
      ? `The user requested changes to the plan:\n\n${response.feedback}\n\nRevise the plan and present it again.`
      : 'The user requested a revised plan. Reassess the task and present an improved plan.';
  }
  return 'The user cancelled the plan. Stop this task without making changes.';
};

const plugin = {
  id: PLUGIN_ID,
  name: 'Plan Mode',
  description: 'Session-scoped planning workflow for the desktop application.',
  register(api: OpenClawPluginApi) {
    const manager = new PlanRequestManager(api.logger);

    api.session.state.registerSessionExtension({
      namespace: STATE_NAMESPACE,
      description: 'Whether the session is currently in Plan mode.',
      sessionEntrySlotKey: SESSION_SLOT_KEY,
      project: ({ state }) => state,
    });

    api.registerService({
      id: PLUGIN_ID,
      start(ctx) {
        if (!ctx.gatewayEvents) throw new Error('Plan mode requires plugin Gateway events.');
        manager.setGatewayEventEmitter(ctx.gatewayEvents.emit);
      },
      stop() {
        manager.cancelAll();
        manager.setGatewayEventEmitter(null);
      },
    });

    api.on('agent_turn_prepare', (_event, ctx) => {
      if (!readPlanState(ctx.sessionKey)?.enabled) return;
      return { prependContext: PLAN_MODE_INSTRUCTIONS };
    });

    api.registerTrustedToolPolicy({
      id: POLICY_ID,
      description: 'Blocks explicit mutation tools while a session is in Plan mode.',
      evaluate: (event, context) => {
        const state = context.getSessionExtension?.(STATE_NAMESPACE);
        if (!isRecord(state) || state.enabled !== true || !isMutatingTool(event)) return;
        return {
          allow: false,
          reason:
            'This tool can change state and is unavailable while the session is in Plan mode.',
        };
      },
    });

    api.registerGatewayMethod(
      LIST_METHOD,
      ({ respond }) => respond(true, { requests: manager.list() }),
      { scope: 'operator.read' },
    );
    api.registerGatewayMethod(
      RESOLVE_METHOD,
      ({ params, respond }) => {
        try {
          const requestId = readString(params.requestId);
          const decision = params.decision;
          const feedback = readString(params.feedback);
          if (
            !requestId ||
            (decision !== 'implement' && decision !== 'revise' && decision !== 'cancel')
          ) {
            throw new Error('Invalid plan review response.');
          }
          if (decision === 'revise' && feedback.length > 4_000) {
            throw new Error('Plan revision feedback is too long.');
          }
          const pending = manager.get(requestId);
          if (!pending) throw new Error('The plan is no longer waiting for review.');
          const request = manager.resolve(requestId, decision, feedback || undefined);
          respond(true, { requestId, sessionKey: request.sessionKey, decision });
        } catch (error) {
          respond(false, undefined, {
            code: 'invalid_request',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: 'operator.write' },
    );

    api.registerTool(
      ctx => {
        const sessionKey = ctx.sessionKey?.trim();
        if (!isJustDoSession(sessionKey) || !readPlanState(sessionKey)?.enabled) return null;
        return {
          name: PRESENT_PLAN_TOOL,
          label: 'Present Plan',
          catalogMode: 'direct-only',
          description:
            'Present the complete implementation plan to the user for review. Call this only when the plan is decision-complete. The call waits for the user to approve, request changes, or cancel.',
          parameters: Type.Object(
            {
              plan: Type.String({
                minLength: 1,
                maxLength: MAX_PLAN_LENGTH,
                description: 'The complete implementation plan in Markdown.',
              }),
              title: Type.Optional(
                Type.String({ minLength: 1, maxLength: 120, description: 'Short plan title.' }),
              ),
            },
            { additionalProperties: false },
          ),
          async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
            if (!readPlanState(sessionKey)?.enabled) {
              return {
                content: [{ type: 'text', text: 'Plan mode is no longer enabled.' }],
                isError: true,
              };
            }
            const input = isRecord(params) ? params : {};
            const plan = readString(input.plan);
            const title = readString(input.title);
            if (!plan || plan.length > MAX_PLAN_LENGTH) {
              return {
                content: [{ type: 'text', text: 'The plan is empty or exceeds the size limit.' }],
                isError: true,
              };
            }
            try {
              const response = await manager.request(sessionKey, plan, title || undefined, signal);
              return { content: [{ type: 'text', text: formatPlanResponse(response) }] };
            } catch (error) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `PresentPlan failed: ${error instanceof Error ? error.message : String(error)}`,
                  },
                ],
                isError: true,
              };
            }
          },
        };
      },
      { name: PRESENT_PLAN_TOOL },
    );

    api.logger.info('[plan-mode] planning workflow enabled.');
  },
};

export default plugin;
