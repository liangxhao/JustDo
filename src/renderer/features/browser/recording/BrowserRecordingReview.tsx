import './browserRecording.css';

import {
  ArrowDownTrayIcon,
  ArrowRightIcon,
  ArrowTopRightOnSquareIcon,
  Bars3BottomLeftIcon,
  ChatBubbleLeftEllipsisIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeBracketIcon,
  CursorArrowRaysIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  InformationCircleIcon,
  KeyIcon,
  PhotoIcon,
  ShieldCheckIcon,
  TrashIcon,
  VideoCameraIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { BrowserRecordingDraft, BrowserRecordingStep } from '@shared/browser/browserRecording';
import {
  hasRecordingValue,
  RecordingAction,
  serializeRecording,
} from '@shared/browser/browserRecording';
import { useId, useState } from 'react';

import { IMAGE_PREVIEW_EVENT } from '@/features/cowork/components/preview/imageFilePreview';
import { i18nService } from '@/services/i18n';

import {
  hasRecordingElement,
  recordingActionValue,
  recordingElementKind,
  recordingEvidenceRows,
  recordingPageLabel,
  recordingSummary,
  recordingTargetLabel,
} from './browserRecordingPresentation';

function ActionIcon({ action }: { action: BrowserRecordingStep['action'] }) {
  const Icon =
    action === RecordingAction.Input
      ? Bars3BottomLeftIcon
      : action === RecordingAction.Key
        ? KeyIcon
        : [RecordingAction.Navigate, RecordingAction.OpenTab, RecordingAction.SwitchTab].includes(
              action as 'navigate',
            )
          ? ArrowTopRightOnSquareIcon
          : CursorArrowRaysIcon;
  return <Icon aria-hidden="true" />;
}

function StepDetails({ step }: { step: BrowserRecordingStep }) {
  const t = (key: string) => i18nService.t(key);
  return (
    <div className="recording-details-group">
      {hasRecordingElement(step) && (
        <details className="recording-disclosure">
          <summary>
            <CodeBracketIcon aria-hidden="true" />
            {t('recordingElementDetails')}
            <ChevronDownIcon className="recording-chevron" aria-hidden="true" />
          </summary>
          <div className="recording-detail-body">
            <div className="recording-element-preview">
              <span className="recording-element-tag">{recordingElementKind(step)}</span>
              <div>
                <strong>{step.target!.name || t('recordingUnnamedElement')}</strong>
                <p className="recording-element-hint">{t('recordingElementHint')}</p>
              </div>
            </div>
            <div className="recording-technical">
              <dl className="recording-properties">
                {recordingEvidenceRows(step).map(row => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
                {step.target!.role && (
                  <div>
                    <dt>{t('recordingElementRole')}</dt>
                    <dd>{step.target!.role}</dd>
                  </div>
                )}
                {step.target!.selector && (
                  <div>
                    <dt>{t('recordingSelector')}</dt>
                    <dd>
                      <code>{step.target!.selector}</code>
                    </dd>
                  </div>
                )}
                {step.target!.frameUrl && (
                  <div>
                    <dt>{t('recordingFrame')}</dt>
                    <dd>{step.target!.frameUrl}</dd>
                  </div>
                )}
              </dl>
              {step.target!.html ? (
                <div className="recording-code">
                  <div>
                    <CodeBracketIcon aria-hidden="true" />
                    <span>{t('recordingHtml')}</span>
                  </div>
                  <pre>
                    <code>{step.target!.html}</code>
                  </pre>
                </div>
              ) : (
                <p className="recording-muted">{t('recordingHtmlMissing')}</p>
              )}
            </div>
          </div>
        </details>
      )}
      <details className="recording-disclosure recording-disclosure--page">
        <summary>
          <GlobeAltIcon aria-hidden="true" />
          {t('recordingPageDetails')}
          <ChevronDownIcon className="recording-chevron" aria-hidden="true" />
        </summary>
        <dl className="recording-properties recording-detail-body">
          {step.title && (
            <div>
              <dt>{t('recordingPageTitle')}</dt>
              <dd>{step.title}</dd>
            </div>
          )}
          <div>
            <dt>{t('recordingPageUrl')}</dt>
            <dd>{step.url || t('recordingUnavailableValue')}</dd>
          </div>
        </dl>
      </details>
      {!hasRecordingElement(step) && !step.sensitive && (
        <p className="recording-no-element">
          {t(
            [
              RecordingAction.Click,
              RecordingAction.Input,
              RecordingAction.Select,
              RecordingAction.DoubleClick,
            ].includes(step.action as 'click')
              ? 'recordingElementMissing'
              : 'recordingPageOnly',
          )}
        </p>
      )}
    </div>
  );
}

export function BrowserRecordingReview({
  draft,
  onSave,
  onClose,
  onDiscard,
  saveLabel = 'recordingSave',
  onDraftChange,
}: {
  draft: BrowserRecordingDraft;
  onSave: (draft: BrowserRecordingDraft) => void;
  onClose: () => void;
  onDiscard?: () => void;
  saveLabel?: string;
  onDraftChange?: (draft: BrowserRecordingDraft) => void;
}) {
  const [edited, setEditedState] = useState(draft);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const privacyId = useId();
  const setEdited = (next: BrowserRecordingDraft) => {
    setEditedState(next);
    onDraftChange?.(next);
  };
  const updateStep = (id: string, changes: Partial<BrowserRecordingStep>) =>
    setEdited({
      ...edited,
      steps: edited.steps.map(step => (step.id === id ? { ...step, ...changes } : step)),
    });
  let exceedsLimit = false;
  let detailLimited = false;
  try {
    detailLimited = JSON.parse(serializeRecording(edited)).detailLimited === true;
  } catch {
    exceedsLimit = true;
  }
  const t = (key: string) => i18nService.t(key);
  const previewImage = (src: string, index: number) => {
    window.dispatchEvent(
      new CustomEvent(IMAGE_PREVIEW_EVENT, {
        detail: { src, alt: `${t('recordingScreenshot')} ${index + 1}` },
      }),
    );
  };
  const notices = [
    detailLimited && 'recordingDetailBudget',
    edited.limited && 'recordingLimited',
    edited.incomplete && 'recordingIncomplete',
    edited.screenshotWarning && 'recordingImagesSkipped',
  ].filter(Boolean) as string[];
  return (
    <section role="tabpanel" aria-label={t('recordingReview')} className="recording-editor">
      <header className="recording-editor-header">
        <div className="recording-heading-row">
          <span className="recording-brand-icon">
            <VideoCameraIcon aria-hidden="true" />
          </span>
          <div className="recording-heading">
            <h2>{t('recordingReview')}</h2>
            <p>{t('recordingReviewSubtitle')}</p>
          </div>
          <button
            type="button"
            className="recording-icon-button"
            aria-label={t('recordingClose')}
            title={t('recordingClose')}
            onClick={onClose}
          >
            <XMarkIcon aria-hidden="true" />
          </button>
        </div>
        <div className="recording-summary-row">
          <span className="recording-count">
            <DocumentTextIcon aria-hidden="true" />
            {recordingSummary(edited)}
          </span>
          <button
            type="button"
            className="recording-help"
            aria-expanded={showPrivacy}
            aria-controls={privacyId}
            onClick={() => setShowPrivacy(open => !open)}
          >
            <ShieldCheckIcon aria-hidden="true" />
            {t('recordingPrivacyTitle')}
            <ChevronDownIcon aria-hidden="true" />
          </button>
        </div>
        <p id={privacyId} className="recording-help-content" hidden={!showPrivacy}>
          {t('recordingPrivacy')}
        </p>
        {exceedsLimit && (
          <p className="recording-notice" role="alert">
            {t('recordingContextLimit')}
          </p>
        )}
        {notices.length > 0 && (
          <details className="recording-notice">
            <summary>
              <InformationCircleIcon aria-hidden="true" />
              {t('recordingReviewNotice')}
              <ChevronDownIcon aria-hidden="true" />
            </summary>
            <div role="status">
              {notices.map(key => (
                <p key={key}>{t(key)}</p>
              ))}
            </div>
          </details>
        )}
      </header>
      <div className="recording-editor-scroll">
        <div className="recording-metadata">
          <label>
            <span>{t('recordingTitle')}</span>
            <input
              className="recording-title-input"
              aria-label={t('recordingTitle')}
              maxLength={160}
              value={edited.title}
              onChange={event => setEdited({ ...edited, title: event.target.value })}
              placeholder={t('recordingTitlePlaceholder')}
            />
          </label>
          <textarea
            aria-label={t('recordingNote')}
            rows={2}
            maxLength={2000}
            value={edited.note}
            onChange={event => setEdited({ ...edited, note: event.target.value })}
            placeholder={t('recordingNotePlaceholder')}
          />
        </div>
        <div className="recording-section-label">
          <span>{t('recordingSteps')}</span>
          <span>{t('recordingEditable')}</span>
        </div>
        <ol className="recording-steps">
          {edited.steps.map((step, index) => (
            <li key={step.id} className="recording-step">
              <div className="recording-step-heading">
                <span className="recording-step-number">{String(index + 1).padStart(2, '0')}</span>
                <div className="recording-step-title">
                  <span className="recording-action-label">
                    <ActionIcon action={step.action} />
                    {t(`recording${step.action}`)}
                  </span>
                  <h3 title={recordingTargetLabel(step)}>{recordingTargetLabel(step)}</h3>
                </div>
                <button
                  type="button"
                  className="recording-button recording-button--danger recording-delete-step"
                  title={t('recordingRemove')}
                  aria-label={`${t('recordingRemove')} ${index + 1}`}
                  onClick={() =>
                    setEdited({
                      ...edited,
                      steps: edited.steps.filter(item => item.id !== step.id),
                      images: edited.images.filter(image => image.stepId !== step.id),
                    })
                  }
                >
                  <TrashIcon aria-hidden="true" />
                  <span>{t('recordingRemove')}</span>
                </button>
              </div>
              <div className="recording-step-body">
                <div className="recording-step-content">
                  <div className="recording-source">
                    <GlobeAltIcon aria-hidden="true" />
                    <span>{recordingPageLabel(step)}</span>
                    {step.target?.tag && !step.sensitive && <code>&lt;{step.target.tag}&gt;</code>}
                  </div>
                  {step.sensitive ? (
                    <p className="recording-password">
                      <ShieldCheckIcon aria-hidden="true" />
                      {t('recordingSensitive')}
                    </p>
                  ) : (
                    hasRecordingValue(step) && (
                      <label className="recording-step-value" data-action={step.action}>
                        <span>{recordingActionValue(step).label}</span>
                        {step.action === RecordingAction.Input ? (
                          <input
                            aria-label={`${t('recordingValue')} ${index + 1}`}
                            maxLength={2000}
                            value={step.value}
                            onChange={event =>
                              setEdited({
                                ...edited,
                                steps: edited.steps.map(item =>
                                  item.id === step.id
                                    ? {
                                        ...item,
                                        value: event.target.value,
                                        interaction: undefined,
                                        target: item.target
                                          ? {
                                              ...item.target,
                                              state: {
                                                ...item.target.state,
                                                value: event.target.value,
                                              },
                                            }
                                          : undefined,
                                      }
                                    : item,
                                ),
                                images: edited.images.filter(image => image.stepId !== step.id),
                              })
                            }
                          />
                        ) : (
                          <output className="recording-readable-value">
                            {recordingActionValue(step).text}
                          </output>
                        )}
                        {recordingActionValue(step).hint && (
                          <small className="recording-value-hint">
                            {recordingActionValue(step).hint}
                          </small>
                        )}
                      </label>
                    )
                  )}
                  <StepDetails step={step} />
                  {step.screenshotIssue && (
                    <p className="recording-image-notice">
                      <PhotoIcon aria-hidden="true" />
                      {t(`recordingScreenshot${step.screenshotIssue}`)}
                    </p>
                  )}
                  <label className="recording-step-note">
                    <ChatBubbleLeftEllipsisIcon aria-hidden="true" />
                    <input
                      aria-label={`${t('recordingStepNote')} ${index + 1}`}
                      maxLength={2000}
                      placeholder={t('recordingStepNotePlaceholder')}
                      value={step.note ?? ''}
                      onChange={event => updateStep(step.id, { note: event.target.value })}
                    />
                  </label>
                </div>
                {edited.images.some(image => image.stepId === step.id) && (
                  <div className="recording-step-images">
                    {edited.images
                      .filter(image => image.stepId === step.id)
                      .map(image => (
                        <figure className="recording-screenshot" key={image.fileName}>
                          <img
                            src={image.dataUrl}
                            alt={`${t('recordingScreenshot')} ${index + 1}`}
                            title={t('recordingImageDoubleClick')}
                            tabIndex={0}
                            onDoubleClick={() => previewImage(image.dataUrl, index)}
                            onKeyDown={event => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                previewImage(image.dataUrl, index);
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="recording-screenshot-delete"
                            aria-label={t('recordingRemoveImage')}
                            title={t('recordingRemoveImage')}
                            onClick={() =>
                              setEdited({
                                ...edited,
                                images: edited.images.filter(
                                  item => item.fileName !== image.fileName,
                                ),
                              })
                            }
                          >
                            <XMarkIcon aria-hidden="true" />
                          </button>
                        </figure>
                      ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        {!edited.steps.length && (
          <div className="recording-empty">
            <DocumentTextIcon aria-hidden="true" />
            <p>{t('recordingEmpty')}</p>
          </div>
        )}
      </div>
      <footer className="recording-editor-footer">
        <span className="recording-footer-hint">
          <CheckIcon aria-hidden="true" />
          {t('recordingSendHint')}
        </span>
        <div>
          {onDiscard && (
            <button
              type="button"
              className="recording-button recording-button--danger"
              onClick={onDiscard}
            >
              <TrashIcon aria-hidden="true" />
              {t('recordingDiscard')}
            </button>
          )}
          <button
            type="button"
            disabled={!edited.steps.length || exceedsLimit}
            className="recording-button recording-button--primary"
            onClick={() => onSave({ ...edited, sessionId: draft.sessionId })}
          >
            {saveLabel === 'recordingSave' ? (
              <ArrowDownTrayIcon aria-hidden="true" />
            ) : (
              <ArrowRightIcon aria-hidden="true" />
            )}
            {t(saveLabel)}
          </button>
        </div>
      </footer>
    </section>
  );
}
