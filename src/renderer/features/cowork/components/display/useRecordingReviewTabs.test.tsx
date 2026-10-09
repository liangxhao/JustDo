// @vitest-environment jsdom
import type { BrowserRecordingDraft } from '@shared/browser/browserRecording';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { Provider } from 'react-redux';
import { afterEach, expect, it, vi } from 'vitest';

import { BrowserRecordingDraftCard } from '@/features/browser/recording/BrowserRecordingDraftCard';
import {
  BrowserRecordingReviewTab,
  focusRecordingReviewTab,
} from '@/features/browser/recording/BrowserRecordingReviewTab';
import {
  deleteSession,
  removeDraftBrowserRecording,
  setDraftBrowserRecording,
} from '@/features/cowork/coworkSlice';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import CoworkDisplayPanel from './CoworkDisplayPanel';
import { useRecordingReviewTabs } from './useRecordingReviewTabs';

afterEach(cleanup);
const draft: BrowserRecordingDraft = {
  id: 'r',
  sessionId: 's',
  profile: 'embedded',
  title: 'Original',
  note: '',
  startedAt: 1,
  steps: [{ id: '1', action: 'click', pageId: 'p', at: 1, url: 'https://example.com', title: '' }],
  images: [],
};

function Harness({
  sessionId = 's',
  save = vi.fn(),
  recording = draft,
}: {
  sessionId?: string;
  save?: (draft: BrowserRecordingDraft) => void;
  recording?: BrowserRecordingDraft;
}) {
  const [editing, setEditing] = useState(false);
  const [active, setActive] = useState('web');
  const [open, setOpen] = useState(false);
  const reviews = useRecordingReviewTabs(sessionId, setActive, () => setOpen(true));
  return (
    <>
      <button
        onClick={() => {
          setEditing(true);
          focusRecordingReviewTab(recording.id, recording.sessionId);
        }}
      >
        Edit
      </button>
      {editing && (
        <BrowserRecordingReviewTab
          draft={recording}
          onClose={() => setEditing(false)}
          onSave={save}
        />
      )}
      <CoworkDisplayPanel
        activeTabId={active}
        isOpen={open}
        onClose={() => setOpen(false)}
        tabs={[
          { id: 'web', label: 'Website', icon: null, onSelect: () => setActive('web') },
          ...reviews.tabs,
        ]}
      >
        {reviews.panels(active)}
      </CoworkDisplayPanel>
    </>
  );
}

it('opens an editor tab without a dialog, preserves edits across tab switches, and closes it', () => {
  i18nService.setLanguage('en');
  const save = vi.fn();
  render(<Harness save={save} />);
  fireEvent.click(screen.getByText('Edit'));
  expect(screen.queryByRole('dialog')).toBeNull();
  const editorTab = screen.getAllByRole('tab').find(tab => tab.textContent !== 'Website')!;
  expect(editorTab.getAttribute('aria-selected')).toBe('true');
  fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Changed' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Website' }));
  expect(screen.queryByRole('tabpanel')).toBeNull();
  fireEvent.click(editorTab);
  expect(screen.getByDisplayValue('Changed')).toBeTruthy();
  fireEvent.click(screen.getByText('Save changes'));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: 'Changed' }));
  fireEvent.click(screen.getByRole('button', { name: `Close: ${editorTab.textContent}` }));
  expect(screen.queryByRole('tabpanel')).toBeNull();
  expect(screen.getAllByRole('tab')).toHaveLength(1);
});

it('hides the source session editor in other sessions and restores it on return', () => {
  const view = render(<Harness />);
  fireEvent.click(screen.getByText('Edit'));
  fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Retained' } });
  view.rerender(<Harness sessionId="other" />);
  expect(screen.queryByRole('tabpanel')).toBeNull();
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  view.rerender(<Harness />);
  expect(screen.getByDisplayValue('Retained')).toBeTruthy();
});

it('reactivates an existing editor from its source without discarding edits', () => {
  render(<Harness />);
  fireEvent.click(screen.getByText('Edit'));
  fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Retained' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Website' }));
  expect(screen.queryByRole('tabpanel')).toBeNull();
  fireEvent.click(screen.getByText('Edit'));
  expect(screen.getByRole('tabpanel')).toBeTruthy();
  expect(screen.getByDisplayValue('Retained')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkDisplayPanelClose') }));
  expect(screen.queryByRole('tabpanel')).toBeNull();
  fireEvent.click(screen.getByText('Edit'));
  expect(screen.getByRole('tabpanel')).toBeTruthy();
});

