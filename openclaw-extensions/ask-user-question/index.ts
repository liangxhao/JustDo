import http from 'node:http';
import https from 'node:https';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from 'typebox';

/**
 * AskUserQuestion plugin for OpenClaw.
 *
 * Registers a structured tool that lets the model ask the user a question
 * with predefined options (single/multi select). The tool pauses execution
 * and waits for the user's response via an HTTP callback to JustDo.
 *
 * This enables structured choice prompts and confirmation modals on
 * the JustDo desktop app without relying on OpenClaw's exec.approval
 * mechanism.
 */

type PluginConfig = {
  callbackUrl: string;
  secret: string;
};

type QuestionOption = {
  id: string;
  label: string;
  description?: string;
  input?: {
    label: string;
    placeholder?: string;
  };
};

type Question = {
  id: string;
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  defaultOptionIds?: string[];
};

type WaitPolicy =
  | { mode: 'required' }
  | {
      mode: 'timeout';
      timeoutMinutes: number;
      onTimeout: 'use-defaults' | 'model-decides';
    };

type AskUserToolInput = {
  questions: Question[];
  timeoutEnabled?: boolean;
};

type AskUserCallbackInput = {
  questions: Question[];
  sessionKey?: string;
  waitPolicy: WaitPolicy;
};

type AskUserResponse = {
  behavior: 'allow' | 'deny' | 'timeout';
  answers?: Record<
    string,
    {
      selected: string[];
      optionInputs?: Record<string, string>;
      other?: string;
    }
  >;
  timedOut?: boolean;
};

const LOOPBACK_CALLBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ASK_USER_ID_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
export const MAX_ASK_USER_QUESTIONS = 8;
export const ASK_USER_TIMEOUT_MINUTES = 10;
const askUserIdRegex = new RegExp(ASK_USER_ID_PATTERN);

type HttpCallbackResult = {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
};

type CallbackResponse = Response | HttpCallbackResult;

const isLoopbackCallbackUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_CALLBACK_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
};

const postLoopbackJson = (
  callbackUrl: string,
  input: AskUserCallbackInput,
  secret: string,
  signal?: AbortSignal,
): Promise<HttpCallbackResult> => {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch (error) {
      reject(error);
      return;
    }

    const body = JSON.stringify(input);
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-ask-user-secret': secret,
        },
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: response.statusMessage ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    const abort = () => {
      request.destroy(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
    };
    request.on('error', error => {
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    request.on('close', () => signal?.removeEventListener('abort', abort));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    request.end(body);
  });
};

