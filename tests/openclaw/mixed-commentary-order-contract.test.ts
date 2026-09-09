import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';

const patch = require('../../scripts/patches/v2026.9.2/018-mixed-tool-commentary-order.cjs');
const originalSource = patch.__testing.nativeSanitize
  .toString()
  .replace('function nativeSanitize(', 'function sanitizeChatHistoryMessages(');
const nativeContract = {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS: 8000,
  isToolHistoryBlockType: (type: unknown) => type === 'toolCall',
  isAssistantTextContentType: (type: unknown) => type === 'text',
  parseAssistantTextSignature: (block: { textSignature?: string }) =>
    block.textSignature ? JSON.parse(block.textSignature) : undefined,
  shouldDropAssistantHistoryMessage: () => false,
  projectAssistantCommentaryFallbacks: (message: any, maxChars: number) => {
    if (message.stopReason === 'error') return [];
    return message.content.flatMap((block: any) => {
      const signature = block.textSignature ? JSON.parse(block.textSignature) : null;
      return signature?.phase === 'commentary' && block.text.trim()
        ? [
            {
              role: 'assistant',
              content: [{ type: 'text', text: block.text.slice(0, maxChars) }],
              openclawStreamFallback: { itemId: signature.id },
              ...(block.text.length > maxChars
                ? { __openclaw: { truncated: true, reason: 'display-cap' } }
                : {}),
            },
          ]
        : [];
    });
  },
  sanitizeChatHistoryMessage: (message: any) => ({
    message: {
      ...message,
      content: message.content
        .filter((block: any) => !block.textSignature)
        .map((block: any) => (block.text === 'NO_REPLY' ? { type: 'text', text: '' } : block)),
    },
    changed: true,
  }),
};
function load() {
  const transformed = patch.__testing.transform(originalSource, 'fixture.js');
  return vm.runInNewContext(`${transformed}\nsanitizeChatHistoryMessages`, nativeContract) as (
    messages: unknown[],
    maxChars?: number,
    opts?: { includeCommentaryFallbacks: boolean },
  ) => any[];
}
const commentary = (text: string) => ({
  type: 'text',
  text,
  textSignature: JSON.stringify({ id: 'same', phase: 'commentary' }),
});
const message = () => ({
  role: 'assistant',
  __openclaw: { id: 'id', reason: 'original' },
  content: [
    { type: 'thinking', thinking: 'Before' },
    commentary('First'),
    { type: 'toolCall', id: 'one' },
    { type: 'thinking', thinking: 'After' },
    commentary('Second'),
    { type: 'toolCall', id: 'two' },
  ],
});

describe('portable mixed commentary ordering contract', () => {
  test.each([
    ['dot property', '.message;', '.message2;'],
    ['optional property', '?.truncated', '?.truncated2'],
    ['object key', 'reason:', 'reason2:'],
    ['shorthand key', 'content,', 'content2: content,'],
  ])('rejects a changed %s even when its spelling resembles a renamed local', (_name, before, after) => {
    const transformed = patch.__testing.transform(originalSource, 'fixture.js');
    const changed = transformed.replace(before, after);
    expect(changed).not.toBe(transformed);
    expect(() => patch.__testing.transform(changed, 'fixture.js')).toThrow(/historical or partial/);
  });
  test('accepts actual local binding renames while retaining shorthand property keys', () => {
    const transformed = patch.__testing.transform(originalSource, 'fixture.js');
    const renamed = transformed.replace(/\bsafe\b/gu, 'safe2');
    expect(renamed).not.toBe(transformed);
    expect(patch.__testing.transform(renamed, 'fixture.js')).toBe(renamed);
  });
  test('retains block order and identity when duplicate fallback IDs are paired by occurrence', () => {
    const sanitize = load();
    const result = sanitize([message()], 8000, { includeCommentaryFallbacks: true });
    expect(result).toHaveLength(1);
    expect(result[0].content.map((block: any) => block.type)).toEqual([
      'thinking',
      'text',
      'toolCall',
      'thinking',
      'text',
      'toolCall',
    ]);
    expect(
      result[0].content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text),
    ).toEqual(['First', 'Second']);
    expect(result[0].__openclaw.id).toBe('id');
    expect(sanitize(result)).toEqual(result);
  });
  test('uses native sanitized text and preserves an existing truncation reason', () => {
    const input = message();
    input.content[1] = commentary('NO_REPLY');
    const result = load()([input], 8, { includeCommentaryFallbacks: true });
    expect(result[0].content[1].text).toBe('');
    const truncated = load()([message()], 2, { includeCommentaryFallbacks: true });
    expect(truncated[0].__openclaw).toEqual({ id: 'id', truncated: true, reason: 'original' });
  });
  test('does not generate fallbacks for explicitly hidden messages', () => {
    const result = load()([{ ...message(), display: false }], 8000, {
      includeCommentaryFallbacks: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].display).toBe(false);
    expect(result[0].content.some((block: any) => block.type === 'text')).toBe(false);
  });
  test('leaves opt-out and error behavior with the native delegate', () => {
    const sanitize = load();
    expect(sanitize([message()])[0].content.some((block: any) => block.type === 'text')).toBe(
      false,
    );
    const result = sanitize([{ ...message(), stopReason: 'error' }], 8000, {
      includeCommentaryFallbacks: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].content.some((block: any) => block.type === 'text')).toBe(false);
  });
  test('rejects changed current markers and refuses partially applied runtime targets', () => {
    const transformed = patch.__testing.transform(originalSource, 'fixture.js');
    expect(() =>
      patch.__testing.transform(transformed.replace('cursor += 1', 'cursor += 2'), 'fixture.js'),
    ).toThrow(/historical or partial/);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-commentary-patch-contract-'));
    try {
      fs.mkdirSync(path.join(directory, 'dist'));
      const target = path.join(directory, 'dist', 'fixture.js');
      fs.writeFileSync(target, originalSource);
      expect(patch.applyPatch(directory)).toEqual([path.join('dist', 'fixture.js')]);
      expect(patch.verifyPatch(directory)).toEqual([]);
      expect(patch.applyPatch(directory)).toEqual([]);
      fs.writeFileSync(path.join(directory, 'gateway-bundle.mjs'), originalSource);
      expect(() => patch.applyPatch(directory)).toThrow(/partial/);
      expect(fs.readFileSync(target, 'utf8')).toBe(transformed);
    } finally {
      const resolved = path.resolve(directory);
      if (
        path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolved).startsWith('justdo-commentary-patch-contract-')
      )
        throw new Error('Unexpected test cleanup path');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
});
