import { describe, expect, test } from 'vitest';

import { getPreviewableFileExtension, PREVIEWABLE_FILE_EXTENSIONS } from './filePreview';

describe('getPreviewableFileExtension', () => {
  test.each(PREVIEWABLE_FILE_EXTENSIONS)(
    'recognizes the supported %s extension case-insensitively',
    extension => {
      expect(getPreviewableFileExtension(`C:\\output\\FILE${extension.toUpperCase()}`)).toBe(
        extension,
      );
    },
  );

  test.each(['report.pdf', 'data.jsonl', 'markdown.text', 'notes.txt#payload', 'notes.md?draft'])(
    'rejects non-previewable path %s',
    filePath => {
      expect(getPreviewableFileExtension(filePath)).toBeNull();
    },
  );
});
