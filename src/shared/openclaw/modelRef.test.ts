import { describe, expect, test } from 'vitest';

import { normalizeModelRef, readModelRef } from './modelRef';

describe('modelRef', () => {
  test('keeps qualified models and qualifies bare models with their provider', () => {
    expect(normalizeModelRef('openai/gpt-5', 'ignored')).toBe('openai/gpt-5');
    expect(normalizeModelRef('gpt-5', 'openai')).toBe('openai/gpt-5');
  });

  test('keeps a bare legacy model when no provider is available', () => {
    expect(normalizeModelRef('legacy-model')).toBe('legacy-model');
  });

  test('reads gateway model provider fields before returning a normalized ref', () => {
    expect(readModelRef({ modelProvider: 'anthropic', model: 'claude-sonnet-4' })).toBe(
      'anthropic/claude-sonnet-4',
    );
    expect(readModelRef({ modelProvider: 'openai', modelName: 'gpt-5' })).toBe(
      'openai/gpt-5',
    );
    expect(readModelRef({ modelName: 'openai/gpt-5', model: 'ignored' })).toBe('openai/gpt-5');
  });
});
