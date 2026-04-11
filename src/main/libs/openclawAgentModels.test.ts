import { describe, expect, test } from 'vitest';

import {
  buildAgentEntry,
  buildManagedAgentEntries,
  parsePrimaryModelRef,
  resolveManagedSessionModelTarget,
  resolveQualifiedAgentModelRef,
} from './openclawAgentModels';

describe('buildAgentEntry', () => {
  test('emits explicit model.primary for the main agent', () => {
    const result = buildAgentEntry(
      {
        id: 'main',
        name: 'main',
        description: '',
        systemPrompt: '',
        identity: '',
        model: 'gucciai-server/deepseek-v3.2',
        icon: '',
        skillIds: [],
        enabled: true,
        isDefault: true,
        source: 'custom',
        presetId: '',
        createdAt: 0,
        updatedAt: 0,
      },
      'anthropic/claude-sonnet-4',
    );

    expect(result).toMatchObject({
      id: 'main',
      default: true,
      model: { primary: 'gucciai-server/deepseek-v3.2' },
    });
  });

  test('falls back to the default model when agent model is an ambiguous bare id', () => {
    const result = buildAgentEntry(
      {
        id: 'main',
        name: 'main',
        description: '',
        systemPrompt: '',
        identity: '',
        model: 'deepseek-v3.2',
        icon: '',
        skillIds: [],
        enabled: true,
        isDefault: true,
        source: 'custom',
        presetId: '',
        createdAt: 0,
        updatedAt: 0,
      },
      'anthropic/claude-sonnet-4',
    );

    expect(result).toMatchObject({
      id: 'main',
      model: { primary: 'anthropic/claude-sonnet-4' },
    });
  });
});

describe('buildManagedAgentEntries', () => {
  test('emits explicit model.primary for enabled non-main agents', () => {
    const result = buildManagedAgentEntries({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          description: '',
          systemPrompt: '',
          identity: '',
          model: 'openai/gpt-4o',
          icon: '✍️',
          skillIds: ['docx'],
          enabled: true,
          isDefault: false,
          source: 'custom',
          presetId: '',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      fallbackPrimaryModel: 'anthropic/claude-sonnet-4',
    });

    expect(result).toContainEqual(
      expect.objectContaining({
        id: 'writer',
        model: { primary: 'openai/gpt-4o' },
        skills: ['docx'],
      }),
    );
  });

  test('falls back to the default primary model when agent model is empty', () => {
    const result = buildManagedAgentEntries({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          description: '',
          systemPrompt: '',
          identity: '',
          model: '',
          icon: '✍️',
          skillIds: [],
          enabled: true,
          isDefault: false,
          source: 'custom',
          presetId: '',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      fallbackPrimaryModel: 'anthropic/claude-sonnet-4',
    });

    expect(result[0]).toMatchObject({
      id: 'writer',
      model: { primary: 'anthropic/claude-sonnet-4' },
    });
  });
});

describe('parsePrimaryModelRef', () => {
  test('parses provider-qualified primary model refs', () => {
    expect(parsePrimaryModelRef('gucciai-server/deepseek-v3.2')).toEqual({
      providerId: 'gucciai-server',
      modelId: 'deepseek-v3.2',
      primaryModel: 'gucciai-server/deepseek-v3.2',
    });
  });

  test('returns null for bare model ids', () => {
    expect(parsePrimaryModelRef('deepseek-v3.2')).toBeNull();
  });
});

describe('resolveManagedSessionModelTarget', () => {
  const availableProviders = {
    'gucciai-server': { models: [{ id: 'qwen3.5-plus' }, { id: 'deepseek-v3.2' }] },
    minimax: { models: [{ id: 'MiniMax-M2.7' }] },
  };

  test('uses fallback target when agent model is empty', () => {
    expect(
      resolveManagedSessionModelTarget({
        agentModel: '',
        fallbackPrimaryModel: 'gucciai-server/qwen3.5-plus',
        availableProviders,
      }),
    ).toEqual({
      providerId: 'gucciai-server',
      modelId: 'qwen3.5-plus',
      primaryModel: 'gucciai-server/qwen3.5-plus',
    });
  });

  test('keeps explicit provider-qualified models', () => {
    expect(
      resolveManagedSessionModelTarget({
        agentModel: 'minimax/MiniMax-M2.7',
        fallbackPrimaryModel: 'gucciai-server/qwen3.5-plus',
        availableProviders,
      }),
    ).toEqual({
      providerId: 'minimax',
      modelId: 'MiniMax-M2.7',
      primaryModel: 'minimax/MiniMax-M2.7',
    });
  });

  test('resolves bare model ids against available providers', () => {
    expect(
      resolveManagedSessionModelTarget({
        agentModel: 'deepseek-v3.2',
        fallbackPrimaryModel: 'gucciai-server/qwen3.5-plus',
        availableProviders,
      }),
    ).toEqual({
      providerId: 'gucciai-server',
      modelId: 'deepseek-v3.2',
      primaryModel: 'gucciai-server/deepseek-v3.2',
    });
  });

  test('falls back to current provider when bare model cannot be resolved uniquely', () => {
    expect(
      resolveManagedSessionModelTarget({
        agentModel: 'unknown-model',
        fallbackPrimaryModel: 'gucciai-server/qwen3.5-plus',
        availableProviders,
        currentProviderId: 'gucciai-server',
      }),
    ).toEqual({
      providerId: 'gucciai-server',
      modelId: 'unknown-model',
      primaryModel: 'gucciai-server/unknown-model',
    });
  });
});

describe('resolveQualifiedAgentModelRef', () => {
  test('qualifies bare model ids when exactly one provider matches', () => {
    expect(
      resolveQualifiedAgentModelRef({
        agentModel: 'deepseek-v3.2',
        availableProviders: {
          'gucciai-server': { models: [{ id: 'deepseek-v3.2' }] },
          minimax: { models: [{ id: 'MiniMax-M2.7' }] },
        },
      }),
    ).toEqual({
      status: 'qualified',
      primaryModel: 'gucciai-server/deepseek-v3.2',
    });
  });

  test('does not auto-qualify bare model ids when multiple providers match', () => {
    expect(
      resolveQualifiedAgentModelRef({
        agentModel: 'deepseek-v3.2',
        availableProviders: {
          anthropic: { models: [{ id: 'deepseek-v3.2' }] },
          'gucciai-server': { models: [{ id: 'deepseek-v3.2' }] },
        },
      }),
    ).toEqual({
      status: 'ambiguous',
      modelId: 'deepseek-v3.2',
      providerIds: ['anthropic', 'gucciai-server'],
    });
  });
});
