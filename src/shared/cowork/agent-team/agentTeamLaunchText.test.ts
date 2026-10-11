import { describe, expect, it } from 'vitest';

import { normalizeAgentTeamLaunchText } from './agentTeamLaunchText';

describe('explicit Team native input fingerprint text', () => {
  it('binds canonically equivalent Unicode to the same native text', () => {
    expect(normalizeAgentTeamLaunchText('Discuss cafe\u0301')).toBe('Discuss café');
    expect(normalizeAgentTeamLaunchText('Discuss café')).toBe('Discuss café');
  });

  it('removes only native-disallowed controls and preserves internal tab, LF and CR', () => {
    const disallowed = [1, 8, 11, 12, 14, 31, 127]
      .map(value => String.fromCharCode(value))
      .join('');
    expect(normalizeAgentTeamLaunchText(`Start${disallowed}\tA\nB\rC\u200bEnd`)).toBe(
      'Start\tA\nB\rC\u200bEnd',
    );
  });

  it('rejects NUL before removing controls, retaining native admission failure', () => {
    expect(normalizeAgentTeamLaunchText('Start\u0000End')).toBeUndefined();
  });

  it('matches normal native ingress trimming after control removal', () => {
    expect(normalizeAgentTeamLaunchText('\u0001 \t\n request \r\n\u007f')).toBe('request');
  });
});
