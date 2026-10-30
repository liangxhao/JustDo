import { randomUUID } from 'node:crypto';

import type { OpenClawPluginApi, OpenClawPluginGatewayEvents } from 'openclaw/plugin-sdk/core';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { Type } from 'typebox';

import {
  ASK_USER_ID_PATTERN,
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserAnswers,
  type AskUserResponse,
  MAX_ASK_USER_HEADER_LENGTH,
  MAX_ASK_USER_QUESTIONS,
  parseAnswers,
  parseAskUserSource,
  sameAskUserSource,
  type AskUserSource,
  parseQuestions,
  type Question,
  QUESTION_RESULT_VERSION,
} from './contracts/result';
import { AskUserInvocationScopes } from './invocation';

export {
  ASK_USER_ID_PATTERN,
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserResponse,
  MAX_ASK_USER_HEADER_LENGTH,
  MAX_ASK_USER_QUESTIONS,
  parseAnswers,
  parseQuestions,
  type Question,
} from './contracts/result';

export const ASK_USER_TIMEOUT_MINUTES = 10;
export const MAX_ASK_USER_TIMEOUT_MINUTES = 24 * 60;
export const ASK_USER_LIST_METHOD = 'askUserQuestion.list';
export const ASK_USER_RESOLVE_METHOD = 'askUserQuestion.resolve';
export type WaitPolicy =
  | { mode: 'required' }
  | {
      mode: 'timeout';
      timeoutMinutes: number;
      onTimeout: 'use-defaults' | 'model-decides';
    };

export type AskUserRequest = {
  requestId: string;
  sessionKey?: string;
  questions: Question[];
  waitPolicy: WaitPolicy;
  expiresAt?: number;
  source: AskUserSource;
  createdAt: number;
};
export interface AskUserInvocation {
  source: AskUserSource;
  assertCurrent(): void;
}

type PendingRequest = {
  request: AskUserRequest;
  resolve: (response: AskUserResponse) => void;
  timeout?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
  invocation: AskUserInvocation;
};

