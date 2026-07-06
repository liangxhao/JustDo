import { describe, expect, test } from 'vitest';

import { getPreviewableFileExtension } from './filePreview';

describe('getPreviewableFileExtension', () => {
  test.each([
    ['notes.md', '.md'],
    ['README.MARKDOWN', '.markdown'],
    ['C:\\output\\result.json', '.json'],
    ['file:///tmp/notes.md?download=1', '.md'],
  ])('recognizes previewable path %s', (filePath, expected) => {
    expect(getPreviewableFileExtension(filePath)).toBe(expected);
  });

  test.each(['report.pdf', 'data.jsonl', 'markdown.txt'])(
    'rejects non-previewable path %s',
    filePath => {
      expect(getPreviewableFileExtension(filePath)).toBeNull();
    },
  );
});
