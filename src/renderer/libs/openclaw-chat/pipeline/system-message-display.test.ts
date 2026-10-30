import { isSessionDetailModelVisible } from '@shared/cowork/sessionDetails';
import { describe, expect, test } from 'vitest';

import { normalizeMessage } from './message-normalizer';
import { stripOpenClawLogHintText } from './system-message-display';

const hint =
  'For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.';
const continuingHint =
  'If it continues, open Settings → Logs in the Control UI or run `openclaw logs --follow`.';
const troubleshootingHint = 'Troubleshooting: run `openclaw logs --follow` in a terminal.';
const currentHints = [hint, hint.replace(' in your terminal', ''), continuingHint, troubleshootingHint];
const failure = "OpenClaw couldn't finish this reply.";

describe('system message display', () => {
  test.each([' ', '\n', '\r\n'])(
    'removes the current Gateway hint with separator %j',
    separator => {
      expect(stripOpenClawLogHintText(failure + separator + hint)).toBe(failure);
    },
  );

  test.each(currentHints)('removes current native hints and retains diagnostics: %s', logHint => {
    const detail = 'Provider finish_reason: content_filter';
    expect(stripOpenClawLogHintText(`${failure} ${logHint}\n${detail}`)).toBe(
      `${failure}\n${detail}`,
    );
    expect(stripOpenClawLogHintText(logHint)).toBe('');
    expect(normalizeMessage({ role: 'assistant', content: `${failure} ${logHint}` }).content).toEqual([
      { type: 'text', text: failure },
    ]);
    for (const role of ['user', 'toolResult']) {
      expect(normalizeMessage({ role, content: logHint }).content[0]).toMatchObject({
        type: 'text', text: logHint,
      });
    }
  });

  test.each([
    hint.replace(/`/g, ''),
    continuingHint.toUpperCase(),
    troubleshootingHint.replace('openclaw logs', 'openclaw  logs'),
  ])('recognizes display formatting variations: %s', logHint => {
    expect(stripOpenClawLogHintText(`${failure} ${logHint}`)).toBe(failure);
  });

  test.each([
    [hint, 'For details, open Settings'],
    [hint.replace(' in your terminal', ''), 'For details, open Settings'],
    [continuingHint, 'If it continues, open Settings'],
    [troubleshootingHint, 'Troubleshooting: run'],
  ])('hides matching streaming prefixes of %s', (logHint, prefix) => {
    for (let length = prefix.length; length <= logHint.length; length++) {
      expect(stripOpenClawLogHintText(`${failure} ${logHint.slice(0, length)}`, true)).toBe(failure);
    }
  });

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

  test.each([
    'For details, open Settings → Updates in the Control UI.',
    'If it continues, open Settings → Updates in the Control UI.',
    'Troubleshooting: run your application.',
    'Use `openclaw logs --follow` for debugging.',
    'openclaw logs --follow',
    'Log: openclaw logs --follow',
    'Logs: `openclaw  logs   --follow`',
    'Logs: openclaw',
    'To view logs, run `openclaw logs --follow` in a terminal.',
  ])('preserves ordinary instructions and obsolete hint text: %s', text => {
    expect(stripOpenClawLogHintText(text, true)).toBe(text);
    expect(normalizeMessage({ role: 'assistant', content: text }).content).toEqual([
      { type: 'text', text },
    ]);
  });

  test('releases incomplete hints once streaming ends', () => {
    expect(stripOpenClawLogHintText('For details, open Settings')).toBe('For details, open Settings');
    expect(stripOpenClawLogHintText('Troubleshooting: run')).toBe('Troubleshooting: run');
  });

  test('removes repeated hints while preserving following advice', () => {
    expect(
      stripOpenClawLogHintText(`${failure}\n${hint}\n${troubleshootingHint}\nRetry later.`),
    ).toBe(`${failure}\nRetry later.`);
  });

  test.each([
    'gateway-injected',
    'openclaw/gateway-injected',
    ' OpenClaw/Internal/Gateway-Injected ',
  ])('hides internal model %s in session details', model => {
    expect(isSessionDetailModelVisible(model)).toBe(false);
  });
});
