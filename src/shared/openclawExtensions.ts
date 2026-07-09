export const OpenClawExtensionId = {
  ASK_USER_QUESTION: 'ask-user-question',
} as const;

export const OpenClawToolName = {
  ASK_USER_QUESTION: 'AskUserQuestion',
} as const;

export const CoworkInteractionKind = {
  STRUCTURED_QUESTION: 'structured-question',
} as const;

export type CoworkInteractionKind =
  (typeof CoworkInteractionKind)[keyof typeof CoworkInteractionKind];

export type AskUserQuestionOption = {
  label: string;
  description?: string;
};

export type AskUserQuestion = {
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

export type AskUserResponse = {
  behavior: 'allow' | 'deny';
  answers?: Record<string, string>;
};
