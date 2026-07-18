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
