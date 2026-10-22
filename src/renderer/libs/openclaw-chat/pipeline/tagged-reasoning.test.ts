import { describe, expect, it } from 'vitest';

import { extractText, extractThinking } from './message-extract';
import { normalizeMessage } from './message-normalizer';
import { partitionTaggedReasoning } from './tagged-reasoning';

describe('legacy tagged reasoning display', () => {
  it.each([
    '<think>SECRET</think>Answer',
    '<THINK>SECRET</THINK>Answer',
    '<thinking>SECRET</thinking>Answer',
    '<antml:thinking>SECRET</antml:thinking>Answer',
    '<mm:think>SECRET</mm:think>Answer',
    '<think data-note="quoted > value">SECRET</think>Answer',
    '<think>SECRET<think>nested</think></think>Answer',
  ])('keeps tagged reasoning out of assistant text: %s', content => {
    const message = { role: 'assistant', content };
    expect(extractText(message)).toBe('Answer');
    expect(extractThinking(message)).toContain('SECRET');
    expect(normalizeMessage(message).content).toEqual([{ type: 'text', text: 'Answer' }]);
    expect(message.content).toBe(content);
  });

  it.each([
    'Use `<think>literal</think>` exactly.',
    'Use ``<thinking>literal</thinking>`` exactly.',
    '```xml\n<think>literal</think>\n```\nAnswer',
    '~~~xml\n<think>literal</think>\n~~~\nAnswer',
    '    <think>literal</think>\n',
    '> ```xml\n> <think>literal</think>\n> ```\n',
    '\\<think>literal\\</think>',
    '<span title="<think>literal</think>">Answer</span>',
    '![<think>image label</think>](image.png)',
    '![<think>image label</think>][ref]\n\n[ref]: image.png',
    '[ref]: https://fixture.invalid/<think>path</think>\n\nAnswer',
    '<pre>\n<think>literal</think>\n</pre>',
    '> <pre>\n> <think>literal</think>\n> </pre>',
    '- <pre>\n  <think>literal</think>\n  </pre>',
    'Prefix </think> suffix',
    'An ordinary <thinkingx>element</thinkingx>.',
  ])('preserves literal code and unrelated markup: %s', source => {
    expect(partitionTaggedReasoning(source)).toEqual({ text: source, thinking: '' });
  });

  it('never exposes an unfinished hidden tag across cumulative stream snapshots', () => {
    const source = 'Before <think>SECRET</think>Answer';
    for (let length = 1; length <= source.length; length++) {
      const result = partitionTaggedReasoning(source.slice(0, length));
      expect(result.text).not.toContain('SECRET');
      expect(result.text).not.toContain('<think>');
    }
    expect(partitionTaggedReasoning('<think>SECRET')).toEqual({ text: '', thinking: 'SECRET' });
    expect(partitionTaggedReasoning('Before <think note="unfinished')).toEqual({ text: 'Before ', thinking: '' });
    expect(partitionTaggedReasoning('`unclosed\n\n<think>SECRET</think>Answer').text)
      .toBe('`unclosed\n\nAnswer');
  });

  it.each([
    ['<think>The symbol ` is special.</think>Use `name`.', 'Use `name`.'],
    ['<think>```xml\nunfinished code\n</think>Answer', 'Answer'],
    ['<think>Hidden\n\n```xml\nunfinished code\n</think>Answer <think>more</think>end', 'Answer end'],
    ['# Unclosed `\n<think>SECRET</think>Answer\n`', '# Unclosed `\nAnswer\n`'],
    ['- First `\n- <think>SECRET</think>Answer\n  `', '- First `\n- Answer\n  `'],
    ['<think>\nSECRET\n</think>\nAnswer', '\nAnswer'],
    ['[ref]: image.png\n\n<think>Hidden\n\nthought</think>![<think>label</think>][ref]',
      '[ref]: image.png\n\n![<think>label</think>][ref]'],
    ['[<think>SECRET](url)</think>Answer <think>SECOND</think>Middle<think>THIRD</think>End',
      '[Answer MiddleEnd'],
  ])('keeps hidden Markdown from changing the visible body: %s', (source, text) => {
    expect(partitionTaggedReasoning(source).text).toBe(text);
  });

  it('keeps indented code literal through text extraction and normalization', () => {
    const content = '    <think>literal</think>\n';
    const message = { role: 'assistant', content };
    expect(extractThinking(message)).toBeNull();
    expect(extractText(message)).toBe(content.trim());
    expect(normalizeMessage(message).content).toEqual([{ type: 'text', text: content.trim() }]);
  });

  it('separates distinct legacy reasoning phases without changing visible text', () => {
    const content = '<think>First</think>Public<think>Second</think>End';
    expect(partitionTaggedReasoning(content)).toEqual({ text: 'PublicEnd', thinking: 'First\nSecond' });
    expect(extractThinking({ role: 'assistant', content })).toBe('First\nSecond');
  });

  it('partitions adjacent legacy text blocks consistently without mutating them', () => {
    const content = [{ type: 'text', text: '<think>SECRET' }, { type: 'text', text: 'MORE</think>Answer' }];
    const message = { role: 'assistant', content };
    expect(extractText(message)).toBe('Answer');
    expect(extractThinking(message)).toBe('SECRET\nMORE');
    expect(normalizeMessage(message).content).toEqual([{ type: 'text', text: 'Answer' }]);
    expect(content[0].text).toBe('<think>SECRET');
    expect(content[1].text).toBe('MORE</think>Answer');
  });

  it('does not turn hidden media or canvas shortcodes into displayed attachments', () => {
    const content = '<think>SECRET\nMEDIA:/private.png\n[embed url="https://fixture.invalid" /]</think>Answer';
    expect(normalizeMessage({ role: 'assistant', content }).content)
      .toEqual([{ type: 'text', text: 'Answer' }]);
    expect(normalizeMessage({ role: 'user', content }).content.some(item =>
      item.type === 'text' && item.text?.includes('SECRET'))).toBe(true);
  });
});
