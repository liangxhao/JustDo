import { describe, expect, test } from 'vitest';

import {
  getBrowserFilePreviewKind,
  getPreviewableFileExtension,
  PREVIEWABLE_FILE_EXTENSIONS,
} from './filePreview';

describe('getPreviewableFileExtension', () => {
  test.each(PREVIEWABLE_FILE_EXTENSIONS)(
    'recognizes the supported %s extension case-insensitively',
    extension => {
      expect(getPreviewableFileExtension(`C:\\output\\FILE${extension.toUpperCase()}`)).toBe(
        extension,
      );
    },
  );

  test.each([
    'report.pdf',
    'data.jsonl.bak',
    'markdown.text',
    'notes.txt#payload',
    'notes.md?draft',
  ])('rejects non-previewable path %s', filePath => {
    expect(getPreviewableFileExtension(filePath)).toBeNull();
  });

  test.each([
    ['C:\\workspace\\.gitignore', '.txt'],
    ['C:\\workspace\\.git-blame-ignore-revs', '.txt'],
    ['C:\\workspace\\.prettierrc', '.txt'],
    ['/workspace/LICENSE', '.txt'],
    ['/workspace/NOTICE', '.txt'],
    ['/workspace/AUTHORS', '.txt'],
    ['/workspace/CHANGELOG', '.txt'],
    ['/workspace/Procfile', '.txt'],
    ['/workspace/.env.local', '.txt'],
    ['/workspace/vite.config.mjs', '.mjs'],
    ['/workspace/electron-builder.config.cjs', '.cjs'],
    ['/workspace/tsconfig.jsonc', '.jsonc'],
  ])('recognizes common workspace file %s', (filePath, expectedExtension) => {
    expect(getPreviewableFileExtension(filePath)).toBe(expectedExtension);
  });
});

test.each([
  ['report.PDF', 'pdf'],
  ['sound.mp3', 'audio'],
  ['sound.opus', 'audio'],
  ['movie.webm', 'video'],
  ['movie.mkv', 'video'],
  ['movie.mov', 'video'],
  ['sound.mp3.exe', null],
  ['movie.mp4#payload', null],
  ['report.docx', null],
  ['legacy.ogv', null],
])('classifies browser preview path %s', (filePath, expected) => {
  expect(getBrowserFilePreviewKind(filePath)).toBe(expected);
});
