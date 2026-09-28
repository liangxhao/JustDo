import { expect, test } from 'vitest';

import { getCodeModeSource, getCodeModeTitle } from './code-mode-presentation';

test('recognizes Code Mode without reinterpreting shell commands', () => {
  const input = { code: 'return await read({ path: "report.txt" });', title: 'Read report' };
  expect(getCodeModeSource('exec', input)).toBe(input.code);
  expect(getCodeModeTitle('exec', input)).toBe('Read report');
  expect(getCodeModeSource('exec', { command: 'echo hello' })).toBeNull();
  expect(getCodeModeSource('custom', input)).toBeNull();
  expect(getCodeModeSource('exec', null)).toBeNull();
  expect(getCodeModeTitle('exec', { code: 'return 1', title: '  ' })).toBeNull();
});