type PluginConfig = {
  timeoutMinutes: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readRequiredString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const parsePluginConfig = (value: unknown): PluginConfig => {
  const timeoutMinutes = isRecord(value) ? value.timeoutMinutes : undefined;
  return {
    timeoutMinutes:
      typeof timeoutMinutes === 'number' &&
      Number.isInteger(timeoutMinutes) &&
      timeoutMinutes >= 1 &&
      timeoutMinutes <= MAX_ASK_USER_TIMEOUT_MINUTES
        ? timeoutMinutes
        : ASK_USER_TIMEOUT_MINUTES,
  };
};

export const buildWaitPolicy = (
  timeoutEnabled: unknown,
  questions: Question[],
  timeoutMinutes = ASK_USER_TIMEOUT_MINUTES,
): WaitPolicy | null => {
  if (timeoutEnabled === false) return { mode: 'required' };
  if (timeoutEnabled !== undefined && timeoutEnabled !== true) return null;
  return {
    mode: 'timeout',
    timeoutMinutes,
    onTimeout: questions.every(question => question.defaultOptionIds?.length)
      ? 'use-defaults'
      : 'model-decides',
  };
};

const buildDefaultAnswers = (questions: Question[]): AskUserAnswers | null => {
  const answers: AskUserAnswers = {};
  for (const question of questions) {
    if (!question.defaultOptionIds?.length) return null;
    answers[question.id] = { selected: [...question.defaultOptionIds] };
  }
  return answers;
};

const formatResponse = (response: AskUserResponse, questions: Question[]): string => {
  if (response.status === 'cancelled') {
    return 'The question was cancelled; proceed with best judgment.';
  }
  if (response.status === 'timeout') {
    return 'No answer arrived before the timeout; proceed with best judgment.';
  }

  const lines = questions.map(question => {
    const answer = response.answers[question.id];
    if (answer?.skipped) return `${question.question}\nUser skipped this question.`;
    const optionsById = new Map(question.options.map(option => [option.id, option]));
    const selected = answer?.selected.map(id => optionsById.get(id)?.label ?? id) ?? [];
    const details = [question.question, `User selected: ${selected.join(', ') || 'none'}`];
    if (answer?.optionInputs) {
      details.push(
        'Additional information:',
        ...Object.entries(answer.optionInputs).map(
          ([optionId, input]) => `- ${optionsById.get(optionId)?.label ?? optionId}: ${input}`,
        ),
      );
    }
    if (answer?.other) details.push(`Other: ${answer.other}`);
    return details.join('\n');
  });
  const prefix = response.timedOut
    ? 'The user did not respond before the timeout. The configured defaults were selected automatically.\n\n'
    : '';
  return `${prefix}${lines.join('\n\n')}`;
};

type GatewayEventEmitter = OpenClawPluginGatewayEvents['emit'];

export class AskUserQuestionManager {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestIdByInvocation = new Map<string, string>();
  private emitGatewayEvent: GatewayEventEmitter | null = null;

  constructor(private readonly logger: OpenClawPluginApi['logger']) {}

  setGatewayEventEmitter(emitter: GatewayEventEmitter | null): void {
    this.emitGatewayEvent = emitter;
  }

  list(): AskUserRequest[] {
    for (const [id, pending] of this.pending) {
      try {
        pending.invocation.assertCurrent();
      } catch {
        this.settle(id, { status: 'cancelled' });
      }
    }
    return [...this.pending.values()].map(entry => entry.request);
  }

  request(
    questions: Question[],
    waitPolicy: WaitPolicy,
    invocation: AskUserInvocation,
    signal?: AbortSignal,
  ): Promise<AskUserResponse> {
    signal?.throwIfAborted();
    invocation.assertCurrent();
    const source = parseAskUserSource(invocation.source);
    if (!source) throw new Error('Native question identity is unavailable.');
    if (!this.emitGatewayEvent) {
      throw new Error('Gateway event delivery is unavailable.');
    }
    const identity = JSON.stringify(source);
    if (this.requestIdByInvocation.has(identity)) {
      throw new Error('This native tool invocation already has a pending question.');
    }

    const requestId = `ask_${randomUUID()}`;
    const expiresAt =
      waitPolicy.mode === 'timeout' ? Date.now() + waitPolicy.timeoutMinutes * 60_000 : undefined;
    const request: AskUserRequest = {
      requestId,
      sessionKey: source.sessionKey,
      source,
      createdAt: Date.now(),
      questions,
      waitPolicy,
      ...(expiresAt ? { expiresAt } : {}),
    };

    let resolveResponse!: (response: AskUserResponse) => void;
    const response = new Promise<AskUserResponse>(resolve => {
      resolveResponse = resolve;
    });
    const pending: PendingRequest = {
      request,
      resolve: resolveResponse,
      invocation,
    };
    if (signal) {
      const onAbort = () => this.settle(requestId, { status: 'cancelled' });
      signal.addEventListener('abort', onAbort, { once: true });
      pending.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }
    if (waitPolicy.mode === 'timeout') {
      pending.timeout = setTimeout(() => {
        try {
          invocation.assertCurrent();
        } catch {
          this.settle(requestId, { status: 'cancelled' });
          return;
        }
        const answers =
          waitPolicy.onTimeout === 'use-defaults' ? buildDefaultAnswers(questions) : null;
        this.settle(
          requestId,
          answers ? { status: 'answered', answers, timedOut: true } : { status: 'timeout' },
        );
      }, waitPolicy.timeoutMinutes * 60_000);
      pending.timeout.unref?.();
    }
    this.pending.set(requestId, pending);
    this.requestIdByInvocation.set(identity, requestId);

    try {
      this.emitGatewayEvent('requested', request, { scope: 'operator.read' });
    } catch (error) {
      this.settle(requestId, { status: 'cancelled' }, false);
      throw error;
    }
    return response;
  }

  resolve(
    requestId: string,
    behavior: 'submit' | 'cancel',
    value: unknown,
    source: AskUserSource,
  ): AskUserRequest {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('The question is no longer waiting for an answer.');
    if (!sameAskUserSource(source, pending.request.source))
      throw new Error('The question source changed.');
    try {
      pending.invocation.assertCurrent();
    } catch (error) {
      this.settle(requestId, { status: 'cancelled' });
      throw error;
    }
    if (behavior === 'cancel') {
      this.settle(requestId, { status: 'cancelled' });
      return pending.request;
    }
    const answers = parseAnswers(value, pending.request.questions);
    if (!answers) throw new Error('The submitted answers do not match the pending question.');
    this.settle(requestId, { status: 'answered', answers });
    return pending.request;
  }

  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, { status: 'cancelled' });
    }
  }

  private settle(requestId: string, response: AskUserResponse, publish = true): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    this.requestIdByInvocation.delete(JSON.stringify(pending.request.source));
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.removeAbortListener?.();
    pending.resolve(response);
    if (publish && this.emitGatewayEvent) {
      try {
        this.emitGatewayEvent(
          'resolved',
          { requestId, status: response.status },
          { scope: 'operator.read' },
        );
      } catch (error) {
        this.logger.warn(`[ask-user-question] failed to publish resolution: ${String(error)}`);
      }
    }
    return true;
  }
}

const QuestionOptionSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: ASK_USER_ID_PATTERN,
  }),
  label: Type.String({ description: 'Option label (1-5 words).' }),
  description: Type.Optional(Type.String({ description: 'Short explanation or tradeoff.' })),
  input: Type.Optional(
    Type.Object({
      label: Type.String({ description: 'Label for required follow-up text.' }),
      placeholder: Type.Optional(Type.String({ description: 'Example or input hint.' })),
    }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: ASK_USER_ID_PATTERN,
  }),
  question: Type.String({
    description: 'One clear question shown to the user.',
  }),
  header: Type.Optional(
    Type.String({
      maxLength: MAX_ASK_USER_HEADER_LENGTH,
      description: `Short tag (max ${MAX_ASK_USER_HEADER_LENGTH} characters).`,
    }),
  ),
  options: Type.Array(QuestionOptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: 'Every selectable choice (2-4 options).',
  }),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Allow several choices.' })),
  allowOther: Type.Optional(
    Type.Boolean({
      default: true,
      description: 'Allow a free-text Other answer. Defaults to true.',
    }),
  ),
  defaultOptionIds: Type.Optional(
    Type.Array(
      Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: ASK_USER_ID_PATTERN,
      }),
      {
        minItems: 1,
        maxItems: 4,
        description: 'Defaults used only after an enabled timeout.',
      },
    ),
  ),
});

export const AskUserQuestionSchema = Type.Object(
  {
    questions: Type.Array(QuestionSchema, {
      minItems: 1,
      maxItems: MAX_ASK_USER_QUESTIONS,
      description: `Questions to show (1-${MAX_ASK_USER_QUESTIONS}). Prefer exactly one unless answers must be submitted together.`,
    }),
    timeoutEnabled: Type.Optional(
      Type.Boolean({
        default: true,
        description:
          'Defaults to true: wait for the configured timeout (10 minutes by default), then continue with defaults or best judgment. Set false only when an explicit user answer is essential and the task cannot safely proceed without it. Defaults are applied only when every question defines defaultOptionIds.',
      }),
    ),
  },
  { additionalProperties: false },
);

export const ASK_USER_QUESTION_DESCRIPTION = [
  'Ask the human user structured questions and wait for their answer.',
  'Use only when blocked on a decision that genuinely belongs to the user and cannot be resolved from the request, code, context, or a sensible default; never ask whether to proceed, whether to continue, or to confirm your own plan.',
  'Ask exactly one question per call unless several answers must be submitted together.',
  'Put every selectable choice in options, never only in question prose. Put the recommended option first and suffix its label with (Recommended).',
  'Use multiSelect only when several choices may be selected.',
  'When a selected option requires details, define its input instead of asking in a later message. Free-text Other is enabled by default.',
  'The configured timeout is enabled by default (10 minutes unless configured otherwise). Set timeoutEnabled to false only when an explicit user answer is essential and you cannot safely proceed without it.',
  'After a timeout, continue with configured defaults or your best judgment; do not keep waiting for the expired question. A question timeout alone is not a reason to pause or block an active goal.',
].join(' ');

