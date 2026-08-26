import { describe, expect, test } from 'vitest';

import { splitMediaFromOutput } from '@/libs/openclaw-chat/shims/backend-helpers';

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

  test('extracts Markdown list deliveries and preserves the text after them', () => {
    const result = splitMediaFromOutput(
      '## 生成文件\n\n- MEDIA:C:\\project\\first.py\n- MEDIA:C:\\project\\second.py\n\n## 过程备注\n\n- 全部验证通过。',
    );

    expect(result.segments).toEqual([
      { type: 'text', text: '## 生成文件' },
      { type: 'media', url: 'C:\\project\\first.py', listMarker: '-' },
      { type: 'media', url: 'C:\\project\\second.py', listMarker: '-' },
      { type: 'text', text: '## 过程备注\n\n- 全部验证通过。' },
    ]);
  });

  test('extracts numbered Markdown list deliveries', () => {
    const result = splitMediaFromOutput(
      '1. MEDIA:C:\\project\\first.py\n2. MEDIA:C:\\project\\second.py',
    );

    expect(result.mediaUrls).toEqual([
      'C:\\project\\first.py',
      'C:\\project\\second.py',
    ]);
    expect(result.segments).toEqual([
      { type: 'media', url: 'C:\\project\\first.py', listMarker: '1.' },
      { type: 'media', url: 'C:\\project\\second.py', listMarker: '2.' },
    ]);
  });
});
