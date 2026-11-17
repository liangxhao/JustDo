// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebLaunchContext } from '../conversation-overlay/modules/web-launch-context.js';

let context: ReturnType<typeof createWebLaunchContext> | undefined;
afterEach(() => {
  context?.dispose();
  context = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mount() {
  const canOpen = vi.fn(() => true);
  const onEdit = vi.fn();
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal('navigator', { language: 'en', clipboard: { writeText } });
  const viewer = createWebLaunchContext({ document, canOpen, onEdit });
  context = viewer;
  document.body.append(viewer.trigger);
  const dialog = document.getElementById(
    viewer.trigger.getAttribute('aria-controls')!,
  ) as HTMLDialogElement;
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
  };
  const editor = dialog.querySelector('textarea')!;
  const preview = dialog.querySelector('.markdown-content')!;
  const copy = dialog.querySelector<HTMLButtonElement>('button[data-copy-label]')!;
  const status = dialog.querySelector('[role="status"]')!;
  const action = (label: string) =>
    dialog.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  return { viewer, dialog, editor, preview, copy, status, action, onEdit, canOpen, writeText };
}

describe('website context preview', () => {
  it('opens safe Markdown and copies its exact source without revising the draft', async () => {
    const { viewer, dialog, preview, copy, status, canOpen, onEdit, writeText } = mount();
    const raw =
      '# Order\r\n\r\n**Details**\r\n\r\n' +
      '[External](https://example.test/path) [Relative](/path) [Local](file:///secret)\r\n' +
      '![External image](https://example.test/image.png)\r\n<script>bad()</script>\r\n  ';
    viewer.value = raw;
    expect(viewer.trigger.hidden).toBe(true);
    viewer.setAvailable(true);
    canOpen.mockReturnValue(false);
    viewer.trigger.click();
    expect(dialog.open).toBe(false);
    canOpen.mockReturnValue(true);
    viewer.trigger.click();

    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(dialog.querySelector('h2'));
    const toolbar = dialog.querySelector('.web-launch-context-header')!;
    expect(
      Array.from(toolbar.querySelectorAll('button'), button => button.getAttribute('aria-label')),
    ).toEqual(['Copy', 'Edit', 'Close']);
    expect(toolbar.querySelectorAll('button > svg[aria-hidden="true"]')).toHaveLength(3);
    expect(preview.querySelector('h1')?.textContent).toBe('Order');
    expect(preview.querySelector('strong')?.textContent).toBe('Details');
    expect(Array.from(preview.querySelectorAll('a[href]'), a => a.getAttribute('href'))).toEqual([
      'https://example.test/path',
    ]);
    expect(preview.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(preview.querySelector('script')).toBeNull();
    copy.click();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(raw);
    await vi.waitFor(() => expect(status.textContent).toBe('Copied'));
    expect(viewer.value).toBe(raw);
    expect(onEdit).not.toHaveBeenCalled();

    writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    copy.click();
    await vi.waitFor(() => expect(status.textContent).toContain('Copy failed'));
  });

  it('keeps edited Markdown through preview, Escape, and reopening, while clearing stale clipboard feedback', async () => {
    const { viewer, dialog, editor, preview, copy, status, action, onEdit, writeText } = mount();
    viewer.value = 'Original **draft**';
    viewer.setAvailable(true);
    viewer.trigger.click();
    action('Edit').click();
    expect(document.activeElement).toBe(editor);
    editor.value = 'New *draft*';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    expect(viewer.value).toBe('New *draft*');
    expect(onEdit).toHaveBeenCalledOnce();
    action('Preview').click();
    expect(preview.querySelector('em')?.textContent).toBe('draft');

    let settleCopy!: () => void;
    writeText.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          settleCopy = resolve;
        }),
    );
    copy.click();
    expect(writeText).toHaveBeenCalledWith('New *draft*');
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(dialog.open).toBe(false);
    expect(viewer.value).toBe('New *draft*');
    settleCopy();
    await Promise.resolve();
    expect(status.textContent).toBe('');

    viewer.trigger.click();
    expect(dialog.open).toBe(true);
    expect(editor.hidden).toBe(true);
    expect(preview.textContent).toContain('New draft');
    viewer.setAvailable(false);
    expect(dialog.open).toBe(false);
    expect(viewer.trigger.hidden).toBe(true);
    viewer.dispose();
    expect(dialog.isConnected).toBe(false);
  });
});