const plugin = {
  id: 'ask-user-question',
  name: 'Ask User Question',
  description: 'Rich structured questions for the desktop application.',
  configSchema: {
    parse(value: unknown): PluginConfig {
      return parsePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    const manager = new AskUserQuestionManager(api.logger);
    const scopes = new AskUserInvocationScopes(sessionKey =>
      getSessionEntry({ sessionKey, readConsistency: 'latest' }),
    );

    api.registerService({
      id: 'ask-user-question',
      start(ctx) {
        if (!ctx.gatewayEvents) {
          throw new Error('ask_user_question requires plugin Gateway events.');
        }
        manager.setGatewayEventEmitter(ctx.gatewayEvents.emit);
        scopes.activate();
      },
      stop() {
        scopes.clear();
        manager.cancelAll();
        manager.setGatewayEventEmitter(null);
      },
    });

    api.on(
      'before_tool_call',
      (event, context) => {
        try {
          if (
            event.toolName !== ASK_USER_QUESTION_TOOL_NAME ||
            (event.runId !== undefined && event.runId !== context.runId) ||
            (event.toolCallId !== undefined && event.toolCallId !== context.toolCallId)
          ) {
            throw new Error('The question tool identity changed.');
          }
          scopes.prepare(context);
        } catch (error) {
          return {
            block: true,
            blockReason: error instanceof Error ? error.message : 'Question unavailable.',
          };
        }
      },
      { matcher: [ASK_USER_QUESTION_TOOL_NAME] },
    );
    api.on('after_tool_call', (_event, context) => scopes.finish(context), {
      matcher: [ASK_USER_QUESTION_TOOL_NAME],
    });

    api.registerGatewayMethod(
      ASK_USER_LIST_METHOD,
      ({ respond }) => respond(true, { requests: manager.list() }),
      { scope: 'operator.read' },
    );
    api.registerGatewayMethod(
      ASK_USER_RESOLVE_METHOD,
      ({ params, respond }) => {
        try {
          const requestId = readRequiredString(params.requestId);
          const behavior = params.behavior;
          const source = parseAskUserSource(params.source);
          if (!requestId || !source || (behavior !== 'submit' && behavior !== 'cancel')) {
            throw new Error('Invalid ask_user_question resolution request.');
          }
          const request = manager.resolve(requestId, behavior, params.answers, source);
          respond(true, {
            requestId,
            status: behavior === 'submit' ? 'answered' : 'cancelled',
            ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
            source: request.source,
          });
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
      {
        contextVersion: 2,
        create: ctx => {
          const sessionKey = ctx.sessionKey?.trim() ?? '';
          if (
            !sessionKey ||
            !ctx.sessionId?.trim() ||
            typeof ctx.assertInvocationCurrent !== 'function'
          ) {
            return null;
          }
          ctx.assertInvocationCurrent();
          return {
            name: ASK_USER_QUESTION_TOOL_NAME,
            label: 'Ask User Question',
            description: ASK_USER_QUESTION_DESCRIPTION,
            parameters: AskUserQuestionSchema,
            async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
              const input = isRecord(params) ? params : {};
              const questions = parseQuestions(input.questions);
              const waitPolicy = questions
                ? buildWaitPolicy(input.timeoutEnabled, questions, config.timeoutMinutes)
                : null;
              if (!questions || !waitPolicy) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: 'Invalid questions or timeoutEnabled flag.',
                    },
                  ],
                  isError: true,
                };
              }
              try {
                const invocation = scopes.claim(
                  { ...ctx, sessionKey, sessionId: ctx.sessionId! },
                  toolCallId,
                );
                const signals = [signal, invocation.signal].filter((value): value is AbortSignal =>
                  Boolean(value),
                );
                const response = await manager.request(
                  questions,
                  waitPolicy,
                  invocation,
                  signals.length ? AbortSignal.any(signals) : undefined,
                );
                const questionResult = {
                  version: QUESTION_RESULT_VERSION,
                  questions,
                  response,
                };
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        askUserQuestion: questionResult,
                        summary: formatResponse(response, questions),
                      }),
                    },
                  ],
                  details: { askUserQuestion: questionResult },
                };
              } catch (error) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: `ask_user_question failed: ${error instanceof Error ? error.message : String(error)}`,
                    },
                  ],
                  isError: true,
                };
              }
            },
          };
        },
      },
      { name: ASK_USER_QUESTION_TOOL_NAME },
    );
  },
};

export default plugin;
