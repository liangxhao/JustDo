// @vitest-environment jsdom

import type { WorkspaceWindowResult } from '@shared/cowork/workspaceWindow';
import { McpAppEvent } from '@shared/plugins/mcpApps';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { getMcpAppPresentations } from '@/libs/openclaw-chat/components/mcp-app/presentations';
import { McpAppView } from '@/libs/openclaw-chat/components/mcp-app/view';
import { i18nService } from '@/services/i18n';

import CoworkDisplayPanel from './CoworkDisplayPanel';

beforeEach(() => {
  i18nService.setLanguage('en', { persist: false });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['mcp-app-reference:one', 'widget-reference:one'])(
  'keeps %s inside the same workspace document while detaching and docking',
  async activeTabId => {
    const workspace = document.createElement('iframe');
    document.body.append(workspace);
    const workspaceDocument = workspace.contentDocument!;
    workspaceDocument.body.innerHTML = '<div id="workspace-root"></div>';
    const generation = 'reference-workspace-generation';
    let finishDetach!: (result: WorkspaceWindowResult) => void;
    const pendingDetach = new Promise<WorkspaceWindowResult>(resolve => {
      finishDetach = resolve;
    });
    const api = {
      prepare: vi.fn().mockResolvedValue({
        generation,
        frameName: 'reference-workspace',
        url: '/workspace.html',
        detached: false,
        existing: false,
      }),
      update: vi.fn(),
      setDetached: vi
        .fn()
        .mockImplementationOnce(() => pendingDetach)
        .mockResolvedValue({ success: true, state: { generation, detached: false } }),
      focusMain: vi.fn(),
      control: vi.fn(),
      getWindowState: vi.fn().mockResolvedValue({ isMaximized: false }),
      onStateChanged: vi.fn(() => () => undefined),
      onInvalidated: vi.fn(() => () => undefined),
    };
    vi.stubGlobal('electron', { workspaceWindow: api, platform: 'win32' });
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(workspace.contentWindow);
    const reference = (
      <div>
        <input aria-label="Local selection" defaultValue="Original selection" />
        <iframe title="Retained reference document" />
      </div>
    );
    const panel = (pinned: boolean, isOpen = true) => (
      <CoworkDisplayPanel
        activeTabId={activeTabId}
        isOpen={isOpen}
        onClose={vi.fn()}
        tabs={[{ id: activeTabId, label: 'Interactive view', icon: null, onSelect: vi.fn() }]}
        referenceContent={pinned ? reference : undefined}
      >
        <div data-testid="retained-workspace-content">Native workspace content</div>
      </CoworkDisplayPanel>
    );
    const { rerender } = render(panel(false));
    const nativeContent = await within(workspaceDocument.body).findByTestId(
      'retained-workspace-content',
    );
    expect(
      within(workspaceDocument.body).getByRole('button', {
        name: 'Open sidebar in a separate window',
      }),
    ).toBeTruthy();

    rerender(panel(true));
    const workspaceContent = within(workspaceDocument.body);
    const detach = workspaceContent.getByRole('button', {
      name: 'Open sidebar in a separate window',
    });
    const frame = workspaceContent.getByTitle('Retained reference document');
    const input = workspaceContent.getByRole('textbox', {
      name: 'Local selection',
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Keep this selection' } });
    expect(frame.ownerDocument).toBe(workspaceDocument);
    expect(screen.queryByTitle('Retained reference document')).toBeNull();
    expect(workspaceDocument.querySelectorAll('#cowork-display-panel')).toHaveLength(1);
    expect(workspaceDocument.querySelector('[data-testid="retained-workspace-content"]')).toBe(
      nativeContent,
    );

    fireEvent.click(detach);
    expect(api.setDetached).toHaveBeenCalledExactlyOnceWith(generation, true);
    expect((detach as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      finishDetach({ success: true, state: { generation, detached: true } });
      await pendingDetach;
    });

    const dock = workspaceContent.getByRole('button', { name: 'Return to main window' });
    expect(workspaceDocument.querySelector('[data-window-header="true"]')).not.toBeNull();
    expect(workspaceContent.queryByText('View in main window')).toBeNull();
    expect(workspaceContent.getByTitle('Retained reference document')).toBe(frame);
    expect(frame.ownerDocument).toBe(workspaceDocument);
    expect(input.value).toBe('Keep this selection');
    expect(workspaceDocument.querySelector('[data-testid="retained-workspace-content"]')).toBe(
      nativeContent,
    );
    rerender(panel(true, false));
    expect(
      workspaceDocument.querySelector('#cowork-display-panel')?.getAttribute('aria-hidden'),
    ).toBe('false');
    expect(workspaceContent.getByTitle('Retained reference document')).toBe(frame);

    fireEvent.click(dock);
    await waitFor(() => {
      expect(api.setDetached).toHaveBeenNthCalledWith(2, generation, false);
      expect(workspaceDocument.querySelector('[data-window-header="true"]')).toBeNull();
    });
    expect(
      workspaceDocument.querySelector('#cowork-display-panel')?.getAttribute('aria-hidden'),
    ).toBe('true');
    rerender(panel(true));
    expect(
      workspaceContent.getByRole('button', {
        name: 'Open sidebar in a separate window',
      }),
    ).toBeTruthy();
    expect(api.prepare).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledOnce();
    expect(workspaceContent.getByTitle('Retained reference document')).toBe(frame);
    expect(input.value).toBe('Keep this selection');
    rerender(panel(false));
    expect(workspaceContent.queryByTitle('Retained reference document')).toBeNull();
    expect(workspaceDocument.querySelector('[data-testid="retained-workspace-content"]')).toBe(
      nativeContent,
    );
  },
);

it('accepts fullscreen requests only from the selected retained card target', async () => {
  const workspace = document.createElement('iframe');
  document.body.append(workspace);
  const workspaceDocument = workspace.contentDocument!;
  workspaceDocument.body.innerHTML = '<div id="workspace-root"></div>';
  const generation = 'reference-mode-generation';
  vi.stubGlobal('electron', {
    platform: 'win32',
    workspaceWindow: {
      prepare: vi.fn().mockResolvedValue({
        generation,
        frameName: 'reference-workspace',
        url: '/workspace.html',
        detached: false,
        existing: false,
      }),
      update: vi.fn(),
      focusMain: vi.fn(),
      onStateChanged: vi.fn(() => () => undefined),
      onInvalidated: vi.fn(() => () => undefined),
    },
  });
  vi.spyOn(window, 'open').mockReturnValue(workspace.contentWindow);
  render(
    <CoworkDisplayPanel
      activeTabId="mcp-app-reference:one"
      isOpen
      onClose={vi.fn()}
      tabs={[]}
      showEmptyState={false}
      referenceContent={<div data-testid="reference-target" />}
    >
      <div data-testid="unrelated-content" />
    </CoworkDisplayPanel>,
  );
  const target = await within(workspaceDocument.body).findByTestId('reference-target');
  const panel = workspaceDocument.getElementById('cowork-display-panel')!;
  const view = new McpAppView();
  const manager = getMcpAppPresentations();
  const entry = { pinned: true, sidebar: target };
  vi.spyOn(manager, 'find').mockImplementation(value =>
    value === view ? (entry as ReturnType<typeof manager.find>) : undefined,
  );
  const respond = vi.fn();
  const request = (source: HTMLElement, mode = 'fullscreen', candidate = view) => {
    fireEvent(
      source,
      new CustomEvent(McpAppEvent.DisplayMode, {
        bubbles: true,
        detail: { mode, respond, view: candidate },
      }),
    );
  };

  request(target);
  expect(respond).toHaveBeenCalledExactlyOnceWith(true);
  expect(panel.getAttribute('data-workspace-fullscreen')).toBe('true');

  request(target, 'inline');
  expect(panel.getAttribute('data-workspace-fullscreen')).toBe('false');
  respond.mockClear();
  request(within(workspaceDocument.body).getByTestId('unrelated-content'));
  request(target, 'fullscreen', new McpAppView());
  entry.pinned = false;
  request(target);
  expect(respond).not.toHaveBeenCalled();
  expect(panel.getAttribute('data-workspace-fullscreen')).toBe('false');

  within(workspaceDocument.body).getByTestId('unrelated-content').append(view);
  fireEvent(
    view,
    new CustomEvent(McpAppEvent.DisplayMode, {
      bubbles: true,
      detail: { mode: 'fullscreen', respond },
    }),
  );
  expect(respond).toHaveBeenCalledExactlyOnceWith(true);
  expect(panel.getAttribute('data-workspace-fullscreen')).toBe('true');
});

it('moves native workspace keyboard focus between ordinary and message tabs immediately', async () => {
  const workspace = document.createElement('iframe');
  document.body.append(workspace);
  const workspaceDocument = workspace.contentDocument!;
  workspaceDocument.body.innerHTML = '<div id="workspace-root"></div>';
  vi.stubGlobal('electron', {
    platform: 'win32',
    workspaceWindow: {
      prepare: vi.fn().mockResolvedValue({
        generation: 'keyboard-workspace-generation',
        frameName: 'keyboard-workspace',
        url: '/workspace.html',
        detached: false,
        existing: false,
      }),
      update: vi.fn(),
      onStateChanged: vi.fn(() => () => undefined),
      onInvalidated: vi.fn(() => () => undefined),
    },
  });
  vi.spyOn(window, 'open').mockReturnValue(workspace.contentWindow);
  // Tab focus must not depend on a visible frame or a compositor callback.
  vi.spyOn(workspace.contentWindow!, 'requestAnimationFrame').mockReturnValue(1);
  function Harness() {
    const [active, select] = useState('ordinary');
    return (
      <CoworkDisplayPanel
        activeTabId={active}
        isOpen
        onClose={vi.fn()}
        showEmptyState={false}
        tabs={[
          { id: 'ordinary', label: 'Ordinary', icon: null, onSelect: () => select('ordinary') },
          {
            id: 'reference',
            label: 'Message card',
            icon: null,
            reference: true,
            onSelect: () => select('reference'),
          },
        ]}
        referenceContent={active === 'reference' ? <div>Retained card</div> : undefined}
      >
        <div>Ordinary content</div>
      </CoworkDisplayPanel>
    );
  }
  render(<Harness />);
  const ordinary = await within(workspaceDocument.body).findByRole('tab', { name: 'Ordinary' });
  const reference = within(workspaceDocument.body).getByRole('tab', { name: /Message card/ });
  ordinary.focus();

  fireEvent.keyDown(ordinary, { key: 'ArrowRight' });
  expect(reference.getAttribute('aria-selected')).toBe('true');
  expect(workspaceDocument.activeElement).toBe(reference);

  fireEvent.keyDown(reference, { key: 'ArrowLeft' });
  expect(ordinary.getAttribute('aria-selected')).toBe('true');
  expect(workspaceDocument.activeElement).toBe(ordinary);
});
