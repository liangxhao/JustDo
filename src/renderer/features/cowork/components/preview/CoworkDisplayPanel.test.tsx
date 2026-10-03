// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import CoworkDisplayPanel from './CoworkDisplayPanel';
import WorkspaceFilesPanel from './WorkspaceFilesPanel';

function setupFileTreeLayout() {
  i18nService.setLanguage('en', { persist: false });
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.id === 'cowork-display-panel' ? 760 : 1_200;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 240,
    y: 0,
    width: 760,
    height: 600,
    top: 0,
    bottom: 600,
    left: 240,
    right: 1_000,
    toJSON: () => ({}),
  });
}

function FileTreeHarness() {
  const [treeOpen, setTreeOpen] = useState(true);
  return (
    <>
      <button onClick={() => setTreeOpen(true)}>Files</button>
      <CoworkDisplayPanel
        activeTabId="file"
        isOpen
        onClose={() => undefined}
        width={760}
        fileContextPath="/work/notes.md"
        workspacePath="/work"
        onSidePanelClose={() => setTreeOpen(false)}
        sidePanel={treeOpen ? <div>Workspace tree</div> : undefined}
        tabs={[{ id: 'file', label: 'notes.md', icon: <span>F</span>, onSelect: () => undefined }]}
      >
        <div>File preview</div>
      </CoworkDisplayPanel>
    </>
  );
}

