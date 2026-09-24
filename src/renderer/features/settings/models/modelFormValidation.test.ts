import { describe, expect, test } from 'vitest';

import { validateModelForm } from './modelFormValidation';

const validForm = {
  modelId: 'chat-model',
  modelName: 'Chat model',
  contextLength: 200_000,
  maxTokens: 32_000,
  existingModelIds: [],
};

describe('validateModelForm', () => {
  test('accepts a complete chat model form', () => {
    expect(validateModelForm(validForm)).toBeNull();
  });

  test('requires model identity fields', () => {
    expect(validateModelForm({ ...validForm, modelId: ' ' })).toBe('modelNameAndIdRequired');
  });

  test('rejects duplicate ids except the model currently being edited', () => {
    expect(validateModelForm({ ...validForm, existingModelIds: ['chat-model'] })).toBe(
      'modelIdExists',
    );
    expect(
      validateModelForm({
        ...validForm,
        existingModelIds: ['chat-model'],
        editingModelId: 'chat-model',
      }),
    ).toBeNull();
  });

  test('rejects invalid token lengths', () => {
    expect(validateModelForm({ ...validForm, contextLength: 0 })).toBe('modelTokenLengthsPositive');
    expect(validateModelForm({ ...validForm, maxTokens: 200_000 })).toBe(
      'contextLengthMustExceedMaxTokens',
    );
  });
});
