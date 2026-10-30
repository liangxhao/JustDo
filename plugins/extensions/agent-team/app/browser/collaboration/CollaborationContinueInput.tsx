import { PaperClipIcon } from '@heroicons/react/24/outline';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { application } from '../ports';
import { i18nService } from '../ui';
import { useOwnerWindow } from '../ui';
import {
  COMPOSER_FRAME_CLASS,
  COMPOSER_SURFACE_CLASS,
  COMPOSER_TEXTAREA_CLASS,
  COMPOSER_TEXTAREA_MAX_HEIGHT,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  resizeComposerTextarea,
} from '../ui';
import { LocalSpeechInputButton } from '../ui';
import { RunControlButton } from '../ui';
import { isComposerSendShortcut } from '../ui';
import {
  getContinueDraft,
  type RequestCollaborationContinue,
  settleContinueDraft,
  updateContinueDraft,
  useContinueDraft,
} from './collaborationContinueDraft';

export default function CollaborationContinueInput({
  draftKey,
  disabled,
  onRequestContinue,
}: {
  draftKey: string;
  disabled: boolean;
  onRequestContinue: RequestCollaborationContinue;
}) {
  const ownerWindow = useOwnerWindow();
  const draft = useContinueDraft(draftKey);
  const composer = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (composer.current) resizeComposerTextarea(composer.current);
  }, [draftKey, draft.text]);
  const live = useRef(true);
  const currentKey = useRef(draftKey);
  const disabledNow = useRef(disabled);
  currentKey.current = draftKey;
  disabledNow.current = disabled;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const locked = disabled || !!draft.pending || draft.status === 'unknown';
  const changeText = (text: string) => updateContinueDraft(draftKey, { text });
  const submit = async () => {
    const current = getContinueDraft(draftKey);
    if (disabled || current.pending || current.status === 'unknown' || !current.text.trim()) return;
    const request = {
      requestId: crypto.randomUUID(),
      message: current.text,
      attachmentPaths: [...current.attachments],
    };
    updateContinueDraft(draftKey, {
      pending: request,
      lastRequestId: request.requestId,
      status: undefined,
    });
    try {
      const status = await onRequestContinue(request);
      // Settle only the original draft even when the user has opened another member.
      settleContinueDraft(draftKey, request.requestId, status);
    } catch {
      // A lost response cannot establish that the member did not receive the request.
      settleContinueDraft(draftKey, request.requestId, 'unknown');
    }
  };
  return (
    <section className="space-y-2 pt-2" aria-label={i18nService.t('teamRequestContinue')}>
      <p className="text-xs text-secondary">{i18nService.t('teamContinueScope')}</p>
      {draft.status && (
        <p role="status" className="text-xs text-secondary">
          {i18nService.t(`teamContinue_${draft.status}`)}
        </p>
      )}
      {draft.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {draft.attachments.map(file => (
            <button
              key={file}
              type="button"
              disabled={locked}
              className="rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-40"
              onClick={() =>
                updateContinueDraft(draftKey, {
                  attachments: getContinueDraft(draftKey).attachments.filter(item => item !== file),
                })
              }
            >
              {file.split(/[\\/]/).pop()} ×
            </button>
          ))}
        </div>
      )}
      <div className={COMPOSER_FRAME_CLASS}>
        <div className={COMPOSER_SURFACE_CLASS}>
          <textarea
            ref={composer}
            aria-label={i18nService.t('teamContinueMessage')}
            placeholder={i18nService.t('teamContinueMessage')}
            className={`${COMPOSER_TEXTAREA_CLASS} block`}
            rows={2}
            style={{
              minHeight: COMPOSER_TEXTAREA_MIN_HEIGHT,
              maxHeight: COMPOSER_TEXTAREA_MAX_HEIGHT,
            }}
            value={draft.text}
            maxLength={16000}
            disabled={locked}
            onChange={event => changeText(event.target.value)}
            onKeyDown={event => {
              if (!locked && isComposerSendShortcut(event)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex items-center gap-1 px-3 pb-2 pt-1.5">
            <button
              type="button"
              aria-label={i18nService.t('coworkAddFile')}
              title={i18nService.t('coworkAddFile')}
              disabled={locked}
              className="rounded-lg p-1.5 text-secondary hover:bg-surface-raised disabled:opacity-40"
              onClick={() => {
                const key = draftKey;
                const epoch = getContinueDraft(key).inputEpoch;
                void application.files
                  .selectFiles({ title: i18nService.t('coworkAddFile') })
                  .then(result => {
                    const current = getContinueDraft(key);
                    if (
                      !live.current ||
                      currentKey.current !== key ||
                      disabledNow.current ||
                      current.inputEpoch !== epoch ||
                      current.pending ||
                      current.status === 'unknown' ||
                      !result.success
                    )
                      return;
                    updateContinueDraft(key, {
                      attachments: [...new Set([...current.attachments, ...result.paths])].slice(
                        0,
                        12,
                      ),
                    });
                  });
              }}
            >
              <PaperClipIcon className="h-4 w-4" />
            </button>
            <LocalSpeechInputButton
              key={`${draftKey}:${draft.inputEpoch}`}
              disabled={locked}
              onTranscript={transcript => {
                const current = getContinueDraft(draftKey);
                if (
                  !live.current ||
                  currentKey.current !== draftKey ||
                  current.pending ||
                  current.status === 'unknown' ||
                  disabledNow.current ||
                  current.inputEpoch !== draft.inputEpoch
                )
                  return;
                const start = composer.current?.selectionStart ?? current.text.length;
                const end = composer.current?.selectionEnd ?? start;
                const left = current.text.slice(0, start);
                const right = current.text.slice(end);
                const insertion =
                  (left && !/\s$/.test(left) ? ' ' : '') +
                  transcript.trim() +
                  (right && !/^\s/.test(right) ? ' ' : '');
                const next = left + insertion + right;
                if (next.length <= 16000) {
                  changeText(next);
                  ownerWindow.requestAnimationFrame(() => {
                    if (
                      !live.current ||
                      currentKey.current !== draftKey ||
                      getContinueDraft(draftKey).inputEpoch !== draft.inputEpoch
                    )
                      return;
                    composer.current?.focus();
                    composer.current?.setSelectionRange(
                      start + insertion.length,
                      start + insertion.length,
                    );
                  });
                }
              }}
            />
            <div className="ml-auto flex">
              <RunControlButton
                isRunning={false}
                isStopping={false}
                canSubmit={!locked && !!draft.text.trim()}
                size="normal"
                sendLabel={i18nService.t('teamRequestContinue')}
                sendTitle={i18nService.t('teamRequestContinue')}
                onSend={() => void submit()}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
