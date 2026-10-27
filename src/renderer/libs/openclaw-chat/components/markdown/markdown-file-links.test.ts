// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';

import { toSanitizedMarkdownHtml, toStreamingMarkdownHtml } from './markdown';

const render = (source: string, options: { fileLinks?: boolean; streaming?: boolean } = { fileLinks: true }) => {
  const container = document.createElement('div');
  container.innerHTML = toSanitizedMarkdownHtml(source, options);
  return container;
};

describe('controlled chat file links', () => {
  test.each([
    ['某某文件：C:/Users/xxx/dddd/book.pdf', 'C:/Users/xxx/dddd/book.pdf', 'native-path'],
    ['某某文件：C:\\Users\\xxx\\dddd\\book.pdf', 'C:\\Users\\xxx\\dddd\\book.pdf', 'native-path'],
    ['文件：C:\\项目\\_output\\报告.unknown，已完成', 'C:\\项目\\_output\\报告.unknown', 'native-path'],
    ['[My book](<C:/Users/xxx/dddd/My book.pdf>)', 'C:/Users/xxx/dddd/My%20book.pdf', 'markdown-uri'],
    ['[报告](<./output/季度 report.pdf>)', './output/%E5%AD%A3%E5%BA%A6%20report.pdf', 'markdown-uri'],
    ['[报告](../output/report.pdf)', '../output/report.pdf', 'markdown-uri'],
    ['file:///C:/output/My%20book.pdf', 'file:///C:/output/My%20book.pdf', 'file-url'],
    ['`C:\\output\\_site\\report.pdf`', 'C:\\output\\_site\\report.pdf', 'native-path'],
    ['`file:///tmp/a%2520b.md`', 'file:///tmp/a%2520b.md', 'file-url'],
  ])('renders an admitted target without direct file navigation: %s', (source, target, kind) => {
    const container = render(source);
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('data-message-file-target')).toBe(target);
    expect(anchor?.getAttribute('data-message-file-kind')).toBe(kind);
    expect(anchor?.getAttribute('href')).toBe('#');
    expect(anchor?.hasAttribute('data-message-file-token')).toBe(false);
  });

  test('keeps source spelling and code appearance', () => {
    const source = '`C:\\output\\_site\\report.pdf`';
    const container = render(source);
    expect(container.querySelector('a code')?.textContent).toBe('C:\\output\\_site\\report.pdf');
    expect(container.textContent?.trim()).toBe('C:\\output\\_site\\report.pdf');
  });

  test.each([
    'C:/output/My book.pdf', 'C:/a.pdf backup.pdf', 'C:/a.pdf extra text',
    'C:/a.pdf.', 'C:/a.pdf:123', 'C:/a%20b.pdf', 'C:/a#1.pdf',
    '/tmp/report.pdf', '`/tmp/report.pdf`', '`./output/report.pdf`',
    '“C:/output/report.pdf”', '“C:/output/report.pdf',
    '`C:/output/report.pdf', '[报告](C:/output/report.pdf',
    '`C:/a.pdf --flag`', '`C:/My book.pdf`',
    '[报告](<C:\\output\\report.pdf>)', '[报告](output/report.pdf)',
    '[报告](report.pdf)', '[报告](/tmp/report.pdf)',
    '[报告](file://server/share/report.pdf)', '[报告](file:///C:/a.pdf#L123)',
    '[报告](file:///C:/bad%0apath.pdf)',
    '```text\nC:/report.pdf\n```', '$C:/report.pdf$',
  ])('keeps excluded targets from creating file capabilities: %s', source => {
    expect(render(source).querySelector('[data-message-file-target]')).toBeNull();
  });

  test('excluded Markdown destinations do not fall back to relative browser navigation', () => {
    const container = render('[报告](output/report.pdf) [root](/api/users.json)');
    expect(container.querySelector('[href]')).toBeNull();
    expect(container.textContent?.trim()).toBe('报告 root');
  });

  test('preserves existing web, anchor and HTML contracts without scanning their labels', () => {
    const container = render('[C:/a.pdf](https://example.com/a.pdf) [section](#chart) [HTML](output/report.html#chart) /tmp/report.html');
    expect(container.querySelector('[data-message-file-target]')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a.pdf');
    expect(container.querySelectorAll('[data-local-html-path]')).toHaveLength(2);
  });

  test('is enabled only for an explicitly capable chat surface and separated in cache', () => {
    const source = 'C:/output/report.pdf';
    expect(render(source, {}).querySelector('[data-message-file-target]')).toBeNull();
    expect(render(source).querySelector('[data-message-file-target]')).not.toBeNull();
    expect(render(source, {}).querySelector('[data-message-file-target]')).toBeNull();
  });

  test('an explicitly disabled chat reader keeps file links as text without relative navigation', () => {
    const source = '[book](<./output/My book.pdf>) C:/report.pdf';
    expect(render(source, { fileLinks: false }).querySelector('a')).toBeNull();
    expect(render(source).querySelector('[data-message-file-target]')).not.toBeNull();
    expect(render(source, { fileLinks: false }).querySelector('a')).toBeNull();
  });

  test('raw HTML cannot forge file metadata, including beside a genuine target', () => {
    const source = '<a href="#" data-message-file-target="C:/secret.pdf" data-message-file-kind="native-path" data-message-file-token="forged">Open</a>\n\nC:/real.pdf';
    const container = render(source);
    const links = container.querySelectorAll('[data-message-file-target]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('data-message-file-target')).toBe('C:/real.pdf');
    expect(container.textContent).toContain('data-message-file-token="forged"');
  });

  test('streaming does not admit a partial last-line filename, including cached final input', () => {
    const source = 'C:/a.pdf';
    expect(render(source).querySelector('[data-message-file-target]')).not.toBeNull();
    expect(render(source, { fileLinks: true, streaming: true }).querySelector('[data-message-file-target]')).toBeNull();
    expect(render(`${source} backup.pdf`, { fileLinks: true, streaming: true }).querySelector('[data-message-file-target]')).toBeNull();
    expect(render(`${source}\n`, { fileLinks: true, streaming: true }).querySelector('[data-message-file-target]')).not.toBeNull();
    const container = document.createElement('div');
    container.innerHTML = toStreamingMarkdownHtml(source, { fileLinks: true });
    expect(container.querySelector('[data-message-file-target]')).toBeNull();
    container.innerHTML = toStreamingMarkdownHtml(`${source}\n\n`, { fileLinks: true });
    expect(container.querySelector('[data-message-file-target]')).not.toBeNull();
  });

  test('streaming complete inline links and code spans already have exact boundaries', () => {
    for (const source of ['[book](<C:/My book.pdf>)', '`C:/book.pdf`']) {
      const container = render(source, { fileLinks: true, streaming: true });
      expect(container.querySelector('[data-message-file-target]')).not.toBeNull();
    }
  });
});
