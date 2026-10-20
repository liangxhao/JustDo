// @vitest-environment jsdom

import type { BrowserPanelTab } from '@shared/browser/browser';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import HtmlFilePreview from './HtmlFilePreview';

const { panel, removeRetainedTabs } = vi.hoisted(() => ({
  panel: vi.fn(),
  removeRetainedTabs: vi.fn(),
}));
vi.mock('@/features/browser/BrowserPanel', () => ({
  default: (props: { initialTabs: BrowserPanelTab[]; isOpen: boolean }) => {
    panel(props);
    return (
      <div data-testid="native-html-browser" data-visible={props.isOpen}>
        {props.initialTabs[0].url}
      </div>
    );
  },
}));
vi.mock('@/features/browser/browserPanelRetention', () => ({
  removeRetainedBrowserPanelTabs: removeRetainedTabs,
}));

const createLocalHtmlPreview = vi.fn();
const nativeUrl = 'file:///E:/work/%E5%9C%B0%E7%90%83%20%23100%25.html';
beforeEach(() => {
  vi.clearAllMocks();
  i18nService.setLanguage('en', { persist: false });
  createLocalHtmlPreview.mockResolvedValue({
    success: true,
    url: nativeUrl,
    filePath: 'E:/work/地球 #100%.html',
    rootPath: 'E:/work',
    previewRootUrl: 'file:///E:/work/',
  });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { browser: { createLocalHtmlPreview } },
  });
});
afterEach(cleanup);

it('renders the original file in the existing isolated browser and keeps it mounted while hidden', async () => {
  const { rerender, unmount } = render(
    <HtmlFilePreview filePath="E:/work/地球 #100%.html" isVisible />,
  );
  const browser = await screen.findByTestId('native-html-browser');
  expect(createLocalHtmlPreview).toHaveBeenCalledWith('E:/work/地球 #100%.html');
  expect(panel.mock.lastCall?.[0]).toMatchObject({
    isOpen: true,
    embedded: true,
    pageToolsVisible: false,
    navigationBarVisible: true,
    initialTabs: [{ url: nativeUrl, sourceFilePath: 'E:/work/地球 #100%.html' }],
  });
  rerender(<HtmlFilePreview filePath="E:/work/地球 #100%.html" isVisible={false} />);
  expect(screen.getByTestId('native-html-browser')).toBe(browser);
  expect(browser.getAttribute('data-visible')).toBe('false');
  expect(createLocalHtmlPreview).toHaveBeenCalledTimes(1);
  unmount();
  expect(removeRetainedTabs).toHaveBeenCalledWith(panel.mock.lastCall?.[0].draftKey);
});

it('shows an error when native file preparation fails without loading an unchecked URL', async () => {
  createLocalHtmlPreview.mockResolvedValue({ success: false, errorCode: 'not_found' });
  render(<HtmlFilePreview filePath="E:/missing.html" isVisible />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(panel).not.toHaveBeenCalled();
});

it('ignores stale file preparation when a different document is selected', async () => {
  let finish!: (result: unknown) => void;
  createLocalHtmlPreview.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const { rerender } = render(<HtmlFilePreview filePath="E:/old.html" isVisible />);
  rerender(<HtmlFilePreview filePath="E:/new.html" isVisible />);
  await waitFor(() => expect(panel).toHaveBeenCalled());
  await act(async () => finish({ success: true, url: 'file:///E:/old.html' }));
  expect(screen.getByTestId('native-html-browser').textContent).toBe(nativeUrl);
});
