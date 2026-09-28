import { describe, expect, test } from 'vitest';

import { resolveAgentModelSelection } from '@/features/cowork/components/composer/agentModelSelection';
import type { Model } from '@/features/models/modelSlice';

const models: Model[] = [
  { id: 'gpt-4o', name: 'GPT-4o', providerKey: 'openai' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', providerKey: 'anthropic' },
  { id: 'deepseek-v3.2', name: 'DeepSeek', providerKey: 'anthropic' },
  { id: 'deepseek-v3.2', name: 'DeepSeek Server', providerKey: 'openai', isServerModel: true },
];

describe('resolveAgentModelSelection', () => {
  test('uses explicit agent model when present (case-insensitive provider)', () => {
    // OpenClaw uses lowercase provider IDs, so "Anthropic" should match "anthropic"
    const result = resolveAgentModelSelection({
      agentModel: 'Anthropic/claude-sonnet-4',
      availableModels: models,
      fallbackModel: models[0],
    });

    expect(result.selectedModel?.id).toBe('claude-sonnet-4');
    expect(result.usesFallback).toBe(false);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('uses explicit agent model with lowercase provider', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'anthropic/claude-sonnet-4',
      availableModels: models,
      fallbackModel: models[0],
    });

    expect(result.selectedModel?.id).toBe('claude-sonnet-4');
    expect(result.usesFallback).toBe(false);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('falls back to the global model when agent model is empty', () => {
    const result = resolveAgentModelSelection({
      agentModel: '',
      availableModels: models,
      fallbackModel: models[0],
    });

    expect(result.selectedModel?.id).toBe('gpt-4o');
    expect(result.usesFallback).toBe(true);
    expect(result.hasInvalidExplicitModel).toBe(false);
  });

  test('falls back to an available global model when the explicit model is invalid', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'deleted-model',
      availableModels: models,
      fallbackModel: models[0],
    });

    expect(result.selectedModel?.id).toBe('gpt-4o');
    expect(result.usesFallback).toBe(true);
    expect(result.hasInvalidExplicitModel).toBe(true);
  });

  test('treats ambiguous bare model ids as invalid instead of guessing a provider', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'deepseek-v3.2',
      availableModels: models,
      fallbackModel: models[0],
    });

    expect(result.selectedModel?.id).toBe('gpt-4o');
    expect(result.usesFallback).toBe(true);
    expect(result.hasInvalidExplicitModel).toBe(true);
  });

  test('falls back to the first available model when the global selection is unavailable', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'deleted-provider/deleted-model',
      availableModels: models,
      fallbackModel: {
        id: 'also-deleted',
        name: 'Also deleted',
        providerKey: 'deleted-provider',
      },
    });

    expect(result.selectedModel).toBe(models[0]);
    expect(result.hasInvalidExplicitModel).toBe(true);
  });

  test('returns no selection when no models are available', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'deleted-provider/deleted-model',
      availableModels: [],
      fallbackModel: models[0],
    });

    expect(result.selectedModel).toBeNull();
    expect(result.usesFallback).toBe(true);
    expect(result.hasInvalidExplicitModel).toBe(true);
  });
});

test.each(['anthropic/claude-sonnet-4', 'deleted-provider/deleted-model'])(
  'ignores legacy main profile model %s without an unresolved-model warning',
  agentModel => {
    const result = resolveAgentModelSelection({
      agentId: 'main',
      agentModel,
      availableModels: models,
      fallbackModel: models[0],
    });
    expect(result.selectedModel).toBe(models[0]);
    expect(result.hasInvalidExplicitModel).toBe(false);
  },
);

test('retains an existing main session model ahead of application defaults', () => {
  const result = resolveAgentModelSelection({
    agentId: 'main',
    agentModel: 'deleted-model',
    sessionModel: 'anthropic/claude-sonnet-4',
    availableModels: models,
    fallbackModel: models[0],
  });
  expect(result.selectedModel).toBe(models[1]);
  expect(result.usesFallback).toBe(false);
});

test('shows the effective application default for an assistant whose built-in model was retired', () => {
  const result = resolveAgentModelSelection({
    agentId: 'review',
    agentModel: 'builtin_models/retired-model',
    availableModels: models,
    fallbackModel: models[1],
  });

  expect(result.selectedModel).toBe(models[1]);
  expect(result.usesFallback).toBe(true);
  expect(result.hasInvalidExplicitModel).toBe(true);
});

test('retains the assistant session selection when its saved profile model was retired', () => {
  const result = resolveAgentModelSelection({
    agentId: 'review',
    agentModel: 'builtin_models/retired-model',
    sessionModel: 'anthropic/claude-sonnet-4',
    availableModels: models,
    fallbackModel: models[0],
  });

  expect(result.selectedModel).toBe(models[1]);
  expect(result.usesFallback).toBe(false);
  expect(result.hasInvalidExplicitModel).toBe(false);
});
