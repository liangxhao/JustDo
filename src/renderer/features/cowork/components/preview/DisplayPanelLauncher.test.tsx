// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

import DisplayPanelLauncher from './DisplayPanelLauncher';

const listHistory = vi.fn();
beforeEach(() => {
  i18nService.setLanguage('en', { persist: false });
  listHistory.mockResolvedValue({ success: true, entries: [] });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { browser: { listHistory } },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  listHistory.mockReset();
});

describe('DisplayPanelLauncher', () => {
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
    const browserButton = screen.getByRole('button', { name: 'Browser' });
    fireEvent.click(browserButton);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Side chat' }));
    expect(createBrowser).toHaveBeenCalledTimes(1);
    expect(createTerminal).toHaveBeenCalledTimes(1);
    expect(openFiles).toHaveBeenCalledTimes(1);
    expect(openReview).toHaveBeenCalledTimes(1);
    expect(createSideChat).toHaveBeenCalledTimes(1);
    expect(createBrowser).toHaveBeenCalledWith();
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

    expect(screen.getByRole('button', { name: 'Browser' }).hasAttribute('disabled')).toBe(true);
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

  it('shows the real website icon without sending a referrer', async () => {
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
    render(<DisplayPanelLauncher onCreateBrowser={vi.fn()} onCreateTerminal={vi.fn()} />);
    const icon = (await screen.findByRole('button', { name: 'Docs' })).querySelector('img');
    expect(icon?.getAttribute('src')).toBe('https://cdn.example.com/site.svg');
    expect(icon?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

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
    fireEvent.error(button.querySelector('img')!);
    expect(button.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/favicon.ico',
    );
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
    const icon = (await screen.findByRole('button', { name: 'Docs' })).querySelector('img');
    expect(icon?.getAttribute('src')).toBe('https://example.com/favicon.ico');
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
    expect(screen.getByRole('button', { name: 'Browser' }).hasAttribute('disabled')).toBe(true);
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
      shortcuts: { ...config.shortcuts!, terminal: 'Alt+T', browser: '' },
    });
    act(() => window.dispatchEvent(new Event('config-updated')));
    expect(screen.getByRole('button', { name: 'Terminal' }).textContent).toContain('Alt+T');
    expect(screen.getByRole('button', { name: 'Browser' }).querySelector('kbd')).toBeNull();
  });
});
