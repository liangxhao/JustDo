import { QueueListIcon } from '@heroicons/react/24/outline';
import { useLayoutEffect, useRef, useState } from 'react';

import { BrowserRecordingReview } from '@/features/browser/recording/BrowserRecordingReview';
import {
  RECORDING_REVIEW_TAB_EVENT,
  RECORDING_REVIEW_TAB_FOCUS_EVENT,
  type RecordingReviewTabEntry,
  type RecordingReviewTabEvent,
} from '@/features/browser/recording/BrowserRecordingReviewTab';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import type { CoworkDisplayTab } from './CoworkDisplayPanel';

function RecordingTabHost({
  entry,
  active,
  onDraftChange,
}: {
  entry: RecordingReviewTabEntry;
  active: boolean;
  onDraftChange: NonNullable<React.ComponentProps<typeof BrowserRecordingReview>['onDraftChange']>;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (entry.element) host.current?.appendChild(entry.element);
    return () => entry.element?.remove();
  }, [entry]);
  return (
    <div ref={host} hidden={!active} className="absolute inset-0 z-20 bg-background">
      {entry.editor && <BrowserRecordingReview {...entry.editor} onDraftChange={onDraftChange} />}
    </div>
  );
}

export function useRecordingReviewTabs(
  sessionId: string,
  select: (id: string) => void,
  open: () => void,
) {
  const [entries, setEntries] = useState<RecordingReviewTabEntry[]>([]);
  const latest = useRef({ sessionId, select, open });
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  latest.current = { sessionId, select, open };
  useLayoutEffect(() => {
    const listener = (event: Event) => {
      const { entry, open: isOpen } = (event as CustomEvent<RecordingReviewTabEvent>).detail;
      setEntries(current =>
        isOpen
          ? entry.editor && current.some(item => item.id === entry.id)
            ? current
            : [...current.filter(item => item.id !== entry.id), entry]
          : current.filter(item => item.close !== entry.close),
      );
      if (isOpen && entry.sessionId === latest.current.sessionId) {
        latest.current.select(entry.id);
        latest.current.open();
      }
    };
    window.addEventListener(RECORDING_REVIEW_TAB_EVENT, listener);
    const focus = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (
        entriesRef.current.some(
          entry => entry.id === id && entry.sessionId === latest.current.sessionId,
        )
      ) {
        latest.current.select(id);
        latest.current.open();
      }
    };
    window.addEventListener(RECORDING_REVIEW_TAB_FOCUS_EVENT, focus);
    const unsubscribe = store.subscribe(() => {
      setEntries(current => {
        const retained = current.filter(
          entry =>
            !entry.draftKey ||
            store.getState().cowork.draftBrowserRecordings[entry.draftKey]?.id ===
              entry.editor?.draft.id,
        );
        return retained.length === current.length ? current : retained;
      });
    });
    return () => {
      unsubscribe();
      window.removeEventListener(RECORDING_REVIEW_TAB_EVENT, listener);
      window.removeEventListener(RECORDING_REVIEW_TAB_FOCUS_EVENT, focus);
    };
  }, []);
  const visible = entries.filter(entry => entry.sessionId === sessionId);
  const tabs: CoworkDisplayTab[] = visible.map(entry => ({
    id: entry.id,
    label: i18nService.t('recordingReview'),
    icon: <QueueListIcon className="h-4 w-4" />,
    onSelect: () => select(entry.id),
    onClose: entry.close,
  }));
  return {
    tabs,
    panels: (activeId: string | null) =>
      entries.map(entry => (
        <RecordingTabHost
          key={entry.id}
          entry={entry}
          active={entry.sessionId === sessionId && entry.id === activeId}
          onDraftChange={draft =>
            setEntries(current =>
              current.map(item =>
                item.id === entry.id && item.editor
                  ? { ...item, editor: { ...item.editor, draft } }
                  : item,
              ),
            )
          }
        />
      )),
  };
}