const readCallbackBody = async (response: CallbackResponse): Promise<string> => {
  const body = (response as HttpCallbackResult).body;
  if (typeof body === 'string') {
    return body;
  }
  return response.text();
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const parsePluginConfig = (value: unknown): PluginConfig => {
  const raw = isRecord(value) ? value : {};
  return {
    callbackUrl: typeof raw.callbackUrl === 'string' ? raw.callbackUrl.trim() : '',
    secret: typeof raw.secret === 'string' ? raw.secret.trim() : '',
  };
};

const readRequiredString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const isSafeAskUserId = (value: string): boolean =>
  askUserIdRegex.test(value) && !(value in Object.prototype);

export const parseQuestions = (value: unknown): Question[] | null => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ASK_USER_QUESTIONS)
    return null;
  const questionIds = new Set<string>();
  const questions: Question[] = [];
  for (const rawQuestion of value) {
    if (!isRecord(rawQuestion)) return null;
    const id = readRequiredString(rawQuestion.id);
    const question = readRequiredString(rawQuestion.question);
    if (
      !id ||
      !isSafeAskUserId(id) ||
      !question ||
      questionIds.has(id) ||
      (rawQuestion.header !== undefined && typeof rawQuestion.header !== 'string') ||
      (rawQuestion.multiSelect !== undefined && typeof rawQuestion.multiSelect !== 'boolean') ||
      !Array.isArray(rawQuestion.options) ||
      rawQuestion.options.length < 2 ||
      rawQuestion.options.length > 4
    )
      return null;
    const optionIds = new Set<string>();
    const options: QuestionOption[] = [];
    for (const rawOption of rawQuestion.options) {
      if (!isRecord(rawOption)) return null;
      const optionId = readRequiredString(rawOption.id);
      const label = readRequiredString(rawOption.label);
      if (!optionId || !isSafeAskUserId(optionId) || !label || optionIds.has(optionId)) {
        return null;
      }
      if (rawOption.description !== undefined && typeof rawOption.description !== 'string') {
        return null;
      }
      optionIds.add(optionId);
      let input: QuestionOption['input'];
      if (rawOption.input !== undefined) {
        if (!isRecord(rawOption.input)) return null;
        const inputLabel = readRequiredString(rawOption.input.label);
        if (!inputLabel) return null;
        if (
          rawOption.input.placeholder !== undefined &&
          typeof rawOption.input.placeholder !== 'string'
        )
          return null;
        input = {
          label: inputLabel,
          ...(typeof rawOption.input.placeholder === 'string'
            ? { placeholder: rawOption.input.placeholder.trim() }
            : {}),
        };
      }
      options.push({
        id: optionId,
        label,
        ...(typeof rawOption.description === 'string'
          ? { description: rawOption.description.trim() }
          : {}),
        ...(input ? { input } : {}),
      });
    }
    questionIds.add(id);
    let defaultOptionIds: string[] | undefined;
    if (rawQuestion.defaultOptionIds !== undefined) {
      if (!Array.isArray(rawQuestion.defaultOptionIds)) return null;
      const rawDefaultIds = rawQuestion.defaultOptionIds.map(readRequiredString);
      if (rawDefaultIds.some(defaultId => !defaultId)) return null;
      defaultOptionIds = rawDefaultIds as string[];
      const defaultIdSet = new Set(defaultOptionIds);
      const optionsById = new Map(options.map(option => [option.id, option]));
      if (
        defaultOptionIds.length < 1 ||
        defaultOptionIds.length > options.length ||
        defaultIdSet.size !== defaultOptionIds.length ||
        (!rawQuestion.multiSelect && defaultOptionIds.length !== 1) ||
        defaultOptionIds.some(defaultId => {
          const option = optionsById.get(defaultId);
          return !option || Boolean(option.input);
        })
      )
        return null;
    }
    questions.push({
      id,
      question,
      options,
      ...(typeof rawQuestion.header === 'string' ? { header: rawQuestion.header.trim() } : {}),
      ...(rawQuestion.multiSelect === true ? { multiSelect: true } : {}),
      ...(defaultOptionIds ? { defaultOptionIds } : {}),
    });
  }
  return questions;
};

export const buildWaitPolicy = (
  timeoutEnabled: unknown,
  questions: Question[],
): WaitPolicy | null => {
  if (timeoutEnabled === undefined || timeoutEnabled === false) return { mode: 'required' };
  if (timeoutEnabled !== true) return null;

  const hasDefaultsForEveryQuestion = questions.every(
    question => question.defaultOptionIds?.length,
  );
  return {
    mode: 'timeout',
    timeoutMinutes: ASK_USER_TIMEOUT_MINUTES,
    onTimeout: hasDefaultsForEveryQuestion ? 'use-defaults' : 'model-decides',
  };
};

