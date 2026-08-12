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
};

type AskUserInput = {
  questions: Question[];
  sessionKey?: string;
};

type AskUserResponse = {
  behavior: 'allow' | 'deny';
  answers?: Record<string, {
    selected: string[];
    optionInputs?: Record<string, string>;
    other?: string;
  }>;
};

const LOOPBACK_CALLBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ASK_USER_ID_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
export const MAX_ASK_USER_QUESTIONS = 8;
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
      (url.protocol === 'http:' || url.protocol === 'https:')
      && LOOPBACK_CALLBACK_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
};

const postLoopbackJson = (
  callbackUrl: string,
  input: AskUserInput,
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
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > MAX_ASK_USER_QUESTIONS) return null;
  const questionIds = new Set<string>();
  const questions: Question[] = [];
  for (const rawQuestion of value) {
    if (!isRecord(rawQuestion)) return null;
    const id = readRequiredString(rawQuestion.id);
    const question = readRequiredString(rawQuestion.question);
    if (!id || !isSafeAskUserId(id) || !question || questionIds.has(id)
      || (rawQuestion.header !== undefined && typeof rawQuestion.header !== 'string')
      || (rawQuestion.multiSelect !== undefined && typeof rawQuestion.multiSelect !== 'boolean')
      || !Array.isArray(rawQuestion.options)
      || rawQuestion.options.length < 2 || rawQuestion.options.length > 4) return null;
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
        if (rawOption.input.placeholder !== undefined
          && typeof rawOption.input.placeholder !== 'string') return null;
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
    questions.push({
      id,
      question,
      options,
      ...(typeof rawQuestion.header === 'string' ? { header: rawQuestion.header.trim() } : {}),
      ...(rawQuestion.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return questions;
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
    if (new Set(selectedIds).size !== selectedIds.length
      || (!question.multiSelect && selectedIds.length > 1)
      || selectedIds.some(id => !optionsById.has(id))) return undefined;
    const other = rawAnswer.other === undefined ? undefined : readRequiredString(rawAnswer.other);
    if ((rawAnswer.other !== undefined && !other)
      || (!question.multiSelect && selectedIds.length > 0 && other)
      || (selectedIds.length === 0 && !other)) return undefined;
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
  input: Type.Optional(Type.Object({
    label: Type.String({
      description: 'Label for the required extra information requested after this option is selected.',
    }),
    placeholder: Type.Optional(Type.String({
      description: 'Example or hint shown in the extra-information field.',
    })),
  }, {
    description: 'Required text input shown only when this option is selected.',
  })),
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
});

export const AskUserQuestionSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_ASK_USER_QUESTIONS,
    description: `Questions to show (1-${MAX_ASK_USER_QUESTIONS}).`,
  }),
});

async function askUser(
  config: PluginConfig,
  input: AskUserInput,
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
      throw new Error(`AskUserQuestion callback HTTP ${response.status}: ${text.trim() || response.statusText}`);
    }

    if (!text.trim()) return { behavior: 'deny' };

    const parsed = JSON.parse(text);
    if (parsed?.behavior !== 'allow') return { behavior: 'deny' };
    const answers = parseAnswers(parsed.answers, input.questions);
    if (!answers) return { behavior: 'deny' };
    return { behavior: 'allow', answers };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { behavior: 'deny' };
    throw error;
  }
}

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
    api.registerTool((ctx) => {
      const sessionKey = ctx.sessionKey ?? '';
      const isLocalDesktop =
        sessionKey.startsWith('justdo:')
        || /^agent:[^:]+:justdo:/.test(sessionKey);
      if (!isLocalDesktop) {
        return null;
      }

      return {
        name: 'AskUserQuestion',
        label: 'Ask User Question',
        description:
          'Ask the user to choose from 2-4 predefined options and wait for the response. '
          + 'Set an option input when selecting it requires additional information from the user. '
          + 'Prefer this tool whenever the user needs to choose, decide, confirm, or select and clear options can be provided.',
      parameters: AskUserQuestionSchema,
      async execute(_id: string, params: unknown, signal?: AbortSignal) {
        const questions = parseQuestions((params as AskUserInput)?.questions);
        const input: AskUserInput = {
          questions: questions ?? [],
          sessionKey,
        };
        if (!questions) {
          return {
            content: [{ type: 'text', text: 'Invalid questions provided.' }],
            isError: true,
          };
        }

        try {
          const response = await askUser(config, input, signal);

          if (response.behavior === 'deny') {
            return {
              content: [{ type: 'text', text: 'User denied the operation.' }],
            };
          }

          const answerLines = response.answers
            ? Object.entries(response.answers)
                .map(([questionId, answer]) => {
                  const question = input.questions.find(item => item.id === questionId);
                  const optionsById = new Map(
                    question?.options.map(option => [option.id, option]) ?? [],
                  );
                  const lines = [
                    question?.question ?? questionId,
                    `用户选择：${answer.selected.map(id => optionsById.get(id)?.label ?? id).join(', ') || '无'}`,
                  ];
                  if (answer.optionInputs && Object.keys(answer.optionInputs).length > 0) {
                    lines.push(
                      '补充信息：',
                      ...Object.entries(answer.optionInputs).map(([optionId, value]) =>
                        `- ${optionsById.get(optionId)?.label ?? optionId}: ${value}`),
                    );
                  }
                  if (answer.other) lines.push(`其他：${answer.other}`);
                  return lines.join('\n');
                })
                .join('\n\n')
            : 'User approved.';

          return {
            content: [{ type: 'text', text: answerLines }],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text', text: `AskUserQuestion failed: ${message}` }],
            isError: true,
          };
        }
      },
    };  // end of returned tool object
    }, { name: 'AskUserQuestion' });  // end of factory function passed to registerTool

    api.logger.info('[ask-user-question] registered AskUserQuestion tool factory.');
  },
};

export default plugin;
