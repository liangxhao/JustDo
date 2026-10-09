import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { BrowserRecordingReview } from './BrowserRecordingReview';

export const RECORDING_REVIEW_TAB_EVENT = 'cowork:recording-review-tab';
export const RECORDING_REVIEW_TAB_FOCUS_EVENT = 'cowork:recording-review-tab-focus';
export function focusRecordingReviewTab(recordingId: string, sessionId: string) {
  window.dispatchEvent(
    new CustomEvent(RECORDING_REVIEW_TAB_FOCUS_EVENT, {
      detail: `recording:${sessionId}:${recordingId}`,
    }),
  );
}
export interface RecordingReviewTabEntry {
  id: string;
  sessionId: string;
  element?: HTMLDivElement;
  draftKey?: string;
  editor?: ComponentProps<typeof BrowserRecordingReview>;
  close: () => void;
}
export type RecordingReviewTabEvent = { entry: RecordingReviewTabEntry; open: boolean };

/** Confirmed drafts are hosted independently from the currently visible composer. */
export function openDraftRecordingReviewTab(
  draftKey: string,
  props: Omit<ComponentProps<typeof BrowserRecordingReview>, 'onClose'>,
) {
  const entry: RecordingReviewTabEntry = {
    id: `recording:${draftKey}:${props.draft.id}`,
    sessionId: draftKey,
    draftKey,
    close: () =>
      window.dispatchEvent(
        new CustomEvent<RecordingReviewTabEvent>(RECORDING_REVIEW_TAB_EVENT, {
          detail: { entry, open: false },
        }),
      ),
  };
  entry.editor = {
    ...props,
    onClose: entry.close,
    onSave: draft => {
      props.onSave(draft);
      entry.close();
    },
  };
  window.dispatchEvent(
    new CustomEvent<RecordingReviewTabEvent>(RECORDING_REVIEW_TAB_EVENT, {
      detail: { entry, open: true },
    }),
  );
}

/** The editor stays mounted at its source; only its DOM is hosted in the display tab. */
export function BrowserRecordingReviewTab(props: ComponentProps<typeof BrowserRecordingReview>) {
  const [element] = useState(() => document.createElement('div'));
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const { id, sessionId } = props.draft;
  useEffect(() => {
    element.className = 'h-full min-h-0';
    const entry: RecordingReviewTabEntry = {
      id: `recording:${sessionId}:${id}`,
      sessionId,
      element,
      close: () => close.current(),
    };
    const publish = (open: boolean) =>
      window.dispatchEvent(
        new CustomEvent<RecordingReviewTabEvent>(RECORDING_REVIEW_TAB_EVENT, {
          detail: { entry, open },
        }),
      );
    publish(true);
    return () => {
      publish(false);
    };
  }, [element, id, sessionId]);
  return createPortal(<BrowserRecordingReview key={id} {...props} />, element);
}