function RetainedFileTreeHarness({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const [treeOpen, setTreeOpen] = useState(initiallyOpen);
  const toggleTree = () => setTreeOpen(open => !open);
  return (
    <CoworkDisplayPanel
      activeTabId="file"
      isOpen
      onClose={() => undefined}
      width={760}
      fileContextPath="/work/notes.md"
      workspacePath="/work"
      onSidePanelClose={() => setTreeOpen(false)}
      onSidePanelToggle={toggleTree}
      sidePanelVisible={treeOpen}
      sidePanel={
        <WorkspaceFilesPanel
          sessionId="preview"
          isVisible={treeOpen}
          onOpenFile={() => undefined}
        />
      }
      tabs={[{ id: 'file', label: 'notes.md', icon: <span>F</span>, onSelect: () => undefined }]}
    >
      <div>File preview</div>
    </CoworkDisplayPanel>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CoworkDisplayPanel', () => {
  it('keeps automatic width at half the container until the user resizes it', () => {
    let availableWidth = 1_000;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => availableWidth);
    const onWidthChange = vi.fn();
    const panel = (width: number) => (
      <CoworkDisplayPanel
        activeTabId=""
        isOpen
        onClose={vi.fn()}
        onWidthChange={onWidthChange}
        tabs={[]}
        width={width}
      >
        <div>Browser content</div>
      </CoworkDisplayPanel>
    );
    const view = render(panel(0));
    expect(screen.getByRole('complementary').style.width).toBe('500px');

    availableWidth = 1_600;
    fireEvent(window, new Event('resize'));
    expect(screen.getByRole('complementary').style.width).toBe('800px');
    expect(onWidthChange).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    expect(onWidthChange).toHaveBeenLastCalledWith(776);
    view.rerender(panel(776));
    availableWidth = 1_800;
    fireEvent(window, new Event('resize'));
    expect(screen.getByRole('complementary').style.width).toBe('776px');
  });

  it('shows its launcher without a tab strip while keeping panel content mounted', () => {
    i18nService.setLanguage('en', { persist: false });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const closePanel = vi.fn();

    render(
      <CoworkDisplayPanel
        activeTabId=""
        isOpen
        onClose={closePanel}
        tabs={[]}
        emptyState={<button type="button">Browser</button>}
      >
        <div data-testid="persistent-panel-content">Persistent content</div>
      </CoworkDisplayPanel>,
    );

    expect(screen.getByRole('button', { name: 'Browser' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByTestId('persistent-panel-content')).toBeTruthy();
    const panel = screen.getByRole('complementary', { name: 'Content preview' });
    expect(panel.classList.contains('bg-background')).toBe(true);
    expect(panel.classList.contains('bg-surface')).toBe(false);
    expect(
      panel.querySelector('.cowork-workspace-header')?.classList.contains('bg-background'),
    ).toBe(true);
    const fullscreenButton = screen.getByRole('button', { name: 'Fill workspace' });
    fireEvent.click(fullscreenButton);
    expect(panel.getAttribute('data-workspace-fullscreen')).toBe('true');
    expect(panel.style.width).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Restore sidebar size' }));
    expect(panel.getAttribute('data-workspace-fullscreen')).toBe('false');
    expect(panel.style.width).toBe('520px');
    const closeButton = screen.getByRole('button', { name: 'Close sidebar' });
    expect(closeButton.parentElement?.lastElementChild).toBe(closeButton);
    fireEvent.click(screen.getByRole('button', { name: 'Fill workspace' }));
    fireEvent.click(closeButton);
    expect(panel.getAttribute('data-workspace-fullscreen')).toBe('false');
    expect(closePanel).toHaveBeenCalledTimes(1);
  });

  it('renders switchable content tabs in one resizable display region', async () => {
    i18nService.setLanguage('en', { persist: false });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const selectBrowser = vi.fn();
    const closeFile = vi.fn();
    const openBrowserMenu = vi.fn();

    render(
      <div style={{ width: 1_000 }}>
        <CoworkDisplayPanel
          activeTabId="file"
          isOpen
          onClose={vi.fn()}
          tabs={[
            {
              id: 'browser',
              label: 'Browser',
              icon: <span>B</span>,
              onSelect: selectBrowser,
              onContextMenu: openBrowserMenu,
            },
            {
              id: 'file',
              label: 'notes.md',
              icon: <span>F</span>,
              onSelect: vi.fn(),
              onClose: closeFile,
            },
          ]}
        >
          <div>Preview content</div>
        </CoworkDisplayPanel>
      </div>,
    );

    expect(screen.getByRole('complementary', { name: 'Content preview' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'notes.md' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Browser' }));
    expect(selectBrowser).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Browser' }), {
      clientX: 48,
      clientY: 72,
    });
    expect(openBrowserMenu).toHaveBeenCalledWith(
      { x: 48, y: 72 },
      expect.objectContaining({ canCloseOthers: true, canCloseRight: true }),
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: 'notes.md' }), { key: 'ArrowLeft' });
    expect(selectBrowser).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Browser' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close: notes.md' }));
    expect(closeFile).toHaveBeenCalledTimes(1);

    const separator = screen.getByRole('separator', { name: 'Drag to resize panels' });
    expect(separator.getAttribute('aria-valuenow')).toBe('520');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator.getAttribute('aria-valuenow')).toBe('496');
  });

  it('renders the width supplied by the owning session', () => {
    i18nService.setLanguage('en', { persist: false });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const view = render(
      <CoworkDisplayPanel activeTabId="file" isOpen onClose={vi.fn()} tabs={[]} width={600}>
        <div>Preview content</div>
      </CoworkDisplayPanel>,
    );

    expect(screen.getByRole('complementary').style.width).toBe('600px');
    view.rerender(
      <CoworkDisplayPanel activeTabId="file" isOpen onClose={vi.fn()} tabs={[]} width={440}>
        <div>Preview content</div>
      </CoworkDisplayPanel>,
    );
    expect(screen.getByRole('complementary').style.width).toBe('440px');
  });

  it('offers close, close-other, and close-right actions for display tabs', async () => {
    i18nService.setLanguage('en', { persist: false });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const selectMiddle = vi.fn();
    const closeLeft = vi.fn();
    const closeMiddle = vi.fn();
    const closeRight = vi.fn();
    const openSystemTerminal = vi.fn();

    render(
      <CoworkDisplayPanel
        activeTabId="middle"
        isOpen
        onClose={vi.fn()}
        tabs={[
          {
            id: 'left',
            label: 'Left',
            icon: <span>L</span>,
            onSelect: vi.fn(),
            onClose: closeLeft,
          },
          {
            id: 'middle',
            label: 'Middle',
            icon: <span>M</span>,
            onSelect: selectMiddle,
            onClose: closeMiddle,
            contextMenuItems: [
              {
                id: 'open-system-terminal',
                label: 'Open system terminal',
                onSelect: openSystemTerminal,
              },
            ],
          },
          {
            id: 'right',
            label: 'Right',
            icon: <span>R</span>,
            onSelect: vi.fn(),
            onClose: closeRight,
          },
        ]}
      >
        <div>Content</div>
      </CoworkDisplayPanel>,
    );

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Middle' }), {
      clientX: 40,
      clientY: 50,
    });
    const menu = screen.getByRole('menu', { name: 'Tab menu' });
    const openSystemTerminalItem = screen.getByRole('menuitem', {
      name: 'Open system terminal',
    });
    expect(menu.classList.contains('w-72')).toBe(true);
    expect(
      openSystemTerminalItem.querySelector('span')?.classList.contains('whitespace-nowrap'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open system terminal' }));
    expect(openSystemTerminal).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Middle' })),
    );

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Middle' }), {
      clientX: 40,
      clientY: 50,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close tabs to the right' }));
    await waitFor(() => expect(closeRight).toHaveBeenCalledTimes(1));

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Middle' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close other tabs' }));
    await waitFor(() => {
      expect(selectMiddle).toHaveBeenCalledTimes(1);
      expect(closeLeft).toHaveBeenCalledTimes(1);
      expect(closeRight).toHaveBeenCalledTimes(2);
    });

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Middle' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close' }));
    await waitFor(() => expect(closeMiddle).toHaveBeenCalledTimes(1));
  });

  it('stops a bulk close when a tab rejects its close transition', async () => {
    i18nService.setLanguage('en', { persist: false });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const rejectClose = vi.fn().mockResolvedValue(false);
    const laterClose = vi.fn();

    render(
      <CoworkDisplayPanel
        activeTabId="target"
        isOpen
        onClose={vi.fn()}
        tabs={[
          {
            id: 'target',
            label: 'Target',
            icon: <span>T</span>,
            onSelect: vi.fn(),
            onClose: vi.fn(),
          },
          {
            id: 'dirty-file',
            label: 'Dirty file',
            icon: <span>D</span>,
            onSelect: vi.fn(),
            onClose: rejectClose,
          },
          {
            id: 'later',
            label: 'Later',
            icon: <span>L</span>,
            onSelect: vi.fn(),
            onClose: laterClose,
          },
        ]}
      >
        <div>Content</div>
      </CoworkDisplayPanel>,
    );

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Target' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close tabs to the right' }));

    await waitFor(() => expect(rejectClose).toHaveBeenCalledTimes(1));
    expect(laterClose).not.toHaveBeenCalled();
  });

  it('dismisses a portaled tab menu when the display panel is hidden', () => {
    i18nService.setLanguage('en', { persist: false });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const tabs = [
      {
        id: 'file',
        label: 'notes.md',
        icon: <span>F</span>,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      },
    ];
    const view = render(
      <CoworkDisplayPanel activeTabId="file" isOpen onClose={vi.fn()} tabs={tabs}>
        <div>Content</div>
      </CoworkDisplayPanel>,
    );

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'notes.md' }));
    expect(screen.getByRole('menu', { name: 'Tab menu' })).toBeTruthy();

    view.rerender(
      <CoworkDisplayPanel activeTabId="file" isOpen={false} onClose={vi.fn()} tabs={tabs}>
        <div>Content</div>
      </CoworkDisplayPanel>,
    );
    expect(screen.queryByRole('menu', { name: 'Tab menu' })).toBeNull();
  });

  it('docks the workspace tree beside preview content without adding a tab', async () => {
    i18nService.setLanguage('en', { persist: false });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);

    render(
      <CoworkDisplayPanel
        activeTabId=""
        isOpen
        onClose={vi.fn()}
        tabs={[]}
        emptyState={<div>Open a file</div>}
        sidePanel={<div>Workspace tree</div>}
      >
        <div>Preview content</div>
      </CoworkDisplayPanel>,
    );

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText('Open a file')).toBeTruthy();
    expect(screen.getByText('Workspace tree')).toBeTruthy();
    await waitFor(() =>
      expect(
        screen
          .getByRole('separator', { name: i18nService.t('resizePanels') })
          .getAttribute('aria-valuenow'),
      ).toBe('640'),
    );
  });

  it.each(['browser:page', 'terminal:1'])(
    'removes file information on %s without discarding the hidden tree',
    activeToolId => {
      setupFileTreeLayout();
      const panel = (activeTabId: string, treeVisible: boolean, workspacePath = '/work') => (
        <CoworkDisplayPanel
          activeTabId={activeTabId}
          fileContextPath={activeTabId === 'file:/work/notes.md' ? '/work/notes.md' : undefined}
          workspacePath={workspacePath}
          isOpen
          onClose={vi.fn()}
          tabs={[]}
          showEmptyState={false}
          sidePanel={<input aria-label="Retained file filter" defaultValue="" />}
          sidePanelVisible={treeVisible}
          onSidePanelToggle={vi.fn()}
        >
          <div>Tool content</div>
        </CoworkDisplayPanel>
      );
      const view = render(panel('file:/work/notes.md', true));
      const filter = screen.getByRole('textbox', { name: 'Retained file filter' });
      fireEvent.change(filter, { target: { value: 'notes' } });
      view.rerender(panel('file:/work/notes.md', false));
      expect(screen.getByRole('toolbar', { name: 'File information' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Show file tree' })).toBeTruthy();

      view.rerender(panel(activeToolId, false));
      expect(screen.queryByRole('toolbar', { name: 'File information' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Show file tree' })).toBeNull();
      expect(filter.isConnected).toBe(true);
      expect((filter as HTMLInputElement).value).toBe('notes');
      view.rerender(panel(activeToolId, false, '/other-project'));
      expect(screen.queryByRole('toolbar', { name: 'File information' })).toBeNull();

      view.rerender(panel('file:/work/notes.md', false));
      expect(screen.getByLabelText('/work/notes.md')).toBeTruthy();
      view.rerender(panel('workspace-files', false));
      expect(screen.getByRole('toolbar', { name: 'File information' })).toBeTruthy();
      view.rerender(panel(activeToolId, true));
      expect(screen.getByRole('toolbar', { name: 'File information' })).toBeTruthy();
    },
  );

  it('resizes the file tree in both directions and leaves space for the preview', () => {
    setupFileTreeLayout();
    render(<FileTreeHarness />);
    const divider = screen.getByRole('separator', {
      name: i18nService.t('coworkWorkspaceFilesResize'),
    });
    fireEvent.pointerDown(divider, { button: 0, clientX: 680 });
    fireEvent.pointerMove(window, { clientX: 600 });
    expect(divider.getAttribute('aria-valuenow')).toBe('400');
    expect(divider.parentElement?.style.width).toBe('400px');
    fireEvent.pointerMove(window, { clientX: 50 });
    expect(divider.getAttribute('aria-valuenow')).toBe('580');
    fireEvent.pointerMove(window, { clientX: 820 });
    expect(divider.getAttribute('aria-valuenow')).toBe('180');
    fireEvent.pointerUp(window);
    expect(screen.getByText('File preview')).toBeTruthy();
    expect(document.body.style.cursor).toBe('');
  });

  it('hides the tree after dragging right and restores it from Files without closing the preview', () => {
    setupFileTreeLayout();
    render(<FileTreeHarness />);
    const divider = screen.getByRole('separator', {
      name: i18nService.t('coworkWorkspaceFilesResize'),
    });
    fireEvent.pointerDown(divider, { button: 0 });
    fireEvent.pointerMove(window, { clientX: 800 });
    fireEvent.pointerMove(window, { clientX: 940 });
    expect(screen.queryByText('Workspace tree')).toBeNull();
    expect(screen.getByRole('tab', { name: 'notes.md' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText('File preview')).toBeTruthy();
    expect(document.body.style.cursor).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByText('Workspace tree')).toBeTruthy();
    expect(
      screen
        .getByRole('separator', { name: i18nService.t('coworkWorkspaceFilesResize') })
        .getAttribute('aria-valuenow'),
    ).toBe('200');
  });

  it.each(['pointercancel', 'blur', 'unmount'])(
    'releases file-tree dragging state on %s',
    action => {
      setupFileTreeLayout();
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'text';
      const view = render(<FileTreeHarness />);
      const divider = screen.getByRole('separator', {
        name: i18nService.t('coworkWorkspaceFilesResize'),
      });
      fireEvent.pointerDown(divider, { button: 0 });
      expect(document.body.style.cursor).toBe('col-resize');
      if (action === 'unmount') view.unmount();
      else fireEvent(window, new MouseEvent(action));
      expect(document.body.style.cursor).toBe('default');
      expect(document.body.style.userSelect).toBe('text');
      fireEvent.pointerMove(window, { clientX: 400 });
      if (action !== 'unmount') expect(divider.getAttribute('aria-valuenow')).toBe('319');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
  );

  it('supports keyboard width adjustment and collapsing the file tree', () => {
    setupFileTreeLayout();
    render(<FileTreeHarness />);
    const divider = screen.getByRole('separator', {
      name: i18nService.t('coworkWorkspaceFilesResize'),
    });
    fireEvent.keyDown(divider, { key: 'End' });
    expect(divider.getAttribute('aria-valuenow')).toBe('580');
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(divider.getAttribute('aria-valuenow')).toBe('556');
    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(divider.getAttribute('aria-valuenow')).toBe('580');
    fireEvent.keyDown(divider, { key: 'Home' });
    expect(screen.queryByText('Workspace tree')).toBeNull();
    expect(screen.getByText('File preview')).toBeTruthy();
  });

  it('keeps the preview, filter, expanded folders and width when toggling the file tree', async () => {
    setupFileTreeLayout();
    const listWorkspaceDirectory = vi.fn(async (_sessionId: string, relativePath: string) => ({
      success: true,
      entries:
        relativePath === ''
          ? [{ filePath: '/work/src', relativePath: 'src', name: 'src', kind: 'directory' }]
          : [
              {
                filePath: '/work/src/main.ts',
                relativePath: 'src/main.ts',
                name: 'main.ts',
                kind: 'file',
              },
            ],
    }));
    vi.stubGlobal('electron', { shell: { listWorkspaceDirectory } });
    render(<RetainedFileTreeHarness />);
    const fileInfo = screen.getByRole('toolbar', { name: 'File information' });
    const filePath = screen.getByTitle('/work/notes.md');
    const hideTree = screen.getByRole('button', { name: 'Hide file tree' });
    expect(hideTree.closest('[role="toolbar"]')).toBe(fileInfo);
    expect(screen.getByRole('tablist').parentElement?.contains(hideTree)).toBe(false);
    fireEvent.click(await screen.findByText('src'));
    await screen.findByText('main.ts');
    const filter = screen.getByRole('textbox');
    fireEvent.change(filter, { target: { value: 'main' } });
    const divider = screen.getByRole('separator', {
      name: i18nService.t('coworkWorkspaceFilesResize'),
    });
    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    const resizedWidth = divider.getAttribute('aria-valuenow');
    filter.focus();

    fireEvent.click(screen.getByRole('button', { name: 'Hide file tree' }));

    const showTree = screen.getByRole('button', { name: 'Show file tree' });
    expect(showTree).toBe(hideTree);
    expect(showTree.closest('[role="toolbar"]')).toBe(fileInfo);
    expect(screen.getByTitle('/work/notes.md')).toBe(filePath);
    expect(showTree.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(showTree);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.getElementById('cowork-workspace-files-panel')?.hasAttribute('inert')).toBe(
      true,
    );
    expect(screen.getByRole('tab', { name: 'notes.md' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText('File preview')).toBeTruthy();

    fireEvent.click(showTree);

    expect(screen.getByRole('button', { name: 'Hide file tree' })).toBe(hideTree);
    expect(hideTree.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('textbox')).toBe(filter);
    expect(filter).toHaveProperty('value', 'main');
    expect(document.activeElement).toBe(filter);
    expect(screen.getByRole('treeitem', { name: 'src' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.getByText('main.ts')).toBeTruthy();
    expect(divider.getAttribute('aria-valuenow')).toBe(resizedWidth);
    expect(listWorkspaceDirectory).toHaveBeenCalledTimes(2);
  });

  it('loads the file tree only after it is shown for the first time', async () => {
    setupFileTreeLayout();
    const listWorkspaceDirectory = vi.fn().mockResolvedValue({ success: true, entries: [] });
    vi.stubGlobal('electron', { shell: { listWorkspaceDirectory } });
    render(<RetainedFileTreeHarness initiallyOpen={false} />);
    expect(listWorkspaceDirectory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Show file tree' }));

    await waitFor(() => expect(listWorkspaceDirectory).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('clamps its width when the containing layout changes without a window resize', () => {
    i18nService.setLanguage('en', { persist: false });
    let availableWidth = 1_000;
    const resizeCallbacks: Array<() => void> = [];
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => availableWidth);
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        constructor(callback: () => void) {
          resizeCallbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );

    render(
      <div>
        <CoworkDisplayPanel
          activeTabId="browser"
          isOpen
          onClose={vi.fn()}
          tabs={[
            {
              id: 'browser',
              label: 'Browser',
              icon: <span>B</span>,
              onSelect: vi.fn(),
            },
          ]}
        >
          <div>Browser content</div>
        </CoworkDisplayPanel>
      </div>,
    );

    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('520');
    availableWidth = 700;
    act(() => resizeCallbacks.forEach(resize => resize()));
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('360');
  });

  it('renders web pages, files, and the singleton plan as peer tabs', () => {
    i18nService.setLanguage('en', { persist: false });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const addPage = vi.fn();
    const labels = [
      'Page one',
      'Page two',
      'Page three',
      'notes.md',
      'design.tsx',
      'Implementation plan',
    ];

    render(
      <CoworkDisplayPanel
        activeTabId="plan"
        isOpen
        onClose={vi.fn()}
        tabs={labels.map((label, index) => ({
          id: index === labels.length - 1 ? 'plan' : `tab-${index}`,
          label,
          icon: <span aria-hidden="true">T</span>,
          onSelect: vi.fn(),
        }))}
        actions={
          <button type="button" onClick={addPage} aria-label="New page">
            +
          </button>
        }
      >
        <div>Plan content</div>
      </CoworkDisplayPanel>,
    );

    expect(screen.getAllByRole('tab')).toHaveLength(6);
    expect(screen.getAllByTestId('display-tab-divider')).toHaveLength(5);
    expect(screen.getByRole('tab', { name: 'Implementation plan' })).toBeTruthy();
    const tabCluster = screen.getByTestId('display-tab-cluster');
    expect(tabCluster.parentElement?.classList.contains('cowork-workspace-header')).toBe(true);
    expect(tabCluster.classList.contains('h-full')).toBe(true);
    expect(
      screen
        .getByRole('tab', { name: 'Implementation plan' })
        .parentElement?.classList.contains('h-full'),
    ).toBe(true);
    expect(
      tabCluster.lastElementChild?.contains(screen.getByRole('button', { name: 'New page' })),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    expect(addPage).toHaveBeenCalledTimes(1);
  });
});
