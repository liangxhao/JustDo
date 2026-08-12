export const OpenClawExtensionId = {
  ASK_USER_QUESTION: 'ask-user-question',
  PERMISSION_POLICY: 'file-permission-policy',
} as const;

export const OpenClawToolName = {
  ASK_USER_QUESTION: 'AskUserQuestion',
} as const;

export const CoworkInteractionKind = {
  STRUCTURED_QUESTION: 'structured-question',
} as const;

export const CoworkInteractionIpc = {
  Respond: 'cowork:interaction:respond',
  Replay: 'cowork:interaction:replay',
  Stream: 'cowork:stream:interaction',
  Dismiss: 'cowork:stream:interactionDismiss',
} as const;

export type CoworkInteractionKind =
  (typeof CoworkInteractionKind)[keyof typeof CoworkInteractionKind];

export type AskUserQuestionOption = {
  id: string;
  label: string;
  description?: string;
  input?: {
    label: string;
    placeholder?: string;
  };
};

export type AskUserQuestion = {
  id: string;
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
};

export type AskUserRequest = {
  requestId: string;
  sessionKey?: string;
  questions: AskUserQuestion[];
};

export type AskUserQuestionAnswer = {
  selected: string[];
  optionInputs?: Record<string, string>;
  other?: string;
};

export type AskUserAnswers = Record<string, AskUserQuestionAnswer>;

export type AskUserResponse = {
  behavior: 'allow' | 'deny';
  answers?: AskUserAnswers;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const ASK_USER_ID_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';
export const MAX_ASK_USER_QUESTIONS = 8;
const askUserIdRegex = new RegExp(ASK_USER_ID_PATTERN);

const isSafeAskUserId = (value: string): boolean =>
  askUserIdRegex.test(value) && !(value in Object.prototype);

const readRequiredString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

export const parseAskUserQuestions = (value: unknown): AskUserQuestion[] | null => {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > MAX_ASK_USER_QUESTIONS) return null;

  const questionIds = new Set<string>();
  const questions: AskUserQuestion[] = [];
  for (const rawQuestion of value) {
    if (!isRecord(rawQuestion)) return null;
    const id = readRequiredString(rawQuestion.id);
    const question = readRequiredString(rawQuestion.question);
    if (!id || !isSafeAskUserId(id) || !question || questionIds.has(id)) return null;
    if ((rawQuestion.header !== undefined && typeof rawQuestion.header !== 'string')
      || (rawQuestion.multiSelect !== undefined && typeof rawQuestion.multiSelect !== 'boolean')) {
      return null;
    }
    if (!Array.isArray(rawQuestion.options)
      || rawQuestion.options.length < 2
      || rawQuestion.options.length > 4) return null;

    const optionIds = new Set<string>();
    const options: AskUserQuestionOption[] = [];
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

      let input: AskUserQuestionOption['input'];
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
      ...(typeof rawQuestion.header === 'string'
        ? { header: rawQuestion.header.trim() }
        : {}),
      ...(rawQuestion.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return questions;
};

export const parseAskUserAnswers = (
  value: unknown,
  questions: AskUserQuestion[],
): AskUserAnswers | null => {
  if (!isRecord(value) || Object.keys(value).length !== questions.length) return null;

  const answers: AskUserAnswers = {};
  for (const question of questions) {
    const rawAnswer = value[question.id];
    if (!isRecord(rawAnswer) || !Array.isArray(rawAnswer.selected)) return null;
    const selected = rawAnswer.selected.map(readRequiredString);
    if (selected.some(id => !id)) return null;
    const selectedIds = selected as string[];
    if (new Set(selectedIds).size !== selectedIds.length) return null;
    if (!question.multiSelect && selectedIds.length > 1) return null;

    const optionsById = new Map(question.options.map(option => [option.id, option]));
    if (selectedIds.some(id => !optionsById.has(id))) return null;

    const other = rawAnswer.other === undefined
      ? undefined
      : readRequiredString(rawAnswer.other);
    if (rawAnswer.other !== undefined && !other) return null;
    if (!question.multiSelect && selectedIds.length > 0 && other) return null;
    if (selectedIds.length === 0 && !other) return null;

    let optionInputs: Record<string, string> | undefined;
    if (rawAnswer.optionInputs !== undefined) {
      if (!isRecord(rawAnswer.optionInputs)) return null;
      optionInputs = {};
      for (const [optionId, rawInput] of Object.entries(rawAnswer.optionInputs)) {
        const input = readRequiredString(rawInput);
        const option = optionsById.get(optionId);
        if (!input || !selectedIds.includes(optionId) || !option?.input) return null;
        optionInputs[optionId] = input;
      }
    }

    for (const optionId of selectedIds) {
      if (optionsById.get(optionId)?.input && !optionInputs?.[optionId]) return null;
    }

    answers[question.id] = {
      selected: selectedIds,
      ...(optionInputs && Object.keys(optionInputs).length > 0 ? { optionInputs } : {}),
      ...(other ? { other } : {}),
    };
  }
  return answers;
};

export const ExtensionIpc = {
  List: 'extensions:list',
  Import: 'extensions:import',
  ImportProgress: 'extensions:import-progress',
  Delete: 'extensions:delete',
  SetEnabled: 'extensions:set-enabled',
  UpdateConfiguration: 'extensions:update-configuration',
} as const;

export type OpenClawExtensionConfigurationField = {
  path: string;
  label: string;
  help?: string;
  requirement?: string;
  sensitive: boolean;
  configured: boolean;
};

export type InstalledOpenClawExtension = {
  id: string;
  name: string;
  description: string;
  version?: string;
  installPath: string;
  enabled: boolean;
  missingRequirements: string[];
  configurationFields: OpenClawExtensionConfigurationField[];
};

export type ExtensionUpdateConfigurationRequest = {
  extensionId: string;
  values: Record<string, string>;
};

export type ExtensionUpdateConfigurationResult = {
  success: boolean;
  error?: string;
};

export type ExtensionSetEnabledRequest = {
  extensionId: string;
  enabled: boolean;
};

export type ExtensionSetEnabledResult = {
  success: boolean;
  error?: string;
};

export type ExtensionDeleteRequest = {
  extensionId: string;
};

export type ExtensionDeleteResult = {
  success: boolean;
  error?: string;
};

export type ExtensionImportStage =
  | 'preparing'
  | 'extracting'
  | 'validating'
  | 'preparing_runtime'
  | 'installing'
  | 'installing_dependencies'
  | 'restarting_gateway'
  | 'completed';

export type ExtensionImportRequest = {
  requestId: string;
  sourcePath: string;
};

export type ExtensionImportProgress = ExtensionImportRequest & {
  stage: ExtensionImportStage;
  percent: number;
};

export type ExtensionImportResult = {
  success: boolean;
  extensionId?: string;
  error?: string;
  failedStage?: ExtensionImportStage;
};
