import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { i18nService } from '@/services/i18n';

import { MAX_LIVE_TOOL_OUTPUT_CHARS, type ToolItem } from '../model/chat-transcript-state';
import type {
  ActiveTurnTimelineItem,
  ProcessSummaryTimelineItem,
} from '../model/project-turn-items';
import { renderChatAvatar } from './chat-avatar';
import { toStreamingMarkdownHtml } from './markdown';
import { renderAssistantTimelineContent } from './message-render';
import { resolveToolDisplay } from './tool-display';

function summaryLabel(item: ProcessSummaryTimelineItem): string {
  const label = i18nService
    .t('coworkThinkingToolsClusterSummary')
    .replace('{thinkingCount}', String(item.thinkingCount))
    .replace('{toolCount}', String(item.toolCount));
  return label;
}

function readableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function boundedDetail(value: unknown): string {
  const readable = readableValue(value);
  if (readable.length <= MAX_LIVE_TOOL_OUTPUT_CHARS) return readable;
  return `${readable.slice(0, MAX_LIVE_TOOL_OUTPUT_CHARS)}\n[truncated]`;
}

function toolResult(tool: ToolItem): string {
  if (tool.output !== undefined) return boundedDetail(tool.output);
  if (tool.error !== undefined) return boundedDetail(tool.error);
  return i18nService.t(tool.status === 'running' ? 'coworkToolRunning' : 'coworkToolNoOutput');
}

function toolSummaryInput(value: unknown): string {
  const compact = readableValue(value).trim().replace(/\s+/g, ' ');
  if (!compact) return '';
  return compact.length <= 160 ? compact : `${compact.slice(0, 159)}…`;
}

function renderAssistantTimelineRow(content: TemplateResult, showAvatar: boolean): TemplateResult {
  return html`
    <div
      class=${`chat-group chat-group--assistant chat-group--timeline${
        showAvatar ? '' : ' chat-group--continuation'
      }`}
    >
      <div class="chat-group__avatar">${showAvatar ? renderChatAvatar('assistant') : nothing}</div>
      <div class="chat-group__content">${content}</div>
    </div>
  `;
}

