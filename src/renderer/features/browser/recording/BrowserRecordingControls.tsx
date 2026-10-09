import { PauseIcon, PlayIcon, StopIcon, VideoCameraIcon } from '@heroicons/react/24/outline';
import { RecordingStatus } from '@shared/browser/browserRecording';
import { useState } from 'react';

import { setDraftBrowserRecording } from '@/features/cowork/coworkSlice';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import {
  browserToolbarButtonClassName,
  browserToolbarGroupClassName,
} from '../browserToolbarStyles';
import { BrowserRecordingReviewTab, focusRecordingReviewTab } from './BrowserRecordingReviewTab';
import type { useBrowserRecording } from './useBrowserRecording';

export function BrowserRecordingControls({
  recorder,
  disabled,
}: {
  recorder: ReturnType<typeof useBrowserRecording>;
  disabled: boolean;
}) {
  const [reviewOpen, setReviewOpen] = useState(true);
  const t = (key: string) => i18nService.t(key);
  const s = recorder.session;
  if (!s)
    return (
      <span className={`${browserToolbarGroupClassName} text-xs`}>
        <button
          type="button"
          aria-label={t('recordingStart')}
          title={t(disabled ? 'recordingUnavailable' : 'recordingStart')}
          disabled={disabled || recorder.busy}
          onClick={() => {
            setReviewOpen(true);
            void recorder.start();
          }}
          className={browserToolbarButtonClassName(false)}
        >
          <VideoCameraIcon className="h-4 w-4" />
        </button>
        {recorder.failed && <span role="alert">{t('recordingFailed')}</span>}
      </span>
    );
  return (
    <div className={`${browserToolbarGroupClassName} text-xs`}>
      <span
        className={`px-1.5 tabular-nums ${s.status === RecordingStatus.Recording ? 'text-red-500' : 'text-secondary'}`}
      >
        {s.steps.length}
      </span>
      {s.status !== RecordingStatus.Review ? (
        <>
          <button
            type="button"
            className={browserToolbarButtonClassName(s.status === RecordingStatus.Paused)}
            aria-label={t(
              s.status === RecordingStatus.Paused ? 'recordingResume' : 'recordingPause',
            )}
            title={t(s.status === RecordingStatus.Paused ? 'recordingResume' : 'recordingPause')}
            onClick={() =>
              s.status === RecordingStatus.Paused ? recorder.resume() : void recorder.pause()
            }
          >
            {s.status === RecordingStatus.Paused ? (
              <PlayIcon className="h-4 w-4" />
            ) : (
              <PauseIcon className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            className={browserToolbarButtonClassName(false)}
            aria-label={t('recordingStop')}
            title={t('recordingStop')}
            onClick={() => {
              setReviewOpen(true);
              void recorder.stop();
            }}
          >
            <StopIcon className="h-4 w-4" />
          </button>
        </>
      ) : (
        <button
          type="button"
          className={`${browserToolbarButtonClassName(false)} w-auto px-2`}
          onClick={() => {
            setReviewOpen(true);
            focusRecordingReviewTab(s.id, s.sessionId);
          }}
        >
          {t('recordingReview')}
        </button>
      )}
      {s.status === RecordingStatus.Review && reviewOpen && (
        <BrowserRecordingReviewTab
          draft={s}
          onClose={() => setReviewOpen(false)}
          onDiscard={recorder.clear}
          saveLabel="recordingAdd"
          onSave={draft => {
            const existing = store.getState().cowork.draftBrowserRecordings?.[s.sessionId];
            if (existing) {
              window.dispatchEvent(
                new CustomEvent('app:showToast', { detail: t('recordingExisting') }),
              );
              return;
            }
            store.dispatch(setDraftBrowserRecording({ draftKey: s.sessionId, recording: draft }));
            recorder.clear();
          }}
        />
      )}
    </div>
  );
}
