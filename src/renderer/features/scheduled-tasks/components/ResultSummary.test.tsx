// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import ResultSummary from './ResultSummary';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('renders a static formatted summary without links, media or chat controls', () => {
  const view = render(
    <ResultSummary
      content={[
        '# 今日早报',
        '',
        '**上海天气**：晴',
        '',
        '- 第一条新闻',
        '- [内部来源](https://intranet.example/report)',
        '',
        '| 时段 | 情况 |',
        '| --- | --- |',
        '| 今天 | 小雨 |',
        '',
        '![天气图片](https://intranet.example/image.png)',
        '',
        '```mermaid',
        'graph TD; A-->B;',
        '```',
        '',
        '<script>alert(1)</script><img src=x onerror=alert(1)>',
      ].join('\n')}
    />,
  );

  expect(screen.queryByRole('heading', { name: '今日早报' })).toBeNull();
  expect(view.container.querySelector('strong, ul, table, pre')).toBeNull();
  expect(view.container.textContent).toContain('时段 情况 今天 小雨');
  fireEvent.click(
    screen.getByRole('button', { name: i18nService.t('scheduledTasksResultsExpandSummary') }),
  );
  expect(screen.getByRole('heading', { name: '今日早报' })).toBeTruthy();
  expect(screen.getByText('上海天气').tagName).toBe('STRONG');
  expect(screen.getByText('第一条新闻').tagName).toBe('LI');
  expect(screen.getByText('内部来源')).toBeTruthy();
  expect(screen.getByText('graph TD; A-->B;').closest('[hidden]')).toBeNull();
  expect(
    view.container.querySelector('a, img, input, script, iframe, [onclick], [onerror]'),
  ).toBeNull();
  expect(view.container.querySelectorAll('button')).toHaveLength(1);
  expect(view.container.textContent).not.toContain('mermaid (rendered)');
});

test('lets short formatted summaries expand without opening the result card', () => {
  i18nService.setLanguage('zh', { persist: false });
  const onOpen = vi.fn();
  render(
    <div onClick={onOpen}>
      <ResultSummary content={'**日报**\n\n详细内容'} />
    </div>,
  );

  const expand = screen.getByRole('button', { name: '展开摘要' });
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(expand);
  expect(screen.getByRole('button', { name: '收起摘要' }).getAttribute('aria-expanded')).toBe(
    'true',
  );
  expect(screen.getByText('日报').tagName).toBe('STRONG');
  fireEvent.click(screen.getByRole('button', { name: '收起摘要' }));
  expect(screen.getByText('日报 详细内容').tagName).toBe('P');
  expect(onOpen).not.toHaveBeenCalled();
});

test('bounds the plain preview without splitting emoji or shortening the expanded original', () => {
  const source = '😀'.repeat(241) + '\n\n最后一段';
  const view = render(<ResultSummary content={source} />);
  expect(view.container.querySelector('p')?.textContent).toBe('😀'.repeat(240) + '…');
  expect(screen.queryByText('最后一段')).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: i18nService.t('scheduledTasksResultsExpandSummary') }),
  );
  expect(screen.getByText('😀'.repeat(241))).toBeTruthy();
  expect(screen.getByText('最后一段')).toBeTruthy();
});
