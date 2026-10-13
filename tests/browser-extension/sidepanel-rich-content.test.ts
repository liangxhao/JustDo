// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { composeBrowserGatewayPrompt } from '../../src/shared/browser/browser';
import {
  pendingInputLabel,
  renderRichContent,
  retryRichImages,
} from '../../resources/browser-extension/conversation-overlay/modules/sidepanel-rich-content.js';

const recording = {
  id: 'r',
  sessionId: 's',
  profile: 'embedded' as const,
  title: 'Search tutorial',
  note: 'Try another keyword',
  startedAt: 0,
  images: [],
  steps: [
    {
      id: 'step',
      action: 'click' as const,
      pageId: 'tab',
      at: 0,
      url: 'https://example.com',
      title: 'Example',
      target: {
        tag: 'button',
        name: 'Search',
        html: '<img src=x onerror=alert(1)>',
        selector: '#search',
      },
    },
  ],
};
const annotation = {
  title: 'Settings',
  displayUrl: 'example.com',
  comment: 'Make this clearer',
  markedRegionCount: 1,
  element: {
    tag: 'button',
    role: 'button',
    name: 'Save changes',
    cssPath: 'main > button',
    rect: { x: 10, y: 20, width: 100, height: 40 },
  },
};

function mount(rawMessage: unknown) {
  const host = document.createElement('div');
  const load = vi.fn(async () => 'data:image/png;base64,YWJj');
  renderRichContent(host, { role: 'user', text: '', rawMessage }, load);
  return { host, load };
}

describe('side panel desktop rich content', () => {
  it.each([
    ['zh-CN', '输入已接收，等待处理'],
    ['en-US', 'Input received, waiting for processing'],
  ])('shows a readable pending input status for %s', (language, expected) => {
    const locale = vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
    try {
      expect(pendingInputLabel('queued')).toBe(expected);
    } finally {
      locale.mockRestore();
    }
  });

  it('loads all six recording screenshots from canonical managed inbound media', async () => {
    const paths = Array.from({ length: 6 }, (_, i) => `media://inbound/shot-${i}.jpg`);
    const { host, load } = mount({
      role: 'user',
      content: composeBrowserGatewayPrompt('Learn this workflow', { recording }),
      __openclaw: { media: paths.map(url => ({ url, contentType: 'image/jpeg', kind: 'image' })) },
    });
    await vi.waitFor(() => expect(host.querySelectorAll('img[src]')).toHaveLength(6));
    expect(load.mock.calls.map(args => args[0])).toEqual(paths);
  });
  it('retries an image whose source resolved but failed to load in the browser', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const { host, load } = mount({ role: 'assistant', content: 'MEDIA: ./retry.png' });
      await vi.waitFor(() => expect(host.querySelector('img[src]')).not.toBeNull());
      host.querySelector('img')!.dispatchEvent(new Event('error'));
      clock.mockReturnValue(12_000);
      retryRichImages(host);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    } finally {
      clock.mockRestore();
    }
  });
  it('renders structured images and canonical media without losing image-only messages', async () => {
    const { host, load } = mount({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
      ],
      __openclaw: { media: [{ path: '截图.png', contentType: 'image/png' }] },
    });
    await vi.waitFor(() => expect(host.querySelectorAll('img[src]')).toHaveLength(2));
    expect(load).toHaveBeenCalledWith('截图.png');
    expect(host.querySelector('.chat-bubble__images')?.getAttribute('style')).toContain(
      '--image-columns: 2',
    );
  });
  it('loads local Markdown and MEDIA images through the scoped reader', async () => {
    const { host, load } = mount({
      role: 'assistant',
      content: '![shot](file:///C:/work/shot.png)\n\nMEDIA: ./other.png',
    });
    await vi.waitFor(() => expect(host.querySelectorAll('img[src]')).toHaveLength(2));
    expect(load).toHaveBeenCalledWith('file:///C:/work/shot.png');
    expect(load).toHaveBeenCalledWith('./other.png');
  });
  it('opens a keyboard-accessible image preview with zoom reset and close', async () => {
    // jsdom has no native dialog implementation; exercise the browser event wiring.
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, writable: true, value() {} },
      close: { configurable: true, writable: true, value() {} },
    });
    const show = vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.open = true;
    });
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.dispatchEvent(new Event('close'));
    });
    const { host } = mount({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
      ],
    });
    await vi.waitFor(() =>
      expect(host.querySelector('img')?.getAttribute('src')).toContain('data:image'),
    );
    host.querySelector('img')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    const dialog = document.querySelector('dialog')!;
    expect(show).toHaveBeenCalled();
    dialog.querySelector('img')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
    expect(dialog.querySelector('img')!.style.transform).toContain('scale(1.15)');
    (dialog.querySelector('.image-preview-reset') as HTMLButtonElement).click();
    expect(dialog.querySelector('img')!.style.transform).toContain('scale(1)');
    dialog.querySelector('button')!.click();
    expect(document.querySelector('dialog')).toBeNull();
    show.mockRestore();
    close.mockRestore();
  });

  it('renders native delivery media once after split content, using local sources', async () => {
    const delivery = { mediaUrls: ['./generated.png'] };
    const earlier = mount({
      role: 'assistant',
      content: 'Result\nMEDIA: ./generated.png',
      openclawDelivery: delivery,
      __browserExtensionOmitDeliveryMedia: true,
    });
    expect(earlier.host.textContent).toContain('Result');
    expect(earlier.host.querySelector('img')).toBeNull();
    const managed = mount({
      role: 'assistant',
      content: [
        {
          type: 'attachment',
          attachment: { kind: 'image', label: 'Generated', url: '/api/chat/media/outgoing/id' },
        },
      ],
      openclawDelivery: delivery,
      __browserExtensionOmitDeliveryMedia: true,
    });
    expect(managed.host.childElementCount).toBe(0);
    const last = mount({ role: 'assistant', content: [], openclawDelivery: delivery });
    await vi.waitFor(() => expect(last.host.querySelectorAll('img[src]')).toHaveLength(1));
    expect(last.load).toHaveBeenCalledExactlyOnceWith('./generated.png');
  });

  it('renders desktop recording prompt cards without exposing protocol text or page HTML', () => {
    const { host } = mount({
      role: 'user',
      content: composeBrowserGatewayPrompt('Follow this', [], recording),
    });
    expect(host.querySelector('.recording-message')).not.toBeNull();
    expect(host.textContent).toContain('Follow this');
    expect(host.textContent).toContain('Search tutorial');
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
  });
  it('renders the desktop annotation disclosure and escapes page-derived values', () => {
    const { host } = mount({ role: 'user', content: [{ type: 'browser_annotation', annotation }] });
    expect(host.querySelector('details.browser-annotation-message')).not.toBeNull();
    expect(host.textContent).toContain('Save changes');
    expect(host.textContent).toContain('Make this clearer');
    expect(host.textContent).toContain('main > button');
  });
  it('does not load unsafe image schemes and shows a readable failure', async () => {
    const { host, load } = mount({ role: 'assistant', content: '![bad](javascript:alert(1))' });
    expect(load).not.toHaveBeenCalled();
    expect(host.querySelector('img')).toBeNull();
  });
});
