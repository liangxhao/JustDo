// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import { CoworkSessionSource } from '@shared/cowork/sessionSource';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, it, vi } from 'vitest';

import coworkReducer, { setGroups, toggleGroupExpanded } from '@/features/cowork/coworkSlice';
import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import { translations } from '@/services/i18n/translations';

import CoworkSessionList from './CoworkSessionList';

vi.mock('@/features/cowork/components/chat/CollaborationPanel', () => ({
  useCollaborationRooms: () => [],
}));
vi.mock('@/features/cowork/coworkService', () => ({ coworkService: {} }));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => translations.en[key] ?? key },
}));

afterEach(cleanup);

const summary = (id: string, updatedAt: number): CoworkSessionSummary => ({
  id,
  title: id,
  status: 'idle',
  pinned: false,
  createdAt: updatedAt,
  updatedAt,
});
const browserSessions: CoworkSessionSummary[] = [
  { ...summary('Browser older', 1), source: CoworkSessionSource.BrowserExtension },
  {
    ...summary('Browser newer', 2),
    source: CoworkSessionSource.BrowserExtension,
    pinned: true,
    groupId: 'work',
  },
];
const createProps = (sessions: CoworkSessionSummary[]) => ({
  sessions,
  currentSessionId: null as string | null,
  isBatchMode: false,
  selectedIds: new Set<string>(),
  showCreateGroupButton: false,
  onSelectSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onRenameSession: vi.fn(),
  onExportSession: vi.fn(),
  onCopySession: vi.fn(),
  onToggleSelection: vi.fn(),
  onEnterBatchMode: vi.fn(),
});
const createStore = () =>
  configureStore({
    reducer: { cowork: coworkReducer, agent: () => ({ agents: [] }) },
  });

describe('sidebar browser extension group', () => {
  it('defaults to collapsed, keeps browser sessions out of recent and user groups, and leaves Multica separate', () => {
    const store = createStore();
    store.dispatch(
      setGroups([{ id: 'work', name: 'Work', color: '#359daf', sortOrder: 0, createdAt: 1 }]),
    );
    store.dispatch(toggleGroupExpanded('work'));
    const props = createProps([
      ...browserSessions,
      summary('Desktop chat', 3),
      {
        ...summary('Multica chat', 4),
        external: {
          origin: 'multica',
          readOnly: true,
          status: 'completed',
          sessionKey: 'multica:one',
        },
      },
    ]);
    render(
      <Provider store={store}>
        <CoworkSessionList {...props} />
      </Provider>,
    );

    const browserGroup = screen.getByRole('button', { name: /^Chrome\s*2$/ });
    expect(browserGroup.getAttribute('aria-expanded')).toBe('false');
    expect(within(browserGroup).getByText('2')).toBeTruthy();
    expect(screen.queryByText('Browser newer')).toBeNull();
    expect(screen.queryByText('Browser older')).toBeNull();
    expect(screen.getByText('Desktop chat')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^Multica\s*1$/ }).getAttribute('aria-expanded'),
    ).toBe('false');

    fireEvent.click(browserGroup);
    const panel = browserGroup.nextElementSibling as HTMLElement;
    expect(within(panel).getByText('Browser newer')).toBeTruthy();
    expect(within(panel).getByText('Browser older')).toBeTruthy();
    expect(screen.getAllByText('Browser newer')).toHaveLength(1);
    expect(screen.queryByText('Multica chat')).toBeNull();
    fireEvent.click(screen.getByText('Browser newer'));
    expect(props.onSelectSession).toHaveBeenCalledWith('Browser newer');
    fireEvent.click(browserGroup);
    expect(screen.queryByText('Browser newer')).toBeNull();
  });

  it('opens the active browser group and respects manual collapse through list refreshes', () => {
    const store = createStore();
    const props = { ...createProps(browserSessions), currentSessionId: 'Browser older' };
    const { rerender } = render(
      <Provider store={store}>
        <CoworkSessionList {...props} />
      </Provider>,
    );
    const browserGroup = screen.getByRole('button', { name: /^Chrome\s*2$/ });
    expect(browserGroup.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('Recent Chats')).toBeNull();

    fireEvent.click(browserGroup);
    rerender(
      <Provider store={store}>
        <CoworkSessionList
          {...props}
          sessions={browserSessions.map(session => ({ ...session, updatedAt: 5 }))}
        />
      </Provider>,
    );
    expect(browserGroup.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Browser older')).toBeNull();

    rerender(
      <Provider store={store}>
        <CoworkSessionList {...props} currentSessionId="Browser newer" />
      </Provider>,
    );
    expect(browserGroup.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Browser newer')).toBeTruthy();
  });

  it('omits the browser source group when there are no extension conversations', () => {
    render(
      <Provider store={createStore()}>
        <CoworkSessionList {...createProps([summary('Desktop chat', 1)])} />
      </Provider>,
    );
    expect(screen.queryByRole('button', { name: /^Chrome\s*\d+$/ })).toBeNull();
    expect(screen.getByText('Desktop chat')).toBeTruthy();
  });
});