const parseAnswers = (value: unknown, questions: Question[]): AskUserResponse['answers'] => {
  if (!isRecord(value) || Object.keys(value).length !== questions.length) return undefined;
  const answers: NonNullable<AskUserResponse['answers']> = {};
  for (const question of questions) {
    const rawAnswer = value[question.id];
    if (!isRecord(rawAnswer) || !Array.isArray(rawAnswer.selected)) return undefined;
    const selected = rawAnswer.selected.map(readRequiredString);
    if (selected.some(id => !id)) return undefined;
    const selectedIds = selected as string[];
    const optionsById = new Map(question.options.map(option => [option.id, option]));
    if (
      new Set(selectedIds).size !== selectedIds.length ||
      (!question.multiSelect && selectedIds.length > 1) ||
      selectedIds.some(id => !optionsById.has(id))
    )
      return undefined;
    const other = rawAnswer.other === undefined ? undefined : readRequiredString(rawAnswer.other);
    if (
      (rawAnswer.other !== undefined && !other) ||
      (!question.multiSelect && selectedIds.length > 0 && other) ||
      (selectedIds.length === 0 && !other)
    )
      return undefined;
    let optionInputs: Record<string, string> | undefined;
    if (rawAnswer.optionInputs !== undefined) {
      if (!isRecord(rawAnswer.optionInputs)) return undefined;
      optionInputs = {};
      for (const [optionId, rawInput] of Object.entries(rawAnswer.optionInputs)) {
        const input = readRequiredString(rawInput);
        if (!input || !selectedIds.includes(optionId) || !optionsById.get(optionId)?.input) {
          return undefined;
        }
        optionInputs[optionId] = input;
      }
    }
    if (selectedIds.some(id => optionsById.get(id)?.input && !optionInputs?.[id])) return undefined;
    answers[question.id] = {
      selected: selectedIds,
      ...(optionInputs && Object.keys(optionInputs).length > 0 ? { optionInputs } : {}),
      ...(other ? { other } : {}),
    };
  }
  return answers;
};

const QuestionOptionSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: ASK_USER_ID_PATTERN,
    description: 'Stable option identifier, unique within the question.',
  }),
  label: Type.String({ description: 'Option label (1-5 words).' }),
  description: Type.Optional(Type.String({ description: 'Short explanation or tradeoff.' })),
  input: Type.Optional(
    Type.Object(
      {
        label: Type.String({
          description:
            'Label for the required extra information requested after this option is selected.',
        }),
        placeholder: Type.Optional(
          Type.String({
            description: 'Example or hint shown in the extra-information field.',
          }),
        ),
      },
      {
        description: 'Required text input shown only when this option is selected.',
      },
    ),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: ASK_USER_ID_PATTERN,
    description: 'Stable question identifier, unique within this request.',
  }),
  question: Type.String({ description: 'Question shown to the user.' }),
  header: Type.Optional(Type.String({ description: 'Short tag (max 12 characters).' })),
  options: Type.Array(QuestionOptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: 'Available choices (2-4 options).',
  }),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Allow multiple selections.' })),
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
        description:
          'Default option ids for this question when top-level timeoutEnabled is true. Define this field on every question to auto-select defaults after timeout. Use exactly one id for single-select questions. Options requiring input cannot be defaults.',
      },
    ),
  ),
});

export const AskUserQuestionSchema = Type.Object(
  {
    questions: Type.Array(QuestionSchema, {
      minItems: 1,
      maxItems: MAX_ASK_USER_QUESTIONS,
      description: `Questions to show (1-${MAX_ASK_USER_QUESTIONS}).`,
    }),
    timeoutEnabled: Type.Optional(
      Type.Boolean({
        description:
          'Set true to enable a fixed ten-minute timeout. Omit or set false when an explicit user answer is required. After timeout, defaults are selected automatically only when every question defines defaultOptionIds; otherwise control returns to the model to decide from context.',
      }),
    ),
  },
  { additionalProperties: false },
);

async function askUser(
  config: PluginConfig,
  input: AskUserCallbackInput,
  signal?: AbortSignal,
): Promise<AskUserResponse> {
  try {
    const response = isLoopbackCallbackUrl(config.callbackUrl)
      ? await postLoopbackJson(config.callbackUrl, input, config.secret, signal)
      : await fetch(config.callbackUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-ask-user-secret': config.secret,
          },
          body: JSON.stringify(input),
          signal,
        });

    const text = await readCallbackBody(response);

    if (!response.ok) {
      throw new Error(
        `AskUserQuestion callback HTTP ${response.status}: ${text.trim() || response.statusText}`,
      );
    }

    if (!text.trim()) return { behavior: 'deny' };

    const parsed = JSON.parse(text);
    if (parsed?.behavior === 'timeout') return { behavior: 'timeout' };
    if (parsed?.behavior !== 'allow') return { behavior: 'deny' };
    const answers = parseAnswers(parsed.answers, input.questions);
    if (!answers) return { behavior: 'deny' };
    return {
      behavior: 'allow',
      answers,
      ...(parsed.timedOut === true ? { timedOut: true } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { behavior: 'deny' };
    throw error;
  }
}

