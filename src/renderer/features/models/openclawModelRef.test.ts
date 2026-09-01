import { describe, expect, test } from 'vitest';

import type { Model } from '@/features/models/modelSlice';
import {
  matchesOpenClawModelRef,
  resolveOpenClawModelRef,
  toOpenClawModelRef,
} from '@/features/models/openclawModelRef';

describe('openclawModelRef', () => {
  describe('toOpenClawModelRef', () => {
    test('uses the custom provider display name as the model-visible provider id', () => {
      const model: Model = {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        providerKey: 'custom_0',
        provider: 'AcmeProxy',
      };

      const ref = toOpenClawModelRef(model);
      expect(ref).toBe('acmeproxy/claude-sonnet-4-6');
    });

    test('uses the non-reserved default display name when the display name is empty', () => {
      const model: Model = {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        providerKey: 'custom_0',
        provider: '', // fallback to configService
      };

      const ref = toOpenClawModelRef(model);
      expect(ref).toBe('custom0/claude-sonnet-4-6');
    });

    test('generates justdo ref for server models', () => {
      const model: Model = {
        id: 'gpt-4o',
        name: 'GPT-4o',
        providerKey: 'openai',
        isServerModel: true,
      };

      const ref = toOpenClawModelRef(model);
      expect(ref).toBe('justdo/gpt-4o');
    });

    test('qualifies a built-in model id that already contains a provider prefix', () => {
      const model: Model = {
        id: 'hdp/Glm-5.1',
        name: 'GLM-5.1',
        providerKey: 'builtin_models',
      };

      expect(toOpenClawModelRef(model)).toBe('builtin_models/hdp/Glm-5.1');
    });
  });

  describe('resolveOpenClawModelRef', () => {
    const customModels: Model[] = [
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        providerKey: 'custom_0',
        provider: 'AcmeProxy',
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
      const result = resolveOpenClawModelRef('acmeproxy/claude-sonnet-4-6', customModels);
      expect(result?.id).toBe('claude-sonnet-4-6');
    });

    test('matches model ref with case-insensitive displayName', () => {
      const result = resolveOpenClawModelRef('AcmeProxy/claude-sonnet-4-6', customModels);
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

    test('matches server model with justdo provider', () => {
      const result = resolveOpenClawModelRef('justdo/gpt-4o', customModels);
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
        provider: 'AcmeProxy',
      };

      expect(matchesOpenClawModelRef('AcmeProxy/claude-sonnet-4-6', model)).toBe(true);
      expect(matchesOpenClawModelRef('acmeproxy/claude-sonnet-4-6', model)).toBe(true);
      expect(matchesOpenClawModelRef('custom0/claude-sonnet-4-6', model)).toBe(true);
      expect(matchesOpenClawModelRef('custom_0/claude-sonnet-4-6', model)).toBe(true);
    });
  });
});
