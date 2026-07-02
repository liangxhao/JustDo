import { describe, expect, test } from 'vitest';

import { splitMediaFromOutput } from './backend-helpers';

describe('splitMediaFromOutput', () => {
  test('extracts a delivered file whose path contains spaces', () => {
    const result = splitMediaFromOutput(
      '文件已经生成：\nMEDIA: E:\\workspace\\JustDo\\output files\\report.pdf',
    );

    expect(result.segments).toEqual([
      { type: 'text', text: '文件已经生成：' },
      { type: 'media', url: 'E:\\workspace\\JustDo\\output files\\report.pdf' },
    ]);
  });

  test('accepts whitespace and lowercase in the media prefix', () => {
    const result = splitMediaFromOutput('media : /tmp/final.csv');

    expect(result.mediaUrls).toEqual(['/tmp/final.csv']);
  });
});
