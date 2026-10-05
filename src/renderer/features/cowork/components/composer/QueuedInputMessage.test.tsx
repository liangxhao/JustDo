// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import mermaid from 'mermaid';
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { IMAGE_PREVIEW_EVENT } from '@/features/cowork/components/preview/imageFilePreview';
import { i18nService } from '@/services/i18n';

vi.mock('mermaid', () => ({ default: {
  initialize: vi.fn(), parse: vi.fn(async () => true),
  render: vi.fn(async () => ({ svg: '<svg data-diagram></svg>' })),
} }));

import { QueuedInputMessage } from './QueuedInputMessage';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('preserves quote, annotation and recording cards together with native message rendering', () => {
  const message = {
    role: 'user', content: [
      { type: 'text', text: 'Please check this.\n\n> Quoted source text' },
      { type: 'browser_annotation', annotation: {
        id: 'annotation', title: 'Settings', displayUrl: 'example.com',
        markedRegionCount: 1, comment: 'Fix this action',
        element: { tag: 'button', name: 'Save changes', cssPath: '#save', rect: { x: 0, y: 0, width: 100, height: 30 } },
      } },
      { type: 'browser_recording', recording: {
        id: 'recording', sessionId: 'session', profile: 'embedded',
        title: 'Recorded steps', note: 'Reproduce this', startedAt: 1, images: [],
        steps: [{ id: 'step', action: 'click', pageId: 'tab', at: 0, url: 'https://example.com/', title: 'Example' }],
      } },
    ],
  };
  const { container, rerender, unmount } = render(<StrictMode><QueuedInputMessage message={message} /></StrictMode>);
  const shadow = container.querySelector('[data-queued-message]')!.shadowRoot!;
  expect(shadow.querySelector('blockquote')?.textContent).toContain('Quoted source text');
  expect(shadow.querySelector('.browser-annotation-message')).not.toBeNull();
  const recording = shadow.querySelector<HTMLDetailsElement>('details.recording-message')!;
  expect(recording).not.toBeNull();
  expect(recording.querySelectorAll('.recording-message-timeline > li')).toHaveLength(1);
  recording.open = true;
  rerender(<StrictMode><QueuedInputMessage message={{ ...message }} /></StrictMode>);
  expect(shadow.querySelector<HTMLDetailsElement>('details.recording-message')!.open).toBe(true);
  expect(shadow.querySelector('.chat-group')?.textContent).not.toContain('recording-data-length:');
  unmount();
  expect(shadow.childNodes).toHaveLength(0);
});

test('supports image previews, code reader actions and diagram source switching', async () => {
  const clipboard = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
  const preview = vi.fn();
  window.addEventListener(IMAGE_PREVIEW_EVENT, preview);
  try {
    const { container } = render(<QueuedInputMessage message={{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://example.com/screenshot.png' } },
      { type: 'text', text: '```js\nconst value = 1;\n```\n\n```mermaid\ngraph TD\nA-->B\n```' },
    ],
    }} />);
    const shadow = container.querySelector('[data-queued-message]')!.shadowRoot!;
    fireEvent.click(shadow.querySelector('img')!);
    expect(preview).toHaveBeenCalledTimes(1);
    expect((preview.mock.calls[0][0] as CustomEvent).detail.src).toBe('https://example.com/screenshot.png');
    const code = shadow.querySelector('.code-block-wrapper:not(.mermaid-block)')!;
    fireEvent.click(code.querySelector(`button[aria-label="${i18nService.t('copy')}"]`)!);
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('const value = 1;'));
    fireEvent.click(code.querySelector(`button[aria-label="${i18nService.t('messageWrap')}"]`)!);
    expect(code.classList.contains('is-wrapped')).toBe(true);
    await waitFor(() => expect(shadow.querySelector('.mermaid-preview svg')).not.toBeNull());
    fireEvent.click(shadow.querySelector('.mermaid-toggle')!);
    expect(shadow.querySelector<HTMLElement>('.mermaid-source')!.hidden).toBe(false);
  } finally {
    window.removeEventListener(IMAGE_PREVIEW_EVENT, preview);
    vi.unstubAllGlobals();
  }
});

test('does not repaint a closed detail when its diagram finishes rendering', async () => {
  let finish!: (result: { svg: string }) => void;
  vi.mocked(mermaid.render).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { container, unmount } = render(<QueuedInputMessage message={{
    role: 'user', content: '```mermaid\ngraph TD\nA-->B\n```',
  }} />);
  const shadow = container.querySelector('[data-queued-message]')!.shadowRoot!;
  const preview = shadow.querySelector<HTMLElement>('.mermaid-preview')!;
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  unmount();
  finish({ svg: '<svg data-late-result></svg>' });
  await Promise.resolve();
  await Promise.resolve();
  expect(preview.innerHTML).toBe('');
  expect(shadow.childNodes).toHaveLength(0);
});