export function renderTimelineItem(
  item: ActiveTurnTimelineItem,
  _now = Date.now(),
  expanded = false,
  showAvatar = true,
): TemplateResult {
  if (item.kind === 'process-summary') {
    return renderAssistantTimelineRow(
      html`
        <section class="process-summary-group">
          <button
            type="button"
            class="process-summary"
            data-process-summary-key=${item.key}
            aria-expanded=${expanded}
            aria-label=${`${summaryLabel(item)} · ${i18nService.t('coworkProcessOpenDetails')}`}
          >
            <span class="process-summary__icon" aria-hidden="true">⌁</span>
            <span>${summaryLabel(item)}</span>
            <span class="process-summary__chevron" aria-hidden="true">›</span>
          </button>
          ${
            expanded
              ? html`
                  <ol class="process-summary__items">
                    ${item.items.map(
                      process => html`
                        <li
                          class="process-summary__item process-summary__item--${process.type}"
                          data-inline-process-id=${process.id}
                          tabindex="-1"
                        >
                          <div class="process-summary__item-heading">
                            ${
                              process.type === 'thinking'
                                ? html`<strong>${i18nService.t('coworkThinkingLabel')}</strong>`
                                : nothing
                            }
                            ${
                              process.type === 'tool' &&
                              (process.status === 'running' || process.status === 'failed')
                                ? html`<span
                                    >${i18nService.t(
                                      process.status === 'running'
                                        ? 'coworkToolRunning'
                                        : 'coworkStatusError',
                                    )}</span
                                  >`
                                : nothing
                            }
                          </div>
                          ${
                            process.type === 'thinking'
                              ? html` <div class="process-summary__thinking">${process.text}</div> `
                              : html`
                                  <details class="process-summary__tool">
                                    <summary class="process-summary__tool-title">
                                      <strong>${resolveToolDisplay(process.name).title}</strong>
                                      <span>${toolSummaryInput(process.input)}</span>
                                    </summary>
                                    <div class="process-summary__tool-detail">
                                      <div class="process-summary__detail-label">
                                        ${i18nService.t('coworkToolInput')}
                                      </div>
                                      <pre>
${boundedDetail(process.input) || i18nService.t('coworkToolNoOutput')}</pre>
                                      <div class="process-summary__detail-label">
                                        ${i18nService.t('coworkToolResult')}
                                      </div>
                                      <pre
                                        class=${
                                          process.status === 'failed'
                                            ? 'process-summary__error'
                                            : ''
                                        }
                                      >
${toolResult(process)}</pre>
                                    </div>
                                  </details>
                                `
                          }
                        </li>
                      `,
                    )}
                  </ol>
                `
              : nothing
          }
        </section>
      `,
      showAvatar,
    );
  }
  if (item.kind === 'thinking') {
    return renderAssistantTimelineRow(
      html`
        <section
          class="process-row process-row--thinking process-row--${item.item.status}"
          data-process-id=${item.item.id}
        >
          <div class="process-row__heading">
            <span class="process-row__status" aria-hidden="true"></span>
            <span>${i18nService.t('coworkThinkingLabel')}</span>
            <span class="process-row__state"
              >${i18nService.t(
                item.item.status === 'running' ? 'coworkStatusRunning' : 'coworkProcessInterrupted',
              )}</span
            >
          </div>
          <div class="process-row__thinking">
            ${unsafeHTML(toStreamingMarkdownHtml(item.item.text))}
          </div>
        </section>
      `,
      showAvatar,
    );
  }
  if (item.kind === 'tool') {
    const stateKey =
      item.item.status === 'running'
        ? 'coworkToolRunning'
        : item.item.status === 'failed'
          ? 'coworkStatusError'
          : item.item.status === 'completed'
            ? 'coworkStatusCompleted'
            : 'coworkProcessInterrupted';
    return renderAssistantTimelineRow(
      html`
        <section
          class="process-row process-row--tool process-row--${item.item.status}"
          data-process-id=${item.item.id}
        >
          <div class="process-row__heading">
            <span class="process-row__status" aria-hidden="true"></span>
            <span class="process-row__tool-name">${resolveToolDisplay(item.item.name).title}</span>
            <span class="process-row__state">${i18nService.t(stateKey)}</span>
            ${
              item.item.status === 'failed' ||
              item.item.status === 'cancelled' ||
              item.item.status === 'interrupted'
                ? html`
                    <button
                      type="button"
                      class="process-row__details"
                      data-process-details-id=${item.item.id}
                    >
                      ${i18nService.t('coworkProcessViewDetails')}
                    </button>
                    <button
                      type="button"
                      class="process-row__dismiss"
                      data-dismiss-process-id=${item.item.id}
                    >
                      ${i18nService.t('coworkProcessDismiss')}
                    </button>
                  `
                : nothing
            }
          </div>
          ${
            item.item.error
              ? html`<div class="process-row__error">${item.item.error}</div>`
              : nothing
          }
        </section>
      `,
      showAvatar,
    );
  }
  if (item.kind === 'content') {
    return renderAssistantTimelineContent(item.item.text, {
      key: item.key,
      timestamp: item.item.startedAt,
      streaming: item.item.status === 'streaming',
      showAvatar,
    });
  }
  return renderAssistantTimelineRow(
    html`
      <div class="process-terminal process-terminal--${item.item.status}" role="status">
        <span aria-hidden="true">!</span>
        <span>${item.item.message}</span>
      </div>
    `,
    showAvatar,
  );
}

export function renderActiveTurnTimeline(
  items: ActiveTurnTimelineItem[],
  now = Date.now(),
  expandedSummaryKeys: ReadonlySet<string> = new Set(),
): TemplateResult {
  return html`
    <section class="active-turn-timeline">
      ${repeat(
        items,
        item => item.key,
        item => renderTimelineItem(item, now, expandedSummaryKeys.has(item.key)),
      )}
    </section>
  `;
}
