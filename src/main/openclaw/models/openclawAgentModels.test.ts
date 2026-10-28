import { describe, expect, test } from 'vitest';

import {
  buildAgentEntry,
  buildManagedAgentEntries,
  parsePrimaryModelRef,
} from './openclawAgentModels';

describe('buildAgentEntry', () => {
  test('ignores legacy main model overrides and uses the application default', () => {
    const result = buildAgentEntry(
      {
        id: 'main',
        name: 'main',
        description: '',
        systemPrompt: '',
        identity: '',
        model: 'justdo-server/deepseek-v3.2',
        icon: '',
        skillIds: [],
        enabled: true,
        isDefault: true,
        createdAt: 0,
        updatedAt: 0,
      },
      'anthropic/claude-sonnet-4',
    );

    expect(result).toMatchObject({
      id: 'main',
      default: true,
      model: { primary: 'anthropic/claude-sonnet-4' },
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
    expect(parsePrimaryModelRef('justdo-server/deepseek-v3.2')).toEqual({
      providerId: 'justdo-server',
      modelId: 'deepseek-v3.2',
      primaryModel: 'justdo-server/deepseek-v3.2',
    });
  });

  test('returns null for bare model ids', () => {
    expect(parsePrimaryModelRef('deepseek-v3.2')).toBeNull();
  });
});