export const formatAskUserToolResponse = (
  response: AskUserResponse,
  questions: Question[],
): string => {
  if (response.behavior === 'deny') return 'User denied the operation.';
  if (response.behavior === 'timeout') {
    return 'Timed out waiting for the user. Choose suitable values yourself based on the context and continue.';
  }

  const answerLines = response.answers
    ? Object.entries(response.answers)
        .map(([questionId, answer]) => {
          const question = questions.find(item => item.id === questionId);
          const optionsById = new Map(question?.options.map(option => [option.id, option]) ?? []);
          const lines = [
            question?.question ?? questionId,
            `用户选择：${answer.selected.map(id => optionsById.get(id)?.label ?? id).join(', ') || '无'}`,
          ];
          if (answer.optionInputs && Object.keys(answer.optionInputs).length > 0) {
            lines.push(
              '补充信息：',
              ...Object.entries(answer.optionInputs).map(
                ([optionId, value]) =>
                  `- ${optionsById.get(optionId)?.label ?? optionId}: ${value}`,
              ),
            );
          }
          if (answer.other) lines.push(`其他：${answer.other}`);
          return lines.join('\n');
        })
        .join('\n\n')
    : 'User approved.';

  const prefix = response.timedOut
    ? 'The user did not respond before the timeout. The configured default choices were selected automatically.\n\n'
    : '';
  return `${prefix}${answerLines}`;
};

const plugin = {
  id: 'ask-user-question',
  name: 'AskUserQuestion',
  description: 'Structured choice and confirmation tool for the desktop application.',
  configSchema: {
    parse(value: unknown): PluginConfig {
      return parsePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    if (!config.callbackUrl || !config.secret) {
      api.logger.info('[ask-user-question] skipped: callbackUrl or secret not configured.');
      return;
    }

    // Use a factory so the tool is only available for JustDo desktop sessions.
    // IM channel sessions (qqbot, dingtalk, weixin, feishu, etc.) get null -> tool hidden.
    api.registerTool(
      ctx => {
        const sessionKey = ctx.sessionKey ?? '';
        const isLocalDesktop =
          sessionKey.startsWith('justdo:') || /^agent:[^:]+:justdo:/.test(sessionKey);
        if (!isLocalDesktop) {
          return null;
        }

        return {
          name: 'AskUserQuestion',
          label: 'Ask User Question',
          description:
            'Ask the user to choose from 2-4 predefined options. ' +
            'Set an option input when selecting it requires additional information from the user. ' +
            'Omit timeoutEnabled when only the user can safely answer, including consequential confirmations. ' +
            'For non-critical preferences, set timeoutEnabled to true for a fixed ten-minute wait. To auto-select on timeout, set defaultOptionIds inside every question; otherwise the model resumes and decides from context. ' +
            'Prefer this tool whenever the user needs to choose, decide, confirm, or select and clear options can be provided.',
          parameters: AskUserQuestionSchema,
          async execute(_id: string, params: unknown, signal?: AbortSignal) {
            const toolInput = params as AskUserToolInput;
            const questions = parseQuestions(toolInput?.questions);
            const waitPolicy = questions
              ? buildWaitPolicy(toolInput?.timeoutEnabled, questions)
              : null;
            const input: AskUserCallbackInput = {
              questions: questions ?? [],
              sessionKey,
              waitPolicy: waitPolicy ?? { mode: 'required' },
            };
            if (!questions || !waitPolicy) {
              return {
                content: [
                  { type: 'text', text: 'Invalid questions or timeoutEnabled flag provided.' },
                ],
                isError: true,
              };
            }

            try {
              const response = await askUser(config, input, signal);
              return {
                content: [
                  { type: 'text', text: formatAskUserToolResponse(response, input.questions) },
                ],
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return {
                content: [{ type: 'text', text: `AskUserQuestion failed: ${message}` }],
                isError: true,
              };
            }
          },
        }; // end of returned tool object
      },
      { name: 'AskUserQuestion' },
    ); // end of factory function passed to registerTool

    api.logger.info('[ask-user-question] registered AskUserQuestion tool factory.');
  },
};

export default plugin;
