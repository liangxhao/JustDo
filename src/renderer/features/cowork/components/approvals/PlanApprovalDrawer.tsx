import 'katex/dist/katex.min.css';
import '../shared/documentPreview.css';

import { ClipboardDocumentCheckIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import PreviewMarkdown from '@/features/cowork/components/preview/PreviewMarkdown';
import type {
  CoworkInteractionRequest,
  CoworkInteractionResult,
} from '@/features/cowork/coworkTypes';
import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown';
import { i18nService } from '@/services/i18n';

interface PlanApprovalDrawerProps {
  interaction: CoworkInteractionRequest;
  onRespond?: (result: CoworkInteractionResult) => Promise<boolean>;
  readOnly?: boolean;
  onClose?: () => void;
  embedded?: boolean;
  isObscured?: boolean;
}

const DRAWER_DEFAULT_WIDTH = 820;
const DRAWER_MIN_WIDTH = 420;
const DRAWER_WINDOW_MARGIN = 24;
const MARKDOWN_DOCUMENT_PARSE_LIMIT = 140_000;

const clampDrawerWidth = (width: number): number => {
  const viewportMax = Math.max(DRAWER_MIN_WIDTH, window.innerWidth - DRAWER_WINDOW_MARGIN);
  return Math.min(Math.max(width, DRAWER_MIN_WIDTH), viewportMax);
};

const PlanApprovalDrawer: React.FC<PlanApprovalDrawerProps> = ({
  interaction,
  onRespond,
  readOnly = false,
  onClose,
  embedded = false,
  isObscured = false,
}) => {
  const [drawerWidth, setDrawerWidth] = useState(() => clampDrawerWidth(DRAWER_DEFAULT_WIDTH));
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const submittingRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const titleId = `plan-review-title-${interaction.requestId}`;
  const descriptionId = `plan-review-description-${interaction.requestId}`;
  const plan = useMemo(
    () => (typeof interaction.toolInput.plan === 'string' ? interaction.toolInput.plan.trim() : ''),
    [interaction.toolInput.plan],
  );
  const title =
    typeof interaction.toolInput.title === 'string' && interaction.toolInput.title.trim()
      ? interaction.toolInput.title.trim()
      : i18nService.t('planReviewTitle');
  const markdownHtml = useMemo(
    () =>
      toSanitizedMarkdownHtml(plan || i18nService.t('planReviewEmpty'), {
        parseLimit: MARKDOWN_DOCUMENT_PARSE_LIMIT,
        renderFrontmatter: true,
      }),
    [plan],
  );

  useEffect(() => {
    const handleResize = () => setDrawerWidth(current => clampDrawerWidth(current));
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!isObscured) drawerRef.current?.focus();
  }, [interaction.requestId, isObscured]);

  useEffect(() => {
    if (!drawerRef.current) return;
    (drawerRef.current as HTMLElement & { inert: boolean }).inert = isObscured;
  }, [isObscured]);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
    },
    [],
  );

  const respond = useCallback(
    async (result: CoworkInteractionResult) => {
      if (readOnly || !onRespond || submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      const success = await onRespond(result);
      if (!success) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [onRespond, readOnly],
  );

  const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const right = drawerRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    event.preventDefault();

    const handleMouseMove = (moveEvent: MouseEvent) => {
      setDrawerWidth(clampDrawerWidth(right - moveEvent.clientX));
    };
    const cleanupResize = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      resizeCleanupRef.current = null;
    };
    const handleMouseUp = () => cleanupResize();

    resizeCleanupRef.current?.();
    resizeCleanupRef.current = cleanupResize;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? 24 : -24;
    setDrawerWidth(current => clampDrawerWidth(current + delta));
  }, []);

  return (
    <aside
      ref={drawerRef}
      className={`file-preview-shell plan-approval-drawer flex max-w-full flex-col overflow-hidden ${
        embedded
          ? 'is-embedded absolute inset-0 min-h-0 min-w-0'
          : 'absolute bottom-3 right-3 top-3 z-[80]'
      } ${isObscured ? 'is-obscured' : ''}`}
      style={embedded ? undefined : { width: drawerWidth }}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={submitting}
      aria-hidden={isObscured || undefined}
      tabIndex={-1}
    >
      {!embedded && (
        <div
          className="file-preview-resize-handle"
          onMouseDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-valuemin={DRAWER_MIN_WIDTH}
          aria-valuemax={Math.max(DRAWER_MIN_WIDTH, window.innerWidth - DRAWER_WINDOW_MARGIN)}
          aria-valuenow={Math.round(drawerWidth)}
          aria-label={i18nService.t('coworkFilePreviewResize')}
          title={i18nService.t('coworkFilePreviewResize')}
        >
          <span />
        </div>
      )}

      <header className="file-preview-header">
        <div className="file-preview-titlebar">
          <div className="file-preview-file-icon" aria-hidden="true">
            <ClipboardDocumentCheckIcon />
          </div>
          <div className="file-preview-title-copy">
            <div className="file-preview-title-line">
              <h2 id={titleId} title={title}>
                {title}
              </h2>
            </div>
            <p id={descriptionId}>
              {i18nService.t(readOnly ? 'planReviewReadOnlyDescription' : 'planReviewDescription')}
            </p>
          </div>
          {readOnly && onClose && (
            <div className="file-preview-title-actions">
              <button
                type="button"
                onClick={onClose}
                className="file-preview-icon-button"
                aria-label={i18nService.t('close')}
                title={i18nService.t('close')}
              >
                <XMarkIcon />
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="file-preview-workspace">
        <div className="file-preview-preview-scroll">
          <div className="file-preview-document">
            <PreviewMarkdown html={markdownHtml} mermaidIdPrefix="plan-preview-mermaid" />
          </div>
        </div>
      </div>

      {!readOnly && (
        <div className="plan-approval-controls">
          {showFeedback && (
            <label className="plan-approval-feedback-label">
              <span>{i18nService.t('planRequestRevision')}</span>
              <textarea
                autoFocus
                value={feedback}
                onChange={event => setFeedback(event.target.value)}
                maxLength={4000}
                rows={3}
                placeholder={i18nService.t('planRevisionPlaceholder')}
                className="plan-approval-feedback"
              />
            </label>
          )}
          <div className="plan-approval-actions">
            <button
              type="button"
              onClick={() => void respond({ behavior: 'plan', decision: 'cancel' })}
              disabled={submitting}
              className="plan-approval-button"
            >
              {i18nService.t('planCancel')}
            </button>
            {showFeedback ? (
              <button
                type="button"
                onClick={() =>
                  void respond({
                    behavior: 'plan',
                    decision: 'revise',
                    feedback: feedback.trim(),
                  })
                }
                disabled={submitting || !feedback.trim()}
                className="plan-approval-button"
              >
                {i18nService.t('planSubmitRevision')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowFeedback(true)}
                disabled={submitting}
                className="plan-approval-button"
              >
                {i18nService.t('planRequestRevision')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void respond({ behavior: 'plan', decision: 'implement' })}
              disabled={submitting || !plan}
              className="plan-approval-button is-primary"
            >
              {submitting ? i18nService.t('loading') : i18nService.t('planImplement')}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
};

export default PlanApprovalDrawer;
