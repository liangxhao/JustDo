// @vitest-environment jsdom
import { DndContext } from '@dnd-kit/core';
import { configureStore } from '@reduxjs/toolkit';
import { CoworkSessionSource } from '@shared/cowork/sessionSource';
import { ExternalSessionSource, ExternalSessionStatus } from '@shared/integrations/externalSession';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';

import CoworkSessionItem from './CoworkSessionItem';
const fixture = vi.hoisted(() => ({ presentation: {} as { copyAllowed?: boolean } }));
vi.mock('@/features/plugins/app/runtime', () => ({
  appBrowserRegistry: {
    sessionPresentation: () => fixture.presentation,
    subscribe: () => () => {},
    getContextRevision: () => 0,
  },
}));

const renderSessionItem = (options?: {
  isRuntimeRunning?: boolean;
  collaboration?: boolean;
  worktree?: boolean;
  metadata?: Pick<CoworkSessionSummary, 'source' | 'external'>;
  withGroups?: boolean;
}) => {
  fixture.presentation = options?.collaboration ? { copyAllowed: false } : {};
  const onSelect = vi.fn();
  const onExport = vi.fn();
  const onCopy = vi.fn();
  const onMoveToGroup = vi.fn();
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
            ...options?.metadata,
            ...(options?.worktree ? { nativeSessionKey: 'agent:main:subagent:tree-1' } : {}),
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
          groups={
            options?.withGroups
              ? [{ id: 'work', name: 'Work', color: '#359daf', sortOrder: 0, createdAt: 1 }]
              : []
          }
          onMoveToGroup={onMoveToGroup}
        />
      </DndContext>
    </Provider>,
  );
  fireEvent.contextMenu(screen.getByText('Planning'));
  return { onExport, onCopy, onSelect, onMoveToGroup };
};

afterEach(cleanup);

describe('CoworkSessionItem context menu session actions', () => {
  it.each([
    { source: CoworkSessionSource.BrowserExtension },
    ...Object.values(ExternalSessionSource).map(origin => ({
      external: {
        origin,
        readOnly: true as const,
        status: ExternalSessionStatus.Completed,
        sessionKey: 'key',
      },
    })),
  ])('prevents manual grouping and dragging for source conversations: %j', metadata => {
    i18nService.setLanguage('en', { persist: false });
    const { onMoveToGroup } = renderSessionItem({ metadata, withGroups: true });
    expect(screen.queryByRole('menuitem', { name: /Move to Group/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Planning' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(onMoveToGroup).not.toHaveBeenCalled();
  });

  it('keeps the move menu and dragging available for ordinary conversations', () => {
    i18nService.setLanguage('en', { persist: false });
    const { onMoveToGroup } = renderSessionItem({ withGroups: true });
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /Move to Group/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    expect(onMoveToGroup).toHaveBeenCalledExactlyOnceWith('work');
    expect(screen.getByRole('button', { name: 'Planning' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
  });

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

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export conversation' }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onCopy).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByText('Planning'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy current session' }));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('disables export and copy while the session runtime is active', () => {
    i18nService.setLanguage('en', { persist: false });
    renderSessionItem({ isRuntimeRunning: true });

    const exportItem = screen.getByRole('menuitem', { name: 'Export conversation' });
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

  it('disables copy for a managed worktree while retaining export', () => {
    i18nService.setLanguage('en', { persist: false });
    const { onCopy } = renderSessionItem({ worktree: true });
    const copyItem = screen.getByRole('menuitem', { name: 'Copy current session' });
    expect(copyItem.hasAttribute('disabled')).toBe(true);
    expect(copyItem.getAttribute('title')).toBe(i18nService.t('worktreeCopyUnavailable'));
    expect(
      screen.getByRole('menuitem', { name: 'Export conversation' }).hasAttribute('disabled'),
    ).toBe(false);
    fireEvent.click(copyItem);
    expect(onCopy).not.toHaveBeenCalled();
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
  expect(screen.getByRole('menuitem', { name: 'Export conversation' })).toBeTruthy();
});
