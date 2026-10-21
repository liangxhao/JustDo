import type { BrowserRecordingDraft } from '@shared/browser/browserRecording';
import { hasRecordingValue } from '@shared/browser/browserRecording';
import { html, nothing } from 'lit';

import {
  hasRecordingElement,
  recordingActionValue,
  recordingElementKind,
  recordingEvidenceRows,
  recordingPageLabel,
  recordingSummary,
  recordingTargetLabel,
} from '@/features/browser/recording/browserRecordingPresentation';
import { i18nService } from '@/services/i18n';

const icon = (path: string) =>
  html`<svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d=${path}></path>
  </svg>`;
const VIDEO = icon(
  'M15 9l6-4v14l-6-4M4 5h10a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z',
);
const CHEVRON = icon('M6 9l6 6 6-6');
const GLOBE = icon('M21 12a9 9 0 11-18 0 9 9 0 0118 0M3 12h18M12 3c4 4 4 14 0 18-4-4-4-14 0-18');
const CODE = icon('M8 7l-5 5 5 5m8-10l5 5-5 5m-3-13l-2 16');
const PHOTO = icon('M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M16 8h.01');

/** External page HTML is always escaped text, never executable markup. */
export function renderBrowserRecording(recording: BrowserRecordingDraft) {
  const t = (key: string) => i18nService.t(key);
  return html`<details
    class="recording-message"
    aria-label=${recording.title || t('recordingReview')}
  >
    <summary>
      <span class="recording-brand-icon">${VIDEO}</span
      ><span class="recording-message-heading"
        ><strong>${recording.title || t('recordingReview')}</strong
        ><small>${recordingSummary(recording, true)}</small></span
      ><span class="recording-chevron">${CHEVRON}</span>
    </summary>
    <div class="recording-message-body">
      ${recording.note ? html`<p class="recording-message-note">${recording.note}</p>` : nothing}
      <ol class="recording-message-timeline">
        ${recording.steps.map(
          (step, index) =>
            html`<li>
              <span class="recording-step-number">${String(index + 1).padStart(2, '0')}</span>
              <div class="recording-message-step">
                <span class="recording-action-label">${t(`recording${step.action}`)}</span>
                <h4>${recordingTargetLabel(step)}</h4>
                <div class="recording-source">
                  ${GLOBE}<span>${recordingPageLabel(step)}</span>${step.target?.tag && !step.sensitive ? html`<code>&lt;${step.target.tag}&gt;</code>` : nothing}
                </div>
                ${step.sensitive ? html`<p class="recording-message-value">${t('recordingSensitive')}</p>` : hasRecordingValue(step) ? html`<div class="recording-message-value"><span class="recording-value-label">${recordingActionValue(step).label}</span><span>${recordingActionValue(step).text}</span>${recordingActionValue(step).hint ? html`<small class="recording-value-hint">${recordingActionValue(step).hint}</small>` : nothing}</div>` : nothing}
                ${step.note ? html`<p class="recording-message-step-note">${step.note}</p>` : nothing}
                ${
                  hasRecordingElement(step)
                    ? html`<details class="recording-disclosure">
                        <summary>
                          ${CODE}${t('recordingElementDetails')}<span class="recording-chevron"
                            >${CHEVRON}</span
                          >
                        </summary>
                        <div class="recording-detail-body">
                          <div class="recording-element-preview">
                            <span class="recording-element-tag">${recordingElementKind(step)}</span>
                            <div>
                              <strong>${step.target!.name || t('recordingUnnamedElement')}</strong>
                              <p class="recording-element-hint">${t('recordingElementHint')}</p>
                            </div>
                          </div>
                          <div class="recording-technical">
                            <dl class="recording-properties">
                              ${recordingEvidenceRows(step).map(
                                row =>
                                  html`<div>
                                    <dt>${row.label}</dt>
                                    <dd>${row.value}</dd>
                                  </div>`,
                              )}
                              ${
                                step.target!.role
                                  ? html`<div>
                                      <dt>${t('recordingElementRole')}</dt>
                                      <dd>${step.target!.role}</dd>
                                    </div>`
                                  : nothing
                              }
                              ${
                                step.target!.selector
                                  ? html`<div>
                                      <dt>${t('recordingSelector')}</dt>
                                      <dd><code>${step.target!.selector}</code></dd>
                                    </div>`
                                  : nothing
                              }
                              ${
                                step.target!.frameUrl
                                  ? html`<div>
                                      <dt>${t('recordingFrame')}</dt>
                                      <dd>${step.target!.frameUrl}</dd>
                                    </div>`
                                  : nothing
                              }
                            </dl>
                            ${
                              step.target!.html
                                ? html`<div class="recording-code">
                                    <div>${CODE}${t('recordingHtml')}</div>
                                    <pre><code>${step.target!.html}</code></pre>
                                  </div>`
                                : html`<p class="recording-muted">${t('recordingHtmlMissing')}</p>`
                            }
                          </div>
                        </div>
                      </details>`
                    : nothing
                }
                <details class="recording-disclosure recording-disclosure--page">
                  <summary>
                    ${GLOBE}${t('recordingPageDetails')}<span class="recording-chevron"
                      >${CHEVRON}</span
                    >
                  </summary>
                  <dl class="recording-properties recording-detail-body">
                    ${
                      step.title
                        ? html`<div>
                            <dt>${t('recordingPageTitle')}</dt>
                            <dd>${step.title}</dd>
                          </div>`
                        : nothing
                    }
                    <div>
                      <dt>${t('recordingPageUrl')}</dt>
                      <dd>${step.url || t('recordingUnavailableValue')}</dd>
                    </div>
                  </dl>
                </details>
                ${step.screenshotFiles?.length ? html`<p class="recording-message-attachment">${PHOTO}${t('recordingAttachedImages').replace('{count}', String(step.screenshotFiles.length))}</p>` : nothing}
              </div>
            </li>`,
        )}
      </ol>
    </div>
  </details>`;
}
