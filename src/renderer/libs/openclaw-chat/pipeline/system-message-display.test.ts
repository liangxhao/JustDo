import { isSessionDetailModelVisible } from '@shared/cowork/sessionDetails';
import { describe, expect, test } from 'vitest';

import { normalizeMessage } from './message-normalizer';
import { stripOpenClawLogHintText } from './system-message-display';

const hint = 'To view logs, run `openclaw logs --follow` in a terminal.';
const failure =
  'Agent failed before reply: Inline API key for provider "zcode" is temporarily disabled after a provider auth/billing failure. Retry after about 10 minutes, or switch to a different auth profile/API key.';

describe('system message display', () => {
  test.each([' ', '\n', '\r\n'])(
    'removes the current Gateway hint with separator %j',
    separator => {
      expect(stripOpenClawLogHintText(failure + separator + hint)).toBe(failure);
    },
  );

  test.each([undefined, 'gateway-injected', 'openclaw/gateway-injected', 'provider/model'])(
    'cleans assistant content independently of model metadata %s',
    model => {
      expect(
        normalizeMessage({ role: 'assistant', model, content: failure + ' ' + hint }).content,
      ).toEqual([{ type: 'text', text: failure }]);
    },
  );

  test('preserves user and tool text', () => {
    for (const role of ['user', 'toolResult']) {
      expect(normalizeMessage({ role, content: hint }).content[0]).toMatchObject({
        type: 'text',
        text: hint,
      });
    }
  });

  test('hides streaming sentence prefixes before the command becomes visible', () => {
    for (let length = 'To view logs, run'.length; length <= hint.length; length++) {
      expect(stripOpenClawLogHintText(failure + ' ' + hint.slice(0, length), true)).toBe(failure);
    }
  });

  test.each(['', '`'])('hides bare streaming commands with Markdown prefix %j', markdown => {
    const command = 'openclaw logs --follow';
    for (let length = 'openclaw'.length; length <= command.length; length++) {
      expect(
        stripOpenClawLogHintText(`${failure}\n${markdown}${command.slice(0, length)}`, true),
      ).toBe(failure);
    }
    expect(stripOpenClawLogHintText('openclaw logs --filter', true)).toBe('openclaw logs --filter');
    expect(stripOpenClawLogHintText('openclaw logs --f')).toBe('openclaw logs --f');
  });

  test('preserves unrelated instructions and completed partial sentences', () => {
    const text = 'To view logs, run your application.';
    expect(stripOpenClawLogHintText(text, true)).toBe(text);
    expect(stripOpenClawLogHintText('To view logs, run')).toBe('To view logs, run');
    expect(stripOpenClawLogHintText('Use `openclaw logs --follow` for debugging.')).toBe(
      'Use `openclaw logs --follow` for debugging.',
    );
  });

  test('removes bare commands and repeated hints while preserving following advice', () => {
    expect(
      stripOpenClawLogHintText(`${failure}\nopenclaw logs --follow\n${hint}\nRetry later.`),
    ).toBe(`${failure}\nRetry later.`);
  });

  test('preserves legacy tolerance for whitespace inside Markdown commands', () => {
    expect(stripOpenClawLogHintText('Logs: ` openclaw  logs   --follow `')).toBe('');
  });

  test.each([
    'gateway-injected',
    'openclaw/gateway-injected',
    ' OpenClaw/Internal/Gateway-Injected ',
  ])('hides internal model %s in session details', model => {
    expect(isSessionDetailModelVisible(model)).toBe(false);
  });
});
