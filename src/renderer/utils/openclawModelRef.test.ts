import { describe, expect, test, vi } from 'vitest';

import type { Model } from '../store/slices/modelSlice';
import {
  toOpenClawModelRef,
  resolveOpenClawModelRef,
  matchesOpenClawModelRef,
} from '../utils/openclawModelRef';

// Mock configService (fallback only, prefer model.provider)
vi.mock('../services/config', () => ({
  configService: {
    getConfig: () => ({
      providers: {
        custom_0: {
          enabled: true,
          displayName: 'Anthropic',
          models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true }],
        },
      },
    }),
  },
}));

describe('openclawModelRef', () => {
  describe('toOpenClawModelRef', () => {
    test('generates lowercase provider ref from model.provider field', () => {
      const model: Model = {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        providerKey: 'custom_0',
        provider: 'Anthropic', // displayName from App.tsx
      };

      const ref = toOpenClawModelRef(model);
      expect(ref).toBe('anthropic/claude-sonnet-4-6');
    });

    test('generates lowercase provider ref when provider field is empty', () => {
      const model: Model = {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        providerKey: 'custom_0',
        provider: '', // fallback to configService
      };

      const ref = toOpenClawModelRef(model);
      expect(ref).toBe('anthropic/claude-sonnet-4-6');
    });

    test('generates gucciai ref for server models', () => {
      const model: Model = {
        id: 'gpt-4o',
        name: 'GPT-4o',
        providerKey: 'openai',
        isServerModel: true,
      };

      const ref = toOpenClawModelRef(model);
      expect(ref).toBe('gucciai/gpt-4o');
    });
  });

  describe('resolveOpenClawModelRef', () => {
    const customModels: Model[] = [
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        providerKey: 'custom_0',
        provider: 'Anthropic',
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        providerKey: 'custom_1',
        provider: 'OpenAI',
        isServerModel: true,
      },
    ];

    test('matches model ref with displayName-based provider', () => {
      // Agent model stored as "anthropic/claude-sonnet-4-6"
      // model.provider is "Anthropic"
      const result = resolveOpenClawModelRef('anthropic/claude-sonnet-4-6', customModels);
      expect(result?.id).toBe('claude-sonnet-4-6');
    });

    test('matches model ref with case-insensitive displayName', () => {
      // Agent model stored as "Anthropic/claude-sonnet-4-6" (uppercase)
      const result = resolveOpenClawModelRef('Anthropic/claude-sonnet-4-6', customModels);
      expect(result?.id).toBe('claude-sonnet-4-6');
    });

    test('matches model ref with default displayName fallback', () => {
      // Agent model stored as "custom0/claude-sonnet-4-6" (default displayName)
      const result = resolveOpenClawModelRef('custom0/claude-sonnet-4-6', customModels);
      expect(result?.id).toBe('claude-sonnet-4-6');
    });

    test('matches model ref with raw providerKey fallback', () => {
      // Agent model stored as "custom_0/claude-sonnet-4-6" (raw key)
      const result = resolveOpenClawModelRef('custom_0/claude-sonnet-4-6', customModels);
      expect(result?.id).toBe('claude-sonnet-4-6');
    });

    test('matches server model with gucciai provider', () => {
      const result = resolveOpenClawModelRef('gucciai/gpt-4o', customModels);
      expect(result?.id).toBe('gpt-4o');
      expect(result?.isServerModel).toBe(true);
    });

    test('returns null for unmatched model', () => {
      const result = resolveOpenClawModelRef('unknown/model-id', customModels);
      expect(result).toBeNull();
    });
  });

  describe('matchesOpenClawModelRef', () => {
    test('matches ref with case-insensitive comparison', () => {
      const model: Model = {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        providerKey: 'custom_0',
        provider: 'Anthropic',
      };

      expect(matchesOpenClawModelRef('Anthropic/claude-sonnet-4-6', model)).toBe(true);
      expect(matchesOpenClawModelRef('anthropic/claude-sonnet-4-6', model)).toBe(true);
      expect(matchesOpenClawModelRef('custom0/claude-sonnet-4-6', model)).toBe(true);
    });
  });
});