it('does not save the previous recording into a replacement source session', () => {
  const save = vi.fn();
  const view = render(<Harness save={save} />);
  fireEvent.click(screen.getByText('Edit'));
  fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Session A edits' } });
  view.rerender(
    <Harness
      sessionId="other"
      recording={{ ...draft, id: 'other', sessionId: 'other', title: 'Session B' }}
      save={save}
    />,
  );
  expect(screen.queryByDisplayValue('Session A edits')).toBeNull();
  fireEvent.click(screen.getByText('Save changes'));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'other', sessionId: 'other', title: 'Session B' }),
  );
});

function ComposerHarness({
  source,
  showPanel = true,
}: {
  source: BrowserRecordingDraft;
  showPanel?: boolean;
}) {
  const [active, setActive] = useState('web');
  const reviews = useRecordingReviewTabs(source.sessionId, setActive, () => {});
  return (
    <Provider store={store}>
      <BrowserRecordingDraftCard
        key={`${source.sessionId}:${source.id}`}
        draft={source}
        draftKey={source.sessionId}
        textOnly={false}
        onTextOnly={() => {}}
      />
      {showPanel && (
        <CoworkDisplayPanel activeTabId={active} isOpen onClose={() => {}} tabs={reviews.tabs}>
          {reviews.panels(active)}
        </CoworkDisplayPanel>
      )}
    </Provider>
  );
}

it('preserves edits and updates the save destination when a recording session is promoted', () => {
  const save = vi.fn();
  const view = render(
    <StrictMode>
      <Harness save={save} />
    </StrictMode>,
  );
  fireEvent.click(screen.getByText('Edit'));
  fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Before promotion' } });
  view.rerender(
    <StrictMode>
      <Harness sessionId="promoted" recording={{ ...draft, sessionId: 'promoted' }} save={save} />
    </StrictMode>,
  );
  expect(screen.getByDisplayValue('Before promotion')).toBeTruthy();
  fireEvent.click(screen.getByText('Save changes'));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'promoted', title: 'Before promotion' }),
  );
});

it('retains unsaved edits when the actual source card unmounts and saves only to its source', () => {
  const other = { ...draft, id: 'other', sessionId: 'other', title: 'Other' };
  store.dispatch(setDraftBrowserRecording({ draftKey: 's', recording: draft }));
  store.dispatch(setDraftBrowserRecording({ draftKey: 'other', recording: other }));
  const view = render(
    <StrictMode>
      <ComposerHarness source={draft} />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Original/ }));
  fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Retained edits' } });
  view.rerender(
    <StrictMode>
      <ComposerHarness source={other} showPanel={false} />
    </StrictMode>,
  );
  expect(screen.queryByRole('tabpanel')).toBeNull();
  view.rerender(
    <StrictMode>
      <ComposerHarness source={draft} />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Original/ }));
  expect(screen.getByDisplayValue('Retained edits')).toBeTruthy();
  fireEvent.click(screen.getByText('Save changes'));
  expect(store.getState().cowork.draftBrowserRecordings.s.title).toBe('Retained edits');
  expect(store.getState().cowork.draftBrowserRecordings.other.title).toBe('Other');
  expect(screen.queryByRole('tabpanel')).toBeNull();
});

it.each(['send', 'delete'])('cleans a detached draft editor after %s', action => {
  store.dispatch(removeDraftBrowserRecording({ draftKey: 's', id: 'r' }));
  store.dispatch(setDraftBrowserRecording({ draftKey: 's', recording: draft }));
  render(<ComposerHarness source={draft} />);
  fireEvent.click(screen.getByRole('button', { name: /^Original/ }));
  expect(screen.getByRole('tabpanel')).toBeTruthy();
  act(() => {
    store.dispatch(
      action === 'send'
        ? removeDraftBrowserRecording({ draftKey: 's', id: 'r' })
        : deleteSession('s'),
    );
  });
  expect(screen.queryByRole('tabpanel')).toBeNull();
});
