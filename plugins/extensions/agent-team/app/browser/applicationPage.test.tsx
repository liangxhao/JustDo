// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { AgentTeamEntry } from './navigation';
import { useOwnerDocument } from './ui';

const fixture = vi.hoisted(() => ({
  setEntry: undefined as unknown as (entry: AgentTeamEntry | null) => void,
  dismiss: undefined as unknown as () => void,
  openWorkspace: vi.fn(),
  prepareSource: vi.fn(),
  appendDraft: vi.fn(),
  openHistory: vi.fn(),
  history: undefined as unknown as {
    onOpen(
      entry: import('./display/agentTeamHistory').AgentTeamHistoryEntry,
      isCurrent: () => boolean,
    ): Promise<void>;
  },
  discussion: undefined as unknown as {
    active?: boolean;
    onPrepareSourceDraft?(sessionId: string, draft: string): Promise<void>;
  },
}));
vi.mock('./ports', () => ({
  browserHost: () => host,
  application: { metadata: { getSnapshot: () => ({ cowork: {} }) } },
}));
vi.mock('./discussions/TeamDiscussionView', () => ({
  useAgentTeamEntry: () => {
    const state = useState<AgentTeamEntry | null>(null);
    fixture.setEntry = state[1];
    return state;
  },
  default: (props: {
    active?: boolean;
    onClose(): void;
    onPrepareSourceDraft?(sessionId: string, draft: string): Promise<void>;
  }) => {
    fixture.discussion = props;
    return (
      <section aria-label="Standalone discussion">
        <button onClick={props.onClose}>Close discussion</button>
      </section>
    );
  },
}));
vi.mock('./discussions/teamDiscussionNavigation', () => ({
  OPEN_TEAM_PANEL: 'cowork:open-team-panel',
  TEAM_ROOM_FOCUSED: 'cowork:team-room-focused',
  prepareDiscussionSource: fixture.prepareSource,
}));
vi.mock('./discussions/teamResultDraft', () => ({
  appendDiscussionReference: vi.fn(),
  appendTeamResultDraft: fixture.appendDraft,
}));
vi.mock('./display/agentTeamHistory', () => ({
  OPEN_TEAM_RECORDS: 'cowork:open-team-records',
  openTeamHistoryEntry: fixture.openHistory,
}));
vi.mock('./display/AgentTeamHistoryDialog', () => ({
  default: function HistoryDialog(props: typeof fixture.history) {
    fixture.history = props;
    return createPortal(<div role="dialog">History</div>, useOwnerDocument().body);
  },
}));
import { TeamApplicationPage } from './applicationPage';

const host = {
  openWorkspace: fixture.openWorkspace,
  signal: new AbortController().signal,
  t: (key: string) => key,
  interactionContextChanged: vi.fn(),
  onNavigation: (listener: () => void) => {
    fixture.dismiss = listener;
    return () => undefined;
  },
};
const navigation = { showChat: vi.fn(), requestTransition: vi.fn() };
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  document.querySelector('[data-history-owner]')?.remove();
});

