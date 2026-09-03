import { randomUUID } from 'node:crypto';

import type { OpenClawPluginApi, OpenClawPluginGatewayEvents } from 'openclaw/plugin-sdk';
import { Type } from 'typebox';

export const ASK_USER_TIMEOUT_MINUTES = 10;
export const MAX_ASK_USER_TIMEOUT_MINUTES = 24 * 60;
export const MAX_ASK_USER_QUESTIONS = 8;
export const MAX_ASK_USER_HEADER_LENGTH = 12;
export const ASK_USER_ID_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
export const ASK_USER_LIST_METHOD = 'askUserQuestion.list';
export const ASK_USER_RESOLVE_METHOD = 'askUserQuestion.resolve';

type QuestionOption = {
  id: string;
  label: string;
  description?: string;
  input?: {
    label: string;
    placeholder?: string;
  };
};

export type Question = {
  id: string;
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
  defaultOptionIds?: string[];
};

type AskUserAnswers = Record<
  string,
  {
    selected: string[];
    optionInputs?: Record<string, string>;
    other?: string;
    skipped?: true;
  }
>;

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
};

export type AskUserResponse =
  | { status: 'answered'; answers: AskUserAnswers; timedOut?: boolean }
  | { status: 'cancelled' }
  | { status: 'timeout' };

type PendingRequest = {
  request: AskUserRequest;
  resolve: (response: AskUserResponse) => void;
  timeout?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
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

const askUserIdRegex = new RegExp(ASK_USER_ID_PATTERN);
const isSafeId = (value: string): boolean =>
  askUserIdRegex.test(value) && !(value in Object.prototype);

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

export const parseQuestions = (value: unknown): Question[] | null => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ASK_USER_QUESTIONS) {
    return null;
  }

  const questionIds = new Set<string>();
  const questions: Question[] = [];
  for (const rawQuestion of value) {
    if (!isRecord(rawQuestion)) return null;
    const id = readRequiredString(rawQuestion.id);
    const question = readRequiredString(rawQuestion.question);
    if (!id || !isSafeId(id) || !question || questionIds.has(id)) return null;
    if (
      (rawQuestion.header !== undefined && typeof rawQuestion.header !== 'string') ||
      (rawQuestion.multiSelect !== undefined && typeof rawQuestion.multiSelect !== 'boolean') ||
      (rawQuestion.allowOther !== undefined && typeof rawQuestion.allowOther !== 'boolean')
    ) {
      return null;
    }
    if (
      typeof rawQuestion.header === 'string' &&
      rawQuestion.header.trim().length > MAX_ASK_USER_HEADER_LENGTH
    ) {
      return null;
    }
    if (
      !Array.isArray(rawQuestion.options) ||
      rawQuestion.options.length < 2 ||
      rawQuestion.options.length > 4
    ) {
      return null;
    }

    const optionIds = new Set<string>();
    const options: QuestionOption[] = [];
    for (const rawOption of rawQuestion.options) {
      if (!isRecord(rawOption)) return null;
      const optionId = readRequiredString(rawOption.id);
      const label = readRequiredString(rawOption.label);
      if (!optionId || !isSafeId(optionId) || !label || optionIds.has(optionId)) return null;
      if (rawOption.description !== undefined && typeof rawOption.description !== 'string') {
        return null;
      }

      let input: QuestionOption['input'];
      if (rawOption.input !== undefined) {
        if (!isRecord(rawOption.input)) return null;
        const inputLabel = readRequiredString(rawOption.input.label);
        if (!inputLabel) return null;
        if (
          rawOption.input.placeholder !== undefined &&
          typeof rawOption.input.placeholder !== 'string'
        ) {
          return null;
        }
        input = {
          label: inputLabel,
          ...(typeof rawOption.input.placeholder === 'string'
            ? { placeholder: rawOption.input.placeholder.trim() }
            : {}),
        };
      }

      optionIds.add(optionId);
      options.push({
        id: optionId,
        label,
        ...(typeof rawOption.description === 'string'
          ? { description: rawOption.description.trim() }
          : {}),
        ...(input ? { input } : {}),
      });
    }

    let defaultOptionIds: string[] | undefined;
    if (rawQuestion.defaultOptionIds !== undefined) {
      if (!Array.isArray(rawQuestion.defaultOptionIds)) return null;
      const parsedDefaults = rawQuestion.defaultOptionIds.map(readRequiredString);
      if (parsedDefaults.some(id => !id)) return null;
      defaultOptionIds = parsedDefaults as string[];
      const uniqueDefaults = new Set(defaultOptionIds);
      const optionsById = new Map(options.map(option => [option.id, option]));
      if (
        defaultOptionIds.length < 1 ||
        defaultOptionIds.length > options.length ||
        uniqueDefaults.size !== defaultOptionIds.length ||
        (!rawQuestion.multiSelect && defaultOptionIds.length !== 1) ||
        defaultOptionIds.some(optionId => {
          const option = optionsById.get(optionId);
          return !option || Boolean(option.input);
        })
      ) {
        return null;
      }
    }

    questionIds.add(id);
    questions.push({
      id,
      question,
      options,
      ...(typeof rawQuestion.header === 'string' ? { header: rawQuestion.header.trim() } : {}),
      ...(rawQuestion.multiSelect === true ? { multiSelect: true } : {}),
      allowOther: rawQuestion.allowOther !== false,
      ...(defaultOptionIds ? { defaultOptionIds } : {}),
    });
  }
  return questions;
};

