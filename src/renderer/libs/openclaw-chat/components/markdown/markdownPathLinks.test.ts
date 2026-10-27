import { expect, test } from 'vitest';

import {
  findBareMessageFilePaths,
  matchAutoLinkPathPrefix,
  parseMessageFileCode,
  parseMessageFileDestination,
  parseMessageFileUrl,
} from '@/libs/openclaw-chat/components/markdown/markdownPathLinks';

test('does not treat URL authority and path as a local POSIX path', () => {
  expect(matchAutoLinkPathPrefix('//example.com/docs/start')).toBeNull();
});

test.each([
  ['某某文件：C:/Users/xxx/dddd/book.pdf', 'C:/Users/xxx/dddd/book.pdf'],
  ['某某文件：C:\\Users\\xxx\\dddd\\book.pdf', 'C:\\Users\\xxx\\dddd\\book.pdf'],
  ['文件：E:/项目/_output/报告.unknown，已完成', 'E:/项目/_output/报告.unknown'],
  ['(C:/output/report.pdf)', 'C:/output/report.pdf'],
  ['**C:/output/report.pdf**', 'C:/output/report.pdf'],
  ['file:///C:/output/My%20book.pdf', 'file:///C:/output/My%20book.pdf'],
])('recognizes an exact bare reference: %s', (source, target) => {
  const matches = findBareMessageFilePaths(source);
  expect(matches).toHaveLength(1);
  expect(matches[0].reference.target).toBe(target);
  expect(source.slice(matches[0].start, matches[0].end)).toBe(target);
});

test.each([
  'C:/output/My book.pdf',
  'C:/output/a.pdf backup.pdf',
  'C:/output/a.pdf 然后查看',
  'C:/output/a.pdf C:/other.pdf',
  'C:/output/a.pdf.',
  'C:/output/a.pdf:123',
  'C:/output/a%20b.pdf',
  'C:/output/a#1.pdf',
  'C:/output/a.pdf?draft',
  'C:/output/a.pdf#L123',
  'C:/output/报告.自定义',
  'C:/output/.env',
  'C:/output/LICENSE',
  '/tmp/report.pdf',
  'output/report.pdf',
  'C:report.pdf',
  '\\\\server\\share\\report.pdf',
  '\\\\?\\C:/report.pdf',
  '请打开C:/report.pdf',
  'data:C:/report.pdf',
  'https://example.com/C:/report.pdf',
  '“C:/report.pdf”',
  '“C:/report.pdf',
  '"C:/report.pdf"',
  '`C:/report.pdf`',
  '`C:/report.pdf',
  '[报告](C:/output/My book.pdf)',
  '[报告](C:/report.pdf',
  '<a href="#">file C:/report.pdf</a>',
  '$C:/report.pdf$',
])('does not salvage a bare prefix from a rejected source: %s', source => {
  expect(findBareMessageFilePaths(source)).toEqual([]);
});

test('does not admit a streamed end until its right boundary is known', () => {
  expect(findBareMessageFilePaths('C:/report.pdf', { sourceComplete: false })).toEqual([]);
  expect(findBareMessageFilePaths('C:/report.pdf\n', { sourceComplete: false })).toHaveLength(1);
  expect(findBareMessageFilePaths('C:/report.pdf，done', { sourceComplete: false })).toHaveLength(1);
});

test.each(['C:/output/My book.pdf', 'C:/a.pdf --open', 'src/main.ts', './report.pdf', '/etc/hosts'])
('keeps a non-whole or ambiguous code target as code: %s', value => {
  expect(parseMessageFileCode(value)).toBeNull();
});

test.each([
  'file://server/share/report.pdf',
  'file:////server/share/report.pdf',
  'file:///C:/a.pdf?download=1',
  'file:///C:/a.pdf#L123',
  'file:///C:/a%0ab.pdf',
  'file:///C:/a%zz.pdf',
  'file:///C:/My book.pdf',
  'file:///C:/dir%5cbook.pdf',
  'file:///C:/dir%2fbook.pdf',
  'file:///C:/a%C2%85b.pdf',
])('rejects an invalid or non-local file URL: %s', value => {
  expect(parseMessageFileUrl(value)).toBeNull();
});

test('keeps URI encoding and HTML navigation separate for Main', () => {
  expect(parseMessageFileUrl('file:///C:/a%2520b.pdf')).toEqual({
    sourceKind: 'file-url', target: 'file:///C:/a%2520b.pdf',
  });
  expect(parseMessageFileUrl('file:///C:/report.html#chart')).toEqual({
    sourceKind: 'file-url', target: 'file:///C:/report.html', navigationSuffix: '#chart',
  });
  expect(parseMessageFileDestination('./output/My%20book.pdf', '<./output/My book.pdf>')).toEqual({
    sourceKind: 'markdown-uri', target: './output/My%20book.pdf',
  });
  expect(parseMessageFileDestination('C:/work/a.pdf', '<C:\\work\\a.pdf>')).toBeNull();
  expect(parseMessageFileDestination('output/a.pdf', 'output/a.pdf')).toBeNull();
  expect(parseMessageFileDestination('./a%2Fb.pdf', './a%2Fb.pdf')).toBeNull();
  expect(parseMessageFileDestination('./a%25b.pdf', './a%b.pdf')).toBeNull();
  expect(findBareMessageFilePaths('file:///C:/a.pdf!backup.pdf')[0]?.reference.target).toBe(
    'file:///C:/a.pdf!backup.pdf',
  );
});

test('matches supported local file path prefixes', () => {
  expect(matchAutoLinkPathPrefix('/home/user/docs/readme.md')).toBe(
    '/home/user/docs/readme.md',
  );
  expect(matchAutoLinkPathPrefix('C:\\Users\\user\\readme.md')).toBe(
    'C:\\Users\\user\\readme.md',
  );
  expect(matchAutoLinkPathPrefix('file:///home/user/readme.md')).toBe(
    'file:///home/user/readme.md',
  );
});
