// @vitest-environment jsdom
import { DndContext } from '@dnd-kit/core';
import { configureStore } from '@reduxjs/toolkit';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import CoworkSessionItem from './CoworkSessionItem';

const renderSessionItem = (options?: { isRuntimeRunning?: boolean; collaboration?: boolean }) => {
  const onSelect = vi.fn();
  const onExport = vi.fn();
  const onCopy = vi.fn();
  const store = configureStore({ reducer: { agent: () => ({ agents: [] }) } });
  render(
    <Provider store={store}>
      <DndContext>
        <CoworkSessionItem
          session={{
            id: 'session-1',
            title: 'Planning',
            status: 'idle',
            pinned: false,
            createdAt: 1,
            updatedAt: 2,
            ...(options?.collaboration
              ? { collaboration: { memberCount: 3, deleting: false } }
              : {}),
          }}
          hasUnread={false}
          isActive
          isRuntimeRunning={options?.isRuntimeRunning}
          isBatchMode={false}
          isSelected={false}
          onSelect={onSelect}
          onDelete={vi.fn()}
          onRename={vi.fn()}
          onExport={onExport}
          onCopy={onCopy}
          onTogglePinned={vi.fn()}
          onToggleSelection={vi.fn()}
          onEnterBatchMode={vi.fn()}
        />
      </DndContext>
    </Provider>,
  );
  fireEvent.contextMenu(screen.getByText('Planning'));
  return { onExport, onCopy, onSelect };
};

afterEach(cleanup);

describe('CoworkSessionItem context menu session actions', () => {
  it('opens diagnostics for the clicked running session without selecting its chat', async () => {
    i18nService.setLanguage('en', { persist: false });
    const read = vi.fn().mockResolvedValue({ success: false, reason: 'missing' });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          diagnostics: { list: vi.fn().mockResolvedValue({ success: true, runs: [] }), read },
        },
      },
    });
    const { onSelect } = renderSessionItem({ isRuntimeRunning: true });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Diagnostics' }));
    await screen.findByRole('dialog', { name: 'Diagnostics' });
    expect(read).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('copies the Gateway ID for the main session represented by the list item', async () => {
    i18nService.setLanguage('en', { persist: false });
    const getGatewaySessionId = vi.fn().mockResolvedValue({
      success: true,
      sessionId: 'gateway-main-session',
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { cowork: { getGatewaySessionId } },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderSessionItem({ collaboration: true });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy main session ID' }));

    await waitFor(() => expect(getGatewaySessionId).toHaveBeenCalledWith('session-1'));
    expect(writeText).toHaveBeenCalledWith('gateway-main-session');
  });

  it('offers export and copy for the selected session', () => {
    i18nService.setLanguage('en', { persist: false });
    const { onExport, onCopy } = renderSessionItem();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export main conversation' }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onCopy).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByText('Planning'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy current session' }));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('disables export and copy while the session runtime is active', () => {
    i18nService.setLanguage('en', { persist: false });
    renderSessionItem({ isRuntimeRunning: true });

    const exportItem = screen.getByRole('menuitem', { name: 'Export main conversation' });
    const copyItem = screen.getByRole('menuitem', { name: 'Copy current session' });
    expect(exportItem.hasAttribute('disabled')).toBe(true);
    expect(exportItem.getAttribute('title')).toBe(
      'Wait for the current response to finish before exporting',
    );
    expect(copyItem.hasAttribute('disabled')).toBe(true);
    expect(copyItem.getAttribute('title')).toBe(
      'Wait for the current response to finish before copying',
    );
  });

  it('opens the context menu from the keyboard and supports arrow navigation', async () => {
    i18nService.setLanguage('en', { persist: false });
    renderSessionItem();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    const sessionItem = screen.getByRole('button', { name: 'Planning' });
    sessionItem.focus();
    fireEvent.keyDown(sessionItem, { key: 'F10', shiftKey: true });

    const menuItems = screen.getAllByRole('menuitem');
    await waitFor(() => expect(document.activeElement).toBe(menuItems[0]));
    fireEvent.keyDown(menuItems[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menuItems[1]);
  });
});

it('keeps task menus focused and does not offer an incomplete collaboration copy', () => {
  i18nService.setLanguage('en', { persist: false });
  renderSessionItem({ collaboration: true });
  expect(screen.queryByRole('menuitem', { name: 'Copy current session' })).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Export main conversation' })).toBeTruthy();
});