export const buildWaitPolicy = (
  timeoutEnabled: unknown,
  questions: Question[],
  timeoutMinutes = ASK_USER_TIMEOUT_MINUTES,
): WaitPolicy | null => {
  if (timeoutEnabled === undefined || timeoutEnabled === false) return { mode: 'required' };
  if (timeoutEnabled !== true) return null;
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

export const parseAnswers = (value: unknown, questions: Question[]): AskUserAnswers | null => {
  if (!isRecord(value) || Object.keys(value).length !== questions.length) return null;
  const answers: AskUserAnswers = {};
  for (const question of questions) {
    if (!Object.prototype.hasOwnProperty.call(value, question.id)) return null;
    const rawAnswer = value[question.id];
    if (!isRecord(rawAnswer) || !Array.isArray(rawAnswer.selected)) return null;
    const selected = rawAnswer.selected.map(readRequiredString);
    if (selected.some(id => !id)) return null;
    const selectedIds = selected as string[];
    if (new Set(selectedIds).size !== selectedIds.length) return null;
    if (!question.multiSelect && selectedIds.length > 1) return null;

    const skipped = rawAnswer.skipped === true;
    if (rawAnswer.skipped !== undefined && !skipped) return null;
    if (skipped) {
      if (
        selectedIds.length > 0 ||
        rawAnswer.optionInputs !== undefined ||
        rawAnswer.other !== undefined
      ) {
        return null;
      }
      answers[question.id] = { selected: [], skipped: true };
      continue;
    }

    const optionsById = new Map(question.options.map(option => [option.id, option]));
    if (selectedIds.some(id => !optionsById.has(id))) return null;
    const other = rawAnswer.other === undefined ? undefined : readRequiredString(rawAnswer.other);
    if (rawAnswer.other !== undefined && !other) return null;
    if (other && question.allowOther === false) return null;
    if (!question.multiSelect && selectedIds.length > 0 && other) return null;
    if (selectedIds.length === 0 && !other) return null;

    let optionInputs: Record<string, string> | undefined;
    if (rawAnswer.optionInputs !== undefined) {
      if (!isRecord(rawAnswer.optionInputs)) return null;
      optionInputs = {};
      for (const [optionId, rawInput] of Object.entries(rawAnswer.optionInputs)) {
        const input = readRequiredString(rawInput);
        if (!input || !selectedIds.includes(optionId) || !optionsById.get(optionId)?.input) {
          return null;
        }
        optionInputs[optionId] = input;
      }
    }
    if (selectedIds.some(id => optionsById.get(id)?.input && !optionInputs?.[id])) return null;

    answers[question.id] = {
      selected: selectedIds,
      ...(optionInputs && Object.keys(optionInputs).length > 0 ? { optionInputs } : {}),
      ...(other ? { other } : {}),
    };
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
  private readonly requestIdBySession = new Map<string, string>();
  private emitGatewayEvent: GatewayEventEmitter | null = null;

  constructor(private readonly logger: OpenClawPluginApi['logger']) {}

  setGatewayEventEmitter(emitter: GatewayEventEmitter | null): void {
    this.emitGatewayEvent = emitter;
  }

  list(): AskUserRequest[] {
    return [...this.pending.values()].map(entry => entry.request);
  }

  request(
    questions: Question[],
    waitPolicy: WaitPolicy,
    sessionKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<AskUserResponse> {
    signal?.throwIfAborted();
    if (!this.emitGatewayEvent) {
      throw new Error('Gateway event delivery is unavailable.');
    }
    if (sessionKey && this.requestIdBySession.has(sessionKey)) {
      throw new Error('This session already has a pending AskUserQuestion request.');
    }

    const requestId = `ask_${randomUUID()}`;
    const expiresAt =
      waitPolicy.mode === 'timeout' ? Date.now() + waitPolicy.timeoutMinutes * 60_000 : undefined;
    const request: AskUserRequest = {
      requestId,
      ...(sessionKey ? { sessionKey } : {}),
      questions,
      waitPolicy,
      ...(expiresAt ? { expiresAt } : {}),
    };

    let resolveResponse!: (response: AskUserResponse) => void;
    const response = new Promise<AskUserResponse>(resolve => {
      resolveResponse = resolve;
    });
    const pending: PendingRequest = { request, resolve: resolveResponse };
    if (signal) {
      const onAbort = () => this.settle(requestId, { status: 'cancelled' });
      signal.addEventListener('abort', onAbort, { once: true });
      pending.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }
    if (waitPolicy.mode === 'timeout') {
      pending.timeout = setTimeout(() => {
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
    if (sessionKey) this.requestIdBySession.set(sessionKey, requestId);

    try {
      this.emitGatewayEvent('requested', request, { scope: 'operator.read' });
    } catch (error) {
      this.settle(requestId, { status: 'cancelled' }, false);
      throw error;
    }
    return response;
  }

  resolve(requestId: string, behavior: 'submit' | 'cancel', value?: unknown): AskUserRequest {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('The question is no longer waiting for an answer.');
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
    if (pending.request.sessionKey) this.requestIdBySession.delete(pending.request.sessionKey);
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
  id: Type.String({ minLength: 1, maxLength: 64, pattern: ASK_USER_ID_PATTERN }),
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
  id: Type.String({ minLength: 1, maxLength: 64, pattern: ASK_USER_ID_PATTERN }),
  question: Type.String({ description: 'One clear question shown to the user.' }),
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
    Type.Array(Type.String({ minLength: 1, maxLength: 64, pattern: ASK_USER_ID_PATTERN }), {
      minItems: 1,
      maxItems: 4,
      description: 'Defaults used only after an enabled timeout.',
    }),
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
        description:
          'Enable the configured timeout only when the model can safely decide after no answer. Defaults are applied only when every question defines defaultOptionIds.',
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
  'Omit timeoutEnabled when an explicit user answer is essential. Enable it only when no answer can safely fall back to defaults or your best judgment.',
].join(' ');

const plugin = {
  id: 'ask-user-question',
  name: 'AskUserQuestion',
  description: 'Rich structured questions for the JustDo desktop application.',
  configSchema: {
    parse(value: unknown): PluginConfig {
      return parsePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    const manager = new AskUserQuestionManager(api.logger);

    api.registerService({
      id: 'ask-user-question',
      start(ctx) {
        if (!ctx.gatewayEvents) {
          throw new Error('AskUserQuestion requires plugin Gateway events.');
        }
        manager.setGatewayEventEmitter(ctx.gatewayEvents.emit);
      },
      stop() {
        manager.cancelAll();
        manager.setGatewayEventEmitter(null);
      },
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
          if (!requestId || (behavior !== 'submit' && behavior !== 'cancel')) {
            throw new Error('Invalid AskUserQuestion resolution request.');
          }
          const request = manager.resolve(requestId, behavior, params.answers);
          respond(true, {
            requestId,
            status: behavior === 'submit' ? 'answered' : 'cancelled',
            ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
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
      ctx => {
        const sessionKey = ctx.sessionKey?.trim() ?? '';
        if (!sessionKey.startsWith('justdo:') && !/^agent:[^:]+:justdo:/.test(sessionKey)) {
          return null;
        }
        return {
          name: 'AskUserQuestion',
          label: 'Ask User Question',
          description: ASK_USER_QUESTION_DESCRIPTION,
          parameters: AskUserQuestionSchema,
          async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
            const input = isRecord(params) ? params : {};
            const questions = parseQuestions(input.questions);
            const waitPolicy = questions
              ? buildWaitPolicy(input.timeoutEnabled, questions, config.timeoutMinutes)
              : null;
            if (!questions || !waitPolicy) {
              return {
                content: [{ type: 'text', text: 'Invalid questions or timeoutEnabled flag.' }],
                isError: true,
              };
            }
            try {
              const response = await manager.request(questions, waitPolicy, sessionKey, signal);
              return { content: [{ type: 'text', text: formatResponse(response, questions) }] };
            } catch (error) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `AskUserQuestion failed: ${error instanceof Error ? error.message : String(error)}`,
                  },
                ],
                isError: true,
              };
            }
          },
        };
      },
      { name: 'AskUserQuestion' },
    );
  },
};

export default plugin;
