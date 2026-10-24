import path from 'path';
import { expect, test } from 'vitest';

import { requireOpenClawCliExecutable } from './cliNodeRuntime';

test('requires the admitted executable and never falls back to the current process or PATH', () => {
  const executable = path.resolve('runtime with spaces/node.exe');
  expect(requireOpenClawCliExecutable({ JUSTDO_ELECTRON_PATH: executable })).toBe(executable);
  for (const value of [undefined, '', 'node', `${executable}\nother`]) {
    expect(() => requireOpenClawCliExecutable({ JUSTDO_ELECTRON_PATH: value })).toThrow();
  }
});
