import { describe, expect, test } from 'vitest';

import { resolveWriteCodeLanguage } from './file-code-language';

describe('Write code language', () => {
  test.each([
    ['C:\\workspace\\vite.config.MTS', 'typescript'],
    ['typed.config.cts', 'typescript'],
    ['node.config.mjs', 'javascript'],
    ['node.config.cjs', 'javascript'],
    ['/workspace/deploy/Dockerfile', 'dockerfile'],
    ['Makefile', 'plaintext'],
    ['CMakeLists.txt', 'plaintext'],
    ['settings.toml', 'plaintext'],
    ['settings.jsonc', 'json'],
  ])('recognizes written source and structured configuration for %s', (path, language) => {
    expect(resolveWriteCodeLanguage(path)).toBe(language);
  });

  test.each(['docs/notes.md', 'notes.txt', 'debug.log', 'README', 'unknown.format', null])(
    'keeps the text bubble for %s',
    path => {
      expect(resolveWriteCodeLanguage(path)).toBeUndefined();
    },
  );
});
