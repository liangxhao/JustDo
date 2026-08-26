import { describe, expect, test } from 'vitest';

import { resolveEditDiffLanguage } from './edit-diff-monaco';

describe('edit Diff Monaco integration', () => {
  test.each([
    ['C:\\workspace\\src\\app.ts', 'typescript'],
    ['/workspace/main.py', 'python'],
    ['/workspace/README.md', 'markdown'],
    ['/workspace/Dockerfile', 'plaintext'],
    [null, 'plaintext'],
  ])('resolves the Monaco language for %s', (path, expected) => {
    expect(resolveEditDiffLanguage(path)).toBe(expected);
  });
});