test('keeps source-linked history navigation in the right workspace tab', () => {
  const setVisible = vi.fn();
  render(<TeamApplicationPage navigation={navigation} page={{ setVisible }} active={false} />);
  act(() =>
    window.dispatchEvent(
      new CustomEvent('cowork:open-team-panel', {
        detail: { sessionId: 'source', roomId: 'room' },
      }),
    ),
  );
  expect(fixture.openWorkspace).toHaveBeenCalledExactlyOnceWith('team', 'source', {
    key: 'group:room',
    version: expect.any(Number),
  });
  expect(navigation.showChat).toHaveBeenCalledOnce();
  expect(screen.queryByRole('region', { name: 'Standalone discussion' })).toBeNull();
  expect(setVisible).not.toHaveBeenCalledWith(true);
});
test('renders retained source-less history as a normal page and returns to chat on close', () => {
  const setVisible = vi.fn();
  const view = render(<TeamApplicationPage navigation={navigation} page={{ setVisible }} active />);
  act(() => fixture.setEntry({ roomId: 'retained-room' }));
  expect(setVisible).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('region', { name: 'Standalone discussion' })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(fixture.openWorkspace).not.toHaveBeenCalled();
  view.rerender(
    <TeamApplicationPage navigation={navigation} page={{ setVisible }} active={false} />,
  );
  expect(fixture.discussion.active).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Close discussion' }));
  expect(setVisible).toHaveBeenLastCalledWith(false);
  expect(screen.queryByRole('region', { name: 'Standalone discussion' })).toBeNull();
});
test('clears standalone history when normal application navigation resumes', () => {
  const setVisible = vi.fn();
  render(<TeamApplicationPage navigation={navigation} page={{ setVisible }} active />);
  act(() => fixture.setEntry({ roomId: 'retained-room' }));
  act(() => window.dispatchEvent(new CustomEvent('cowork:open-team-records')));
  expect(screen.getByRole('dialog')).toBeTruthy();
  act(() => fixture.dismiss());
  expect(setVisible).toHaveBeenLastCalledWith(false);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Standalone discussion' })).toBeNull();
});
test('preserves a standalone page across settings while retiring its pending navigation', async () => {
  const setVisible = vi.fn();
  const originNavigation = { ...navigation, revision: 1 };
  const view = render(
    <TeamApplicationPage navigation={originNavigation} page={{ setVisible }} active />,
  );
  act(() => fixture.setEntry({ roomId: 'retained-room' }));
  act(() => window.dispatchEvent(new CustomEvent('cowork:open-team-records')));
  let isCurrent!: () => boolean;
  let finish!: () => void;
  fixture.prepareSource.mockImplementationOnce(async (_id, options, commit) => {
    isCurrent = options.isCurrent;
    await new Promise<void>(resolve => {
      finish = resolve;
    });
    if (isCurrent()) commit();
  });
  const pending = fixture.discussion.onPrepareSourceDraft!('source', 'Reference this result');
  expect(isCurrent()).toBe(true);
  view.rerender(
    <TeamApplicationPage
      navigation={{ ...navigation, revision: 2 }}
      page={{ setVisible }}
      active={false}
    />,
  );
  expect(fixture.discussion.active).toBe(false);
  expect(isCurrent()).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => {
    finish();
    await pending;
  });
  expect(fixture.appendDraft).not.toHaveBeenCalled();
  expect(setVisible).toHaveBeenLastCalledWith(true);
  view.rerender(
    <TeamApplicationPage
      navigation={{ ...navigation, revision: 3 }}
      page={{ setVisible }}
      active
    />,
  );
  expect(fixture.discussion.active).toBe(true);
  expect(screen.getByRole('region', { name: 'Standalone discussion' })).toBeTruthy();
});

test('binds history to the requesting Document and retires it on window closure or navigation', async () => {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('data-history-owner', 'true');
  document.body.append(iframe);
  const ownerDocument = iframe.contentDocument!;
  const ownerWindow = iframe.contentWindow!;
  const view = render(<TeamApplicationPage navigation={{ ...navigation, revision: 1 }} />);
  const openRecords = () => {
    window.dispatchEvent(
      new CustomEvent('cowork:open-team-records', {
        detail: ownerDocument,
      }),
    );
  };
  act(openRecords);
  expect(within(ownerDocument.body).getByRole('dialog')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();

  let isCurrent!: () => boolean;
  let finish!: () => void;
  const commit = vi.fn();
  fixture.openHistory.mockImplementationOnce(async (_entry, options) => {
    isCurrent = options.isCurrent;
    await new Promise<void>(resolve => {
      finish = resolve;
    });
    if (isCurrent()) commit();
  });
  const pending = fixture.history.onOpen(
    {
      id: 'history-record',
    } as import('./display/agentTeamHistory').AgentTeamHistoryEntry,
    () => true,
  );
  expect(isCurrent()).toBe(true);
  act(() => ownerWindow.dispatchEvent(new Event('pagehide')));
  expect(within(ownerDocument.body).queryByRole('dialog')).toBeNull();
  expect(isCurrent()).toBe(false);
  await act(async () => {
    finish();
    await pending;
  });
  expect(commit).not.toHaveBeenCalled();

  act(openRecords);
  expect(within(ownerDocument.body).getByRole('dialog')).toBeTruthy();
  view.rerender(<TeamApplicationPage navigation={{ ...navigation, revision: 2 }} />);
  expect(within(ownerDocument.body).queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});
