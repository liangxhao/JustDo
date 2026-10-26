export const MAX_ASK_USER_QUESTIONS = 8;
export const MAX_ASK_USER_HEADER_LENGTH = 12;
export const ASK_USER_ID_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

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

export type AskUserAnswers = Record<
  string,
  {
    selected: string[];
    optionInputs?: Record<string, string>;
    other?: string;
    skipped?: true;
  }
>;

export type AskUserResponse =
  | { status: 'answered'; answers: AskUserAnswers; timedOut?: boolean }
  | { status: 'cancelled' }
  | { status: 'timeout' };

export const QUESTION_RESULT_VERSION = 1;

export type QuestionResult = {
  version: typeof QUESTION_RESULT_VERSION;
  questions: Question[];
  response: AskUserResponse;
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

/** Decode the plugin-owned result snapshot without interpreting model-visible prose. */
export const parseQuestionResult = (value: unknown): QuestionResult | null => {
  if (!isRecord(value) || value.version !== QUESTION_RESULT_VERSION) return null;
  const questions = parseQuestions(value.questions);
  const rawResponse = value.response;
  if (!questions || !isRecord(rawResponse)) return null;

  let response: AskUserResponse;
  if (rawResponse.status === 'answered') {
    if (rawResponse.timedOut !== undefined && typeof rawResponse.timedOut !== 'boolean') {
      return null;
    }
    const answers = parseAnswers(rawResponse.answers, questions);
    if (!answers) return null;
    if (
      rawResponse.timedOut === true &&
      questions.some(question => {
        const answer = answers[question.id];
        const defaults = question.defaultOptionIds;
        return (
          !defaults?.length ||
          answer.skipped === true ||
          answer.other !== undefined ||
          answer.optionInputs !== undefined ||
          answer.selected.length !== defaults.length ||
          defaults.some(id => !answer.selected.includes(id))
        );
      })
    ) {
      return null;
    }
    response = {
      status: 'answered',
      answers,
      ...(rawResponse.timedOut === true
        ? { timedOut: true }
        : rawResponse.timedOut === false
          ? { timedOut: false }
          : {}),
    };
  } else if (rawResponse.status === 'timeout' || rawResponse.status === 'cancelled') {
    if (rawResponse.answers !== undefined || rawResponse.timedOut !== undefined) return null;
    response = { status: rawResponse.status };
  } else {
    return null;
  }
  return { version: QUESTION_RESULT_VERSION, questions, response };
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const singleTextContent = (value: unknown): string | null => {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const block = value[0];
  return isRecord(block) && block.type === 'text' && typeof block.text === 'string'
    ? block.text
    : null;
};

/** Read the explicit JSON result envelope that survives native history projection. */
export const readQuestionResult = (value: unknown): QuestionResult | null => {
  const source = typeof value === 'string' ? parseJson(value) : value;
  if (isRecord(source)) {
    const direct = parseQuestionResult(source.askUserQuestion);
    if (direct) return direct;
    const details = isRecord(source.details) ? source.details : null;
    const detailed = parseQuestionResult(details?.askUserQuestion);
    if (detailed) return detailed;
  }

  const content = isRecord(source) ? source.content : source;
  const text = typeof content === 'string' ? content : singleTextContent(content);
  if (text === null) return null;
  const envelope = parseJson(text);
  return isRecord(envelope) ? parseQuestionResult(envelope.askUserQuestion) : null;
};
