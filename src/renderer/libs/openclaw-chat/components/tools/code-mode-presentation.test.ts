import { expect, test } from 'vitest';

import { getCodeModeSource } from './code-mode-presentation';

test('recognizes Code Mode without reinterpreting shell commands', () => {
  const input = { code: 'return await read({ path: "report.txt" });', title: 'Read report' };
  expect(getCodeModeSource('exec', input)).toBe(input.code);
  expect(getCodeModeSource('exec', { command: 'echo hello' })).toBeNull();
  expect(getCodeModeSource('custom', input)).toBeNull();
  expect(getCodeModeSource('exec', null)).toBeNull();
});
