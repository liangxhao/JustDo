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

  expect(screen.getByRole('heading', { name: '今日早报' })).toBeTruthy();
  expect(screen.getByText('上海天气').tagName).toBe('STRONG');
  expect(screen.getByText('第一条新闻').tagName).toBe('LI');
  expect(screen.getByText('内部来源')).toBeTruthy();
  expect(screen.getByText('graph TD; A-->B;').closest('[hidden]')).toBeNull();
  expect(
    view.container.querySelector('a, img, button, input, script, iframe, [onclick], [onerror]'),
  ).toBeNull();
  expect(view.container.textContent).not.toContain('mermaid (rendered)');
});

test('expands only overflowing summaries without opening the result card', () => {
  i18nService.setLanguage('zh', { persist: false });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(256);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(128);
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
  expect(onOpen).not.toHaveBeenCalled();
});
