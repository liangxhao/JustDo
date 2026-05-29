import { expect,test } from 'vitest';

import {
  getCustomProviderDefaultName,
  getProviderDisplayName,
  isCustomProvider,
  validateDisplayName,
} from './config';

test('isCustomProvider: custom_0 is custom', () => {
  expect(isCustomProvider('custom_0')).toBe(true);
});

test('isCustomProvider: custom_1 is custom', () => {
  expect(isCustomProvider('custom_1')).toBe(true);
});

test('isCustomProvider: custom_99 is custom', () => {
  expect(isCustomProvider('custom_99')).toBe(true);
});

test('isCustomProvider: openai is not custom', () => {
  expect(isCustomProvider('openai')).toBe(false);
});

test('isCustomProvider: deepseek is not custom', () => {
  expect(isCustomProvider('deepseek')).toBe(false);
});

test('isCustomProvider: empty string is not custom', () => {
  expect(isCustomProvider('')).toBe(false);
});

test('isCustomProvider: "custom" without underscore is not custom', () => {
  expect(isCustomProvider('custom')).toBe(false);
});

test('getCustomProviderDefaultName: custom_0 -> Custom0', () => {
  expect(getCustomProviderDefaultName('custom_0')).toBe('Custom0');
});

test('getCustomProviderDefaultName: custom_1 -> Custom1', () => {
  expect(getCustomProviderDefaultName('custom_1')).toBe('Custom1');
});

test('getCustomProviderDefaultName: custom_42 -> Custom42', () => {
  expect(getCustomProviderDefaultName('custom_42')).toBe('Custom42');
});

test('getProviderDisplayName: built-in provider capitalizes first letter', () => {
  expect(getProviderDisplayName('openai')).toBe('Openai');
});

test('getProviderDisplayName: built-in provider with no config', () => {
  expect(getProviderDisplayName('deepseek')).toBe('Deepseek');
});

test('getProviderDisplayName: custom provider without config uses default name', () => {
  expect(getProviderDisplayName('custom_0')).toBe('Custom0');
});

test('getProviderDisplayName: custom provider with empty displayName uses default', () => {
  expect(getProviderDisplayName('custom_0', { displayName: '' })).toBe('Custom0');
});

test('getProviderDisplayName: custom provider with displayName uses it', () => {
  expect(getProviderDisplayName('custom_0', { displayName: 'My GPT' })).toBe('My GPT');
});

test('getProviderDisplayName: custom provider with undefined displayName uses default', () => {
  expect(getProviderDisplayName('custom_2', { displayName: undefined })).toBe('Custom2');
});

// validateDisplayName tests
test('validateDisplayName: empty string is valid (fallback to custom_0)', () => {
  expect(validateDisplayName('')).toEqual({ valid: true });
});

test('validateDisplayName: single letter is valid', () => {
  expect(validateDisplayName('A')).toEqual({ valid: true });
});

test('validateDisplayName: letters only is valid', () => {
  expect(validateDisplayName('LMStudio')).toEqual({ valid: true });
});

test('validateDisplayName: letters with numbers is valid', () => {
  expect(validateDisplayName('GPT4')).toEqual({ valid: true });
});

test('validateDisplayName: letters with underscore is valid', () => {
  expect(validateDisplayName('My_GPT')).toEqual({ valid: true });
});

test('validateDisplayName: letters with hyphen is valid', () => {
  expect(validateDisplayName('My-GPT')).toEqual({ valid: true });
});

test('validateDisplayName: letters with space is valid', () => {
  expect(validateDisplayName('My GPT')).toEqual({ valid: true });
});

test('validateDisplayName: mixed characters is valid', () => {
  expect(validateDisplayName('GPT-4o_Mini')).toEqual({ valid: true });
});

test('validateDisplayName: starts with number is invalid', () => {
  expect(validateDisplayName('123Studio')).toEqual({
    valid: false,
    error: 'Must start with letter, only letters/numbers/_/-/space allowed',
  });
});

test('validateDisplayName: starts with underscore is invalid', () => {
  expect(validateDisplayName('_GPT')).toEqual({
    valid: false,
    error: 'Must start with letter, only letters/numbers/_/-/space allowed',
  });
});

test('validateDisplayName: starts with hyphen is invalid', () => {
  expect(validateDisplayName('-GPT')).toEqual({
    valid: false,
    error: 'Must start with letter, only letters/numbers/_/-/space allowed',
  });
});

test('validateDisplayName: starts with space is valid after trim', () => {
  // ' GPT' trim 后变成 'GPT'，是合法的
  expect(validateDisplayName(' GPT')).toEqual({ valid: true });
});

test('validateDisplayName: built-in provider name is invalid', () => {
  expect(validateDisplayName('ollama')).toEqual({
    valid: false,
    error: 'Cannot use built-in provider name',
  });
});

test('validateDisplayName: built-in provider name case-insensitive is invalid', () => {
  expect(validateDisplayName('OpenAI')).toEqual({
    valid: false,
    error: 'Cannot use built-in provider name',
  });
});

test('validateDisplayName: special characters are invalid', () => {
  expect(validateDisplayName('GPT@4')).toEqual({
    valid: false,
    error: 'Must start with letter, only letters/numbers/_/-/space allowed',
  });
});

test('validateDisplayName: too long name is invalid', () => {
  expect(validateDisplayName('ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567')).toEqual({
    valid: false,
    error: 'Must start with letter, only letters/numbers/_/-/space allowed',
  });
});
