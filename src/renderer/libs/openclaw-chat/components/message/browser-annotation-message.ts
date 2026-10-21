import { html, nothing, type TemplateResult } from 'lit';

import { i18nService } from '@/services/i18n';

import type { MessageContentItem } from '../../types';

const BROWSER_ANNOTATION_ICON = html`
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M5.75 4.75h12.5A2.75 2.75 0 0 1 21 7.5v6a2.75 2.75 0 0 1-2.75 2.75h-6.1l-4.44 2.91a.5.5 0 0 1-.77-.42v-2.49H5.75A2.75 2.75 0 0 1 3 13.5v-6a2.75 2.75 0 0 1 2.75-2.75Z"
      fill="currentColor"
    />
  </svg>
`;

const BROWSER_ANNOTATION_CHEVRON = html`
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
    <path d="m4 6 4 4 4-4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

const BROWSER_ANNOTATION_GLOBE = html`
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
    <circle cx="8" cy="8" r="5.75" stroke-width="1.25" />
    <path
      d="M2.5 8h11M8 2.25c1.5 1.56 2.25 3.48 2.25 5.75S9.5 12.2 8 13.75C6.5 12.2 5.75 10.27 5.75 8S6.5 3.8 8 2.25Z"
      stroke-width="1.25"
    />
  </svg>
`;

export function renderBrowserAnnotation(
  item: Extract<MessageContentItem, { type: 'browser_annotation' }>,
): TemplateResult {
  const { annotation } = item;
  const element = annotation.element;
  const elementType = element?.role || element?.tag;
  const elementLabel =
    element?.name?.trim() || elementType || i18nService.t('browserMessageMarkedArea');
  const accessibleLabel = elementType ? `${elementLabel}, ${elementType}` : elementLabel;
  const regionLabel = i18nService
    .t('browserMessageRegionCount')
    .replace('{count}', String(annotation.markedRegionCount));

  return html`
    <details class="browser-annotation-message" aria-label=${accessibleLabel}>
      <summary class="browser-annotation-message__summary">
        <span class="browser-annotation-message__icon">${BROWSER_ANNOTATION_ICON}</span>
        <span class="browser-annotation-message__main">
          <span class="browser-annotation-message__label" title=${accessibleLabel}>
            <span class="browser-annotation-message__title">${elementLabel}</span>
          </span>
          <span class="browser-annotation-message__source" title=${annotation.title}>
            <span class="browser-annotation-message__source-icon">${BROWSER_ANNOTATION_GLOBE}</span>
            ${annotation.displayUrl || annotation.title}
          </span>
        </span>
        <span class="browser-annotation-message__chevron">${BROWSER_ANNOTATION_CHEVRON}</span>
      </summary>
      <dl class="browser-annotation-message__details">
        ${
          annotation.comment
            ? html`<div class="browser-annotation-message__property">
                <dt>${i18nService.t('browserMessageComment')}</dt>
                <dd>${annotation.comment}</dd>
              </div>`
            : nothing
        }
        ${
          element
            ? html`
                ${
                  element.role
                    ? html`<div class="browser-annotation-message__property">
                        <dt>${i18nService.t('browserMessageRole')}</dt>
                        <dd><code>${element.role}</code></dd>
                      </div>`
                    : nothing
                }
                ${
                  element.cssPath
                    ? html`<div class="browser-annotation-message__property">
                        <dt>${i18nService.t('browserMessageSelector')}</dt>
                        <dd><code>${element.cssPath}</code></dd>
                      </div>`
                    : nothing
                }
                <div class="browser-annotation-message__property">
                  <dt>${i18nService.t('browserMessageBounds')}</dt>
                  <dd>
                    <code
                      >x=${Math.round(element.rect.x)} y=${Math.round(element.rect.y)}
                      w=${Math.round(element.rect.width)} h=${Math.round(element.rect.height)}</code
                    >
                  </dd>
                </div>
              `
            : nothing
        }
        ${
          annotation.markedRegionCount > 0
            ? html`<div class="browser-annotation-message__property">
                <dt>${i18nService.t('browserMessageMarks')}</dt>
                <dd>${regionLabel}</dd>
              </div>`
            : nothing
        }
        <div class="browser-annotation-message__property">
          <dt>${i18nService.t('browserMessagePage')}</dt>
          <dd title=${annotation.title}>${annotation.title}</dd>
        </div>
      </dl>
    </details>
  `;
}
