// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

import DisplayPanelLauncher from './DisplayPanelLauncher';

const listHistory = vi.fn();
const deleteHistory = vi.fn();
const loadHistoryFavicon = vi.fn();
const faviconDataUrl = 'data:image/png;base64,aWNvbg==';
beforeEach(() => {
  i18nService.setLanguage('en', { persist: false });
  listHistory.mockResolvedValue({ success: true, entries: [] });
  deleteHistory.mockResolvedValue({ success: true });
  loadHistoryFavicon.mockResolvedValue({ success: true, dataUrl: faviconDataUrl });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { browser: { listHistory, deleteHistory, loadHistoryFavicon } },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  listHistory.mockReset();
  deleteHistory.mockReset();
  loadHistoryFavicon.mockReset();
});

describe('DisplayPanelLauncher', () => {
  it('shows an active loading status without a launch button, then preserves retry and real entry actions', () => {
    const select = vi.fn();
    const retry = vi.fn();
    const props = { onCreateBrowser: vi.fn(), onCreateTerminal: vi.fn() };
    const label = 'Reading the verified App catalog';
    const { container, rerender } = render(<DisplayPanelLauncher {...props} appItems={[
      { id: 'pending-catalog', label, icon: <span />, loading: true, disabled: true, onSelect: select },
    ]} />);
    const region = screen.getByRole('region', { name: 'Apps' });
    const status = within(region).getByRole('status');
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toBe(label);
    expect(within(region).queryByRole('button')).toBeNull();
    expect(status.querySelector('.display-launcher__app-loading-spinner')).toBeTruthy();
    expect(status.querySelector('[aria-hidden="true"].display-launcher__app-skeletons')).toBeTruthy();
    fireEvent.click(status);
    expect(select).not.toHaveBeenCalled();

    rerender(<DisplayPanelLauncher {...props} appItems={[
      { id: 'retry-catalog', label: 'Reload app list', description: 'The app list could not be read.', error: true, icon: <span />, onSelect: retry },
    ]} />);
    expect(within(region).queryByRole('status')).toBeNull();
    expect(region.hasAttribute('aria-busy')).toBe(false);
    expect(within(region).getByRole('alert').textContent).toBe('The app list could not be read.');
    expect(container.querySelector('.display-launcher__app-error')).toBeTruthy();
    expect(container.querySelector('.display-launcher__app-loading-spinner')).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Reload app list' }));
    expect(retry).toHaveBeenCalledOnce();

    rerender(<DisplayPanelLauncher {...props} appItems={[
      { id: 'pending-catalog', label, icon: <span />, loading: true, disabled: true, onSelect: select },
    ]} />);
    expect(within(region).queryByRole('alert')).toBeNull();
    expect(within(region).queryByRole('button')).toBeNull();
    expect(within(region).getByRole('status').textContent).toBe(label);
    expect(container.querySelector('.display-launcher__app-error')).toBeNull();

    rerender(<DisplayPanelLauncher {...props} appItems={[
      { id: 'plugin-entry', label: 'Editor', icon: <span data-testid="verified-plugin-icon" />, onSelect: select },
    ]} />);
    expect(container.querySelector('.display-launcher__app-loading')).toBeNull();
    expect(within(region).getByTestId('verified-plugin-icon')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Editor' }));
    expect(select).toHaveBeenCalledOnce();
  });

  it.each(['apps', 'item'] as const)('keeps the app failure readable while %s authority disables retry', owner => {
    const retry = vi.fn();
    const item = {
      id: 'failed-catalog', label: 'Reload app list', description: 'The app list could not be read.',
      error: true, icon: <span />, disabled: owner === 'item', onSelect: retry,
    };
    const { rerender } = render(<DisplayPanelLauncher
      onCreateBrowser={vi.fn()} onCreateTerminal={vi.fn()} appsDisabled={owner === 'apps'} appItems={[item]}
    />);
    const apps = within(screen.getByRole('region', { name: 'Apps' }));
    expect(apps.getByRole('alert').textContent).toBe(item.description);
    const button = apps.getByRole('button', { name: item.label }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(retry).not.toHaveBeenCalled();

    rerender(<DisplayPanelLauncher onCreateBrowser={vi.fn()} onCreateTerminal={vi.fn()} appItems={[
      { ...item, disabled: false },
    ]} />);
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledOnce();
    expect(apps.queryByRole('status')).toBeNull();
  });

  it('keeps the dedicated spinner and skeleton animations active with reduced motion', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'DisplayPanelLauncher.css'), 'utf8');
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/u)?.[1];
    expect(reduced).toContain('.display-launcher__app-loading-spinner');
    expect(reduced).toContain('animation: app-list-spinner 1s linear infinite');
    expect(reduced).toContain('.display-launcher__app-skeleton::after');
    expect(reduced).toContain('animation: app-list-shimmer 1.5s ease-in-out infinite');
    expect(reduced).not.toMatch(/animation:\s*none/u);
  });

  it('shows Apps between tools and recent visits, preserving actions, icons and availability', () => {
    const launch = vi.fn();
    const items = [
      { id: 'editor', label: 'Editor', icon: <span data-testid="plugin-icon" />, onSelect: launch },
      { id: 'blocked', label: 'Blocked App', icon: <span />, disabled: true, onSelect: vi.fn() },
    ];
    const { container, rerender } = render(
      <DisplayPanelLauncher
        appItems={items}
        onCreateBrowser={vi.fn()}
        onCreateTerminal={vi.fn()}
      />,
    );
    expect(
      [...container.querySelectorAll('section')].map(section => section.getAttribute('aria-label')),
    ).toEqual(['Tools', 'Apps', 'Recently visited']);
    const apps = within(screen.getByRole('region', { name: 'Apps' }));
    expect(apps.getByTestId('plugin-icon')).toBeTruthy();
    fireEvent.click(apps.getByRole('button', { name: 'Editor' }));
    expect(launch).toHaveBeenCalledOnce();
    expect((apps.getByRole('button', { name: 'Blocked App' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rerender(
      <DisplayPanelLauncher
        appItems={items}
        appsDisabled
        onCreateBrowser={vi.fn()}
        onCreateTerminal={vi.fn()}
      />,
    );
    fireEvent.click(apps.getByRole('button', { name: 'Editor' }));
    expect(launch).toHaveBeenCalledOnce();
    rerender(
      <DisplayPanelLauncher appItems={[]} onCreateBrowser={vi.fn()} onCreateTerminal={vi.fn()} />,
    );
    expect(screen.queryByRole('region', { name: 'Apps' })).toBeNull();
  });

  it('launches each available tool from the tools section', async () => {
    i18nService.setLanguage('en', { persist: false });
    const createBrowser = vi.fn();
    const createTerminal = vi.fn();
    const openFiles = vi.fn();
    const openReview = vi.fn();
    const createSideChat = vi.fn();

    render(
      <DisplayPanelLauncher
        onCreateBrowser={createBrowser}
        onCreateTerminal={createTerminal}
        onOpenFiles={openFiles}
        onOpenReview={openReview}
        onCreateSideChat={createSideChat}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.queryByRole('button', { name: 'Browser' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Browser address' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByRole('button', { name: 'Review' }).textContent).toContain('Ctrl+Shift+G');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Side chat' }));
    expect(createBrowser).not.toHaveBeenCalled();
    expect(createTerminal).toHaveBeenCalledTimes(1);
    expect(openFiles).toHaveBeenCalledTimes(1);
    expect(openReview).toHaveBeenCalledTimes(1);
    expect(createSideChat).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(
        'Pages you visit will appear here so you can pick up where you left off.',
      ),
    ).toBeTruthy();
  });

  it('disables unavailable launch targets', () => {
    i18nService.setLanguage('en', { persist: false });

    render(
      <DisplayPanelLauncher
        browserDisabled
        filesDisabled
        terminalDisabled
        onCreateBrowser={vi.fn()}
        onCreateTerminal={vi.fn()}
        onOpenFiles={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Browser address' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Terminal' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Files' }).hasAttribute('disabled')).toBe(true);
  });

  it('hides workspace files when no workspace is configured', () => {
    i18nService.setLanguage('en', { persist: false });

    render(<DisplayPanelLauncher onCreateBrowser={vi.fn()} onCreateTerminal={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull();
  });

  it('opens a recent page in the application browser', async () => {
    listHistory.mockResolvedValue({
      success: true,
      entries: [
        { url: 'https://example.com/docs', title: 'Project docs', lastVisitAt: 1, visitCount: 1 },
      ],
    });
    const createBrowser = vi.fn();
    render(<DisplayPanelLauncher onCreateBrowser={createBrowser} onCreateTerminal={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Project docs' }));
    expect(createBrowser).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('shows a PDF icon and reopens the actual local file without requesting a network icon', async () => {
    const url = 'file:///C:/reports/%E6%8A%A5%E5%91%8A%20final.PDF?mode=read#page=2';
    listHistory.mockResolvedValue({
      success: true,
      entries: [{ url, title: 'Quarterly report', lastVisitAt: 1, visitCount: 1 }],
    });
    const createBrowser = vi.fn();
    render(<DisplayPanelLauncher onCreateBrowser={createBrowser} onCreateTerminal={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Quarterly report' });
    expect(button.title).toBe('Quarterly report\nC:\\reports\\报告 final.PDF');
    expect(button.querySelector('svg text')?.textContent).toBe('PDF');
    fireEvent.click(button);
    expect(createBrowser).toHaveBeenCalledWith(url);
    expect(loadHistoryFavicon).not.toHaveBeenCalled();
  });

  it('distinguishes loopback sites and served PDFs when there is no site icon', async () => {
    const siteUrl = 'http://[::1]:5173/';
    const pdfUrl = 'http://127.0.0.1:5173/files/report.pdf#page=2';
    listHistory.mockResolvedValue({
      success: true,
      entries: [
        { url: siteUrl, title: 'Local site', lastVisitAt: 3, visitCount: 1 },
        { url: pdfUrl, title: 'Served report', lastVisitAt: 2, visitCount: 1 },
        { url: 'https://example.com/', title: 'Public site', lastVisitAt: 1, visitCount: 1 },
      ],
    });
    loadHistoryFavicon.mockResolvedValue({ success: false });
    render(<DisplayPanelLauncher onCreateBrowser={vi.fn()} onCreateTerminal={vi.fn()} />);
    const site = await screen.findByRole('button', { name: 'Local site' });
    const pdf = screen.getByRole('button', { name: 'Served report' });
    const web = screen.getByRole('button', { name: 'Public site' });

    expect(site.querySelector('.display-launcher__local-site-icon')).toBeTruthy();
    expect(web.querySelector('.display-launcher__local-site-icon')).toBeNull();
    expect(web.querySelector('svg')).toBeTruthy();
    expect(pdf.querySelector('svg text')?.textContent).toBe('PDF');
    expect(loadHistoryFavicon).toHaveBeenCalledWith(siteUrl, false);
  });

  it('deletes a recent page from history, fills its place, and keeps it removed on reopening', async () => {
    let entries = [9, 8, 7, 6, 5, 4, 3, 2, 1].map(lastVisitAt => ({
      url: `https://example.com/${lastVisitAt}`,
      title: `Page ${lastVisitAt}`,
      lastVisitAt,
      visitCount: 1,
    }));
    listHistory.mockImplementation(async () => ({ success: true, entries }));
    deleteHistory.mockImplementation(async (urls: string[]) => {
      entries = entries.filter(entry => !urls.includes(entry.url));
      return { success: true };
    });
    const props = { onCreateBrowser: vi.fn(), onCreateTerminal: vi.fn() };
    const view = render(<DisplayPanelLauncher {...props} />);
    const deleteButton = await screen.findByRole('button', { name: 'Delete visit to Page 9' });
    expect(screen.queryByRole('button', { name: 'Page 1' })).toBeNull();
    fireEvent.click(deleteButton);

    expect(deleteHistory).toHaveBeenCalledWith(['https://example.com/9']);
    expect(await screen.findByRole('button', { name: 'Page 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Page 9' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Delete visit to / })).toHaveLength(8);
    expect(props.onCreateBrowser).not.toHaveBeenCalled();

    view.rerender(<DisplayPanelLauncher {...props} visible={false} />);
    view.rerender(<DisplayPanelLauncher {...props} visible />);
    expect(await screen.findByRole('button', { name: 'Page 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Page 9' })).toBeNull();
  });

  it.each(['declined', 'rejected'])(
    'retains visits and allows retry when deletion is %s',
    async failure => {
      listHistory.mockResolvedValue({
        success: true,
        entries: [{ url: 'https://example.com/', title: 'Example', lastVisitAt: 1, visitCount: 1 }],
      });
      if (failure === 'declined') deleteHistory.mockResolvedValueOnce({ success: false });
      else deleteHistory.mockRejectedValueOnce(new Error('unavailable'));
      const createBrowser = vi.fn();
      render(<DisplayPanelLauncher onCreateBrowser={createBrowser} onCreateTerminal={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Delete visit to Example' }));

      expect((await screen.findByRole('alert')).textContent).toBe(
        i18nService.t('browserHistoryDeleteFailed'),
      );
      expect(listHistory).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Example' }));
      expect(createBrowser).toHaveBeenCalledWith('https://example.com/');

      listHistory.mockResolvedValue({ success: true, entries: [] });
      fireEvent.click(screen.getByRole('button', { name: 'Delete visit to Example' }));
      expect(
        await screen.findByText(i18nService.t('coworkLauncherRecentVisitsEmpty')),
      ).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(deleteHistory).toHaveBeenCalledTimes(2);
    },
  );

  it('prevents repeated deletion while pending, including when navigation is unavailable', async () => {
    listHistory.mockResolvedValue({
      success: true,
      entries: [{ url: 'https://example.com/', title: 'Example', lastVisitAt: 1, visitCount: 1 }],
    });
    let resolve!: (value: { success: boolean }) => void;
    deleteHistory.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const createBrowser = vi.fn();
    render(
      <DisplayPanelLauncher
        browserDisabled
        onCreateBrowser={createBrowser}
        onCreateTerminal={vi.fn()}
      />,
    );
    const remove = await screen.findByRole('button', { name: 'Delete visit to Example' });
    expect(remove.hasAttribute('disabled')).toBe(false);
    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(remove.hasAttribute('disabled')).toBe(true);
    expect(deleteHistory).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Example' })).toBeTruthy();
    expect(createBrowser).not.toHaveBeenCalled();

    listHistory.mockResolvedValue({ success: true, entries: [] });
    await act(async () => resolve({ success: true }));
    expect(screen.getByText(i18nService.t('coworkLauncherRecentVisitsEmpty'))).toBeTruthy();
  });

  it('refreshes the reopened launcher when an earlier deletion completes', async () => {
    listHistory.mockResolvedValue({
      success: true,
      entries: [{ url: 'https://example.com/', title: 'Example', lastVisitAt: 1, visitCount: 1 }],
    });
    let resolve!: (value: { success: boolean }) => void;
    deleteHistory.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const props = { onCreateBrowser: vi.fn(), onCreateTerminal: vi.fn() };
    const view = render(<DisplayPanelLauncher {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete visit to Example' }));
    view.rerender(<DisplayPanelLauncher {...props} visible={false} />);
    view.rerender(<DisplayPanelLauncher {...props} visible />);
    expect(await screen.findByRole('button', { name: 'Example' })).toBeTruthy();

    listHistory.mockResolvedValue({ success: true, entries: [] });
    await act(async () => resolve({ success: true }));
    expect(screen.queryByRole('button', { name: 'Example' })).toBeNull();
    expect(listHistory).toHaveBeenCalledTimes(3);
  });

  it('ignores an older history read after reopening and deleting a visit', async () => {
    const entries = [
      { url: 'https://example.com/', title: 'Example', lastVisitAt: 1, visitCount: 1 },
    ];
    let resolve!: (value: { success: boolean; entries: typeof entries }) => void;
    listHistory.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    listHistory.mockResolvedValue({ success: true, entries });
    const props = { onCreateBrowser: vi.fn(), onCreateTerminal: vi.fn() };
    const view = render(<DisplayPanelLauncher {...props} />);
    view.rerender(<DisplayPanelLauncher {...props} visible={false} />);
    view.rerender(<DisplayPanelLauncher {...props} visible />);
    const remove = await screen.findByRole('button', { name: 'Delete visit to Example' });
    listHistory.mockResolvedValue({ success: true, entries: [] });
    fireEvent.click(remove);
    expect(await screen.findByText(i18nService.t('coworkLauncherRecentVisitsEmpty'))).toBeTruthy();

    await act(async () => resolve({ success: true, entries }));
    expect(screen.queryByRole('button', { name: 'Example' })).toBeNull();
  });

  it.each(['https://example.com/docs', 'http://localhost:5173/docs'])(
    'shows the stored inline website icon without another renderer network request for %s',
    async url => {
      listHistory.mockResolvedValue({
        success: true,
        entries: [
          {
            url,
            title: 'Docs',
            lastVisitAt: 1,
            visitCount: 1,
            faviconUrl: 'https://cdn.example.com/site.svg',
          },
        ],
      });
      render(<DisplayPanelLauncher onCreateBrowser={vi.fn()} onCreateTerminal={vi.fn()} />);
      const button = await screen.findByRole('button', { name: 'Docs' });
      await waitFor(() =>
        expect(button.querySelector('img')?.getAttribute('src')).toBe(faviconDataUrl),
      );
      const icon = button.querySelector('img');
      expect(icon?.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(loadHistoryFavicon).toHaveBeenCalledWith(url, false);
      const fallback = button.querySelector('.display-launcher__local-site-icon, svg');
      expect(fallback).toBeTruthy();
      fireEvent.load(icon!);
      expect(fallback?.isConnected).toBe(false);
    },
  );

  it('tries the site favicon then a globe when images fail, while keeping navigation usable', async () => {
    listHistory.mockResolvedValue({
      success: true,
      entries: [
        {
          url: 'https://example.com/docs',
          title: 'Docs',
          lastVisitAt: 1,
          visitCount: 1,
          faviconUrl: 'https://cdn.example.com/site.svg',
        },
      ],
    });
    const createBrowser = vi.fn();
    render(<DisplayPanelLauncher onCreateBrowser={createBrowser} onCreateTerminal={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Docs' });
    await waitFor(() => expect(button.querySelector('img')).toBeTruthy());
    loadHistoryFavicon.mockResolvedValueOnce({
      success: true,
      dataUrl: 'data:image/png;base64,bmV3',
    });
    fireEvent.error(button.querySelector('img')!);
    await waitFor(() =>
      expect(button.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,bmV3'),
    );
    expect(loadHistoryFavicon).toHaveBeenLastCalledWith('https://example.com/docs', true);
    fireEvent.error(button.querySelector('img')!);
    expect(button.querySelector('img')).toBeNull();
    expect(button.querySelector('svg')).toBeTruthy();
    fireEvent.click(button);
    expect(createBrowser).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('loads the favicon from the website for older history records', async () => {
    listHistory.mockResolvedValue({
      success: true,
      entries: [{ url: 'https://example.com/docs', title: 'Docs', lastVisitAt: 1, visitCount: 1 }],
    });
    render(<DisplayPanelLauncher onCreateBrowser={vi.fn()} onCreateTerminal={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Docs' });
    await waitFor(() =>
      expect(button.querySelector('img')?.getAttribute('src')).toBe(faviconDataUrl),
    );
    expect(loadHistoryFavicon).toHaveBeenCalledWith('https://example.com/docs', false);
  });

  it('keeps a visible globe while a request is pending or fails', async () => {
    listHistory.mockResolvedValue({
      success: true,
      entries: [{ url: 'https://example.com/', title: 'Example', lastVisitAt: 1, visitCount: 1 }],
    });
    let reject!: (reason: Error) => void;
    loadHistoryFavicon.mockImplementationOnce(
      () =>
        new Promise((_resolve, done) => {
          reject = done;
        }),
    );
    render(<DisplayPanelLauncher onCreateBrowser={vi.fn()} onCreateTerminal={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Example' });
    expect(button.querySelector('img')).toBeNull();
    expect(button.querySelector('svg')).toBeTruthy();
    await act(async () => reject(new Error('offline')));
    expect(button.querySelector('svg')).toBeTruthy();
    expect(button.querySelector('img')).toBeNull();
  });

  it('drops late icon results after the launcher is hidden and reloads on reopening', async () => {
    listHistory.mockResolvedValue({
      success: true,
      entries: [{ url: 'https://example.com/', title: 'Example', lastVisitAt: 1, visitCount: 1 }],
    });
    let resolve!: (value: unknown) => void;
    loadHistoryFavicon.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const props = { onCreateBrowser: vi.fn(), onCreateTerminal: vi.fn() };
    const view = render(<DisplayPanelLauncher {...props} />);
    const button = await screen.findByRole('button', { name: 'Example' });
    view.rerender(<DisplayPanelLauncher {...props} visible={false} />);
    await act(async () => resolve({ success: true, dataUrl: faviconDataUrl }));
    expect(button.querySelector('img')).toBeNull();
    view.rerender(<DisplayPanelLauncher {...props} visible />);
    await waitFor(() => expect(loadHistoryFavicon).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Example' }).querySelector('img')?.getAttribute('src'),
      ).toBe(faviconDataUrl),
    );
  });

  it('resolves addresses and searches using the selected search engine', () => {
    const createBrowser = vi.fn();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...configService.getConfig(),
      browserSearchEngine: 'google',
    });
    render(<DisplayPanelLauncher onCreateBrowser={createBrowser} onCreateTerminal={vi.fn()} />);
    const address = screen.getByRole('textbox');
    fireEvent.change(address, { target: { value: 'example.com' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(createBrowser).toHaveBeenLastCalledWith('https://example.com/');
    fireEvent.change(address, { target: { value: 'project notes' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(createBrowser).toHaveBeenLastCalledWith('https://www.google.com/search?q=project+notes');
  });

  it('navigates the existing blank tab even when new-tab capacity is exhausted', async () => {
    listHistory.mockResolvedValue({
      success: true,
      entries: [{ url: 'https://example.com/', title: 'Example', lastVisitAt: 1, visitCount: 1 }],
    });
    const navigate = vi.fn();
    const createBrowser = vi.fn();
    render(
      <DisplayPanelLauncher
        browserDisabled
        showAddressInput={false}
        onNavigateBrowser={navigate}
        onCreateBrowser={createBrowser}
        onCreateTerminal={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Browser' })).toBeNull();
    expect(screen.queryByRole('search')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Example' }));
    expect(navigate).toHaveBeenCalledWith('https://example.com/');
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it('refreshes history on reopening and skips reads while hidden', async () => {
    const props = { onCreateBrowser: vi.fn(), onCreateTerminal: vi.fn() };
    const view = render(<DisplayPanelLauncher {...props} visible={false} />);
    expect(listHistory).not.toHaveBeenCalled();
    await act(async () => view.rerender(<DisplayPanelLauncher {...props} visible />));
    expect(listHistory).toHaveBeenCalledTimes(1);
    view.rerender(<DisplayPanelLauncher {...props} visible={false} />);
    await act(async () => view.rerender(<DisplayPanelLauncher {...props} visible />));
    expect(listHistory).toHaveBeenCalledTimes(2);
  });

  it('keeps tools usable when history cannot be loaded', async () => {
    listHistory.mockRejectedValue(new Error('unavailable'));
    const createTerminal = vi.fn();
    render(<DisplayPanelLauncher onCreateBrowser={vi.fn()} onCreateTerminal={createTerminal} />);
    expect(await screen.findByText(i18nService.t('browserHistoryLoadFailed'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(createTerminal).toHaveBeenCalledTimes(1);
  });

  it('updates shortcut hints when settings change and hides unassigned hints', () => {
    const config = configService.getConfig();
    const readConfig = vi.spyOn(configService, 'getConfig').mockReturnValue(config);
    render(<DisplayPanelLauncher onCreateBrowser={vi.fn()} onCreateTerminal={vi.fn()} />);
    readConfig.mockReturnValue({
      ...config,
      shortcuts: { ...config.shortcuts!, terminal: 'Alt+T' },
    });
    act(() => window.dispatchEvent(new Event('config-updated')));
    expect(screen.getByRole('button', { name: 'Terminal' }).textContent).toContain('Alt+T');
    readConfig.mockReturnValue({
      ...config,
      shortcuts: { ...config.shortcuts!, terminal: '' },
    });
    act(() => window.dispatchEvent(new Event('config-updated')));
    expect(screen.getByRole('button', { name: 'Terminal' }).querySelector('kbd')).toBeNull();
  });
});

it('offers delete and persistent pin actions in the recent visit context menu', async () => {
  listHistory.mockResolvedValue({ success: true, entries: [
    { url: 'https://example.com/pin', title: 'Pinned page', lastVisitAt: 1, visitCount: 1 },
  ] });
  const props = { onCreateBrowser: vi.fn(), onCreateTerminal: vi.fn() };
  const view = render(<DisplayPanelLauncher {...props} />);
  fireEvent.contextMenu(await screen.findByRole('button', { name: 'Pinned page' }));
  expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
  view.unmount();
  render(<DisplayPanelLauncher {...props} />);
  fireEvent.contextMenu(await screen.findByRole('button', { name: /📌 Pinned page/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }));
  fireEvent.contextMenu(await screen.findByRole('button', { name: 'Pinned page' }));
  fireEvent.click(screen.getByRole('menuitem', { name: i18nService.t('browserHistoryDeleteOne') }));
  await waitFor(() => expect(deleteHistory).toHaveBeenCalledWith(['https://example.com/pin']));
  expect(props.onCreateBrowser).not.toHaveBeenCalled();
});
