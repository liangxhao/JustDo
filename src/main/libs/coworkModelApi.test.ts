import { describe, expect, test } from 'vitest';

import {
  buildOpenAIChatCompletionsUrl,
  extractApiErrorSnippet,
  extractTextFromOpenAIResponse,
} from './cowork/coworkModelApi';

describe('coworkModelApi', () => {
  test('builds openai chat completions url from base url', () => {
    expect(buildOpenAIChatCompletionsUrl('https://example.com/v1')).toBe(
      'https://example.com/v1/chat/completions',
    );
    expect(buildOpenAIChatCompletionsUrl('https://example.com')).toBe(
      'https://example.com/v1/chat/completions',
    );
    expect(buildOpenAIChatCompletionsUrl('https://example.com/v1/chat/completions')).toBe(
      'https://example.com/v1/chat/completions',
    );
  });

  test('extracts api error message snippets', () => {
    expect(extractApiErrorSnippet(JSON.stringify({ error: { message: 'bad key' } }))).toBe(
      'bad key',
    );
    expect(extractApiErrorSnippet('plain failure')).toBe('plain failure');
  });

  test('extracts openai text content', () => {
    expect(
      extractTextFromOpenAIResponse({
        choices: [{ message: { content: 'hello' } }],
      }),
    ).toBe('hello');
    expect(extractTextFromOpenAIResponse({ output_text: 'from responses' })).toBe(
      'from responses',
    );
  });
});
