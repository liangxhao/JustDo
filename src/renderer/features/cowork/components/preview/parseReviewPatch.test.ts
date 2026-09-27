import { expect, test } from 'vitest';

import { parseReviewPatch, splitReviewLines } from './parseReviewPatch';

test('preserves hunk positions, header-looking content and no-newline markers', () => {
  const result = parseReviewPatch(
    '--- a/中文 文件.ts\n+++ b/中文 文件.ts\n@@ -12,2 +15,3 @@ function\n same\n---old\n+++new\n+tail\n\\ No newline at end of file',
  );
  expect(result.lines[1]).toEqual({ kind: 'context', text: 'same', oldLine: 12, newLine: 15 });
  expect(result.lines[2]).toEqual({ kind: 'deleted', text: '--old', oldLine: 13 });
  expect(result.lines[3]).toEqual({ kind: 'added', text: '++new', newLine: 16 });
  expect(splitReviewLines(result.lines)[2]).toMatchObject({
    left: { oldLine: 13 },
    right: { newLine: 16 },
  });
  expect(result.lines[result.lines.length - 1]?.kind).toBe('note');
});
test('bounds displayed rows without changing the canonical patch', () => {
  const patch = '@@ -0,0 +1,5000 @@\n' + '+abc\n'.repeat(5000);
  const parsed = parseReviewPatch(patch);
  expect(parsed.lines).toHaveLength(2000);
  expect(parsed.truncated).toBe(true);
  expect(patch).toContain('+abc\n'.repeat(5000));
});

test('marks only actual gaps as omitted unchanged lines', () => {
  const full = parseReviewPatch('@@ -1 +1 @@\n-old\n+new');
  const partial = parseReviewPatch('@@ -12 +12 @@\n-old\n+new');
  expect(full.lines[0].omitted).toBe(0);
  expect(partial.lines[0].omitted).toBe(11);
});

test('does not report truncation for a patch ending exactly at the render limit', () => {
  const patch = '@@ -0,0 +1,1999 @@\n' + '+abc\n'.repeat(1999);
  const parsed = parseReviewPatch(patch);
  expect(parsed.lines).toHaveLength(2000);
  expect(parsed.truncated).toBe(false);
  expect(parseReviewPatch(`${patch}+one more\n`).truncated).toBe(true);
});
