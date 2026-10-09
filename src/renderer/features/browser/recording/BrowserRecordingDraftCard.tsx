import './browserRecording.css';

import { PencilSquareIcon, TrashIcon, VideoCameraIcon } from '@heroicons/react/24/outline';
import type { BrowserRecordingDraft } from '@shared/browser/browserRecording';
import { useDispatch } from 'react-redux';

import {
  removeDraftBrowserRecording,
  setDraftBrowserRecording,
} from '@/features/cowork/coworkSlice';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import { recordingSummary } from './browserRecordingPresentation';
import { openDraftRecordingReviewTab } from './BrowserRecordingReviewTab';

export function BrowserRecordingDraftCard({
  draft,
  draftKey,
  textOnly,
  onTextOnly,
}: {
  draft: BrowserRecordingDraft;
  draftKey: string;
  textOnly: boolean;
  onTextOnly: (value: boolean) => void;
}) {
  const dispatch = useDispatch();
  return (
    <div className="recording-draft">
      <div className="recording-draft-row">
        <button
          type="button"
          className="recording-draft-open"
          title={i18nService.t('recordingEdit')}
          onClick={() => {
            openDraftRecordingReviewTab(draftKey, {
              draft,
              onSave: recording => {
                if (store.getState().cowork.draftBrowserRecordings[draftKey]?.id !== draft.id)
                  return;
                dispatch(setDraftBrowserRecording({ draftKey, recording }));
              },
            });
          }}
        >
          <span className="recording-brand-icon">
            <VideoCameraIcon aria-hidden="true" />
          </span>
          <span>
            <strong>{draft.title || i18nService.t('recordingReview')}</strong>
            <small>{recordingSummary(draft)}</small>
          </span>
          <PencilSquareIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className="recording-button recording-button--danger"
          aria-label={i18nService.t('recordingDiscard')}
          title={i18nService.t('recordingDiscard')}
          onClick={() => dispatch(removeDraftBrowserRecording({ draftKey, id: draft.id }))}
        >
          <TrashIcon aria-hidden="true" />
        </button>
      </div>
      {draft.images.length > 0 && (
        <label>
          <input type="checkbox" checked={textOnly} onChange={e => onTextOnly(e.target.checked)} />{' '}
          {i18nService.t('recordingTextOnly')}
        </label>
      )}
    </div>
  );
}
