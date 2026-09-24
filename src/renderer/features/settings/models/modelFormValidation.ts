export type ModelFormValidationError =
  | 'modelNameAndIdRequired'
  | 'modelIdExists'
  | 'modelTokenLengthsPositive'
  | 'contextLengthMustExceedMaxTokens';

type ValidateModelFormOptions = {
  modelId: string;
  modelName: string;
  contextLength?: number;
  maxTokens?: number;
  existingModelIds: string[];
  editingModelId?: string | null;
};

export const validateModelForm = ({
  modelId,
  modelName,
  contextLength,
  maxTokens,
  existingModelIds,
  editingModelId,
}: ValidateModelFormOptions): ModelFormValidationError | null => {
  const normalizedId = modelId.trim();
  if (!normalizedId || !modelName.trim()) {
    return 'modelNameAndIdRequired';
  }
  if (existingModelIds.some(id => id === normalizedId && id !== editingModelId)) {
    return 'modelIdExists';
  }
  if (
    typeof contextLength !== 'number' ||
    typeof maxTokens !== 'number' ||
    !Number.isInteger(contextLength) ||
    !Number.isInteger(maxTokens) ||
    contextLength <= 0 ||
    maxTokens <= 0
  ) {
    return 'modelTokenLengthsPositive';
  }
  if (contextLength <= maxTokens) {
    return 'contextLengthMustExceedMaxTokens';
  }
  return null;
};
