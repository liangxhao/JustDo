import {
  type ExecutionPlanStep,
  ExecutionPlanStepStatus,
  parseExecutionPlanUpdate,
} from '@shared/openclaw/executionPlan';
import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { i18nService } from '@/services/i18n';

import { MAX_LIVE_TOOL_OUTPUT_CHARS, type ToolItem } from '../model/chat-transcript-state';
import {
  type ActiveTurnTimelineItem,
  latestPlanUpdateKey,
  type ProcessSummaryTimelineItem,
} from '../model/project-turn-items';
import { stripOpenClawLogHintText } from '../pipeline/message-normalizer';
import { renderChatAvatar } from './chat-avatar';
import { toSanitizedMarkdownHtml } from './markdown';
import {
  renderAssistantTimelineContent,
  renderReadingIndicatorGroup,
  renderStreamingThinkingGroup,
} from './message-render';
import { resolveToolDisplay } from './tool-display';

function summaryLabel(item: ProcessSummaryTimelineItem): string {
  if (item.thinkingCount > 0 && item.toolCount > 0) {
    return i18nService
      .t('coworkThinkingToolsClusterSummary')
      .replace('{thinkingCount}', String(item.thinkingCount))
      .replace('{toolCount}', String(item.toolCount));
  }
  if (item.thinkingCount > 0) {
    return i18nService
      .t('coworkThinkingClusterSummary')
      .replace('{count}', String(item.thinkingCount));
  }
  if (item.toolCount > 0) {
    return i18nService.t('coworkToolClusterSummary').replace('{count}', String(item.toolCount));
  }
  return '';
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
  return i18nService.t('coworkToolNoOutput');
}

function hasToolResult(tool: ToolItem): boolean {
  return tool.status !== 'running' || tool.output !== undefined || tool.error !== undefined;
}

function toolSummaryInput(value: unknown): string {
  const compact = readableValue(value).trim().replace(/\s+/g, ' ');
  if (!compact) return '';
  return compact.length <= 160 ? compact : `${compact.slice(0, 159)}…`;
}

function toolStateLabel(tool: ToolItem): string {
  const stateKey =
    tool.status === 'running'
      ? 'coworkToolRunning'
      : tool.status === 'failed'
        ? 'coworkStatusError'
        : tool.status === 'completed'
          ? 'coworkStatusCompleted'
          : 'coworkProcessInterrupted';
  return i18nService.t(stateKey);
}

function planStepStatusLabel(step: ExecutionPlanStep): string {
  const key =
    step.status === ExecutionPlanStepStatus.Completed
      ? 'coworkExecutionPlanCompleted'
      : step.status === ExecutionPlanStepStatus.InProgress
        ? 'coworkExecutionPlanInProgress'
        : 'coworkExecutionPlanPending';
  return i18nService.t(key);
}

function renderPlanUpdate(tool: ToolItem, showAvatar: boolean, isLive: boolean): TemplateResult {
  const update = parseExecutionPlanUpdate(tool.input);
  if (!update) {
    return renderAssistantTimelineRow(
      html`<section class="process-live process-live--tool">${tool.name}</section>`,
      showAvatar,
    );
  }
  const completed = update.plan.filter(
    step => step.status === ExecutionPlanStepStatus.Completed,
  ).length;
  return renderAssistantTimelineRow(
    html`
      <section
        class=${`execution-plan-update execution-plan-update--${tool.status}${
          isLive ? ' execution-plan-update--live' : ''
        }`}
        data-plan-update-id=${tool.id}
        aria-label=${i18nService.t('coworkExecutionPlanTitle')}
      >
        <header class="execution-plan-update__header">
          <span class="execution-plan-update__icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none">
              <path d="M4.25 4.25h7.5M4.25 8h7.5M4.25 11.75h4.5" />
              <path d="m2 4.25.55.55L3.6 3.7M2 8l.55.55L3.6 7.45M2 11.75l.55.55 1.05-1.1" />
            </svg>
          </span>
          <strong>${i18nService.t('coworkExecutionPlanTitle')}</strong>
          <span class="execution-plan-update__count"
            >${i18nService
              .t('coworkExecutionPlanCompletedCount')
              .replace('{completed}', String(completed))
              .replace('{total}', String(update.plan.length))}</span
          >
        </header>
        <div class="execution-plan-update__progress" aria-hidden="true">
          ${update.plan.map(
            step =>
              html`<span
                class="execution-plan-update__progress-segment execution-plan-update__progress-segment--${step.status}"
              ></span>`,
          )}
        </div>
        ${
          update.explanation
            ? html`<p class="execution-plan-update__explanation">${update.explanation}</p>`
            : nothing
        }
        <ol class="execution-plan-update__steps">
          ${update.plan.map(
            (step, index) => html`
              <li class="execution-plan-update__step execution-plan-update__step--${step.status}">
                <span
                  class="execution-plan-update__marker"
                  role="img"
                  aria-label=${planStepStatusLabel(step)}
                >
                  ${
                    step.status === ExecutionPlanStepStatus.Completed
                      ? '✓'
                      : step.status === ExecutionPlanStepStatus.InProgress
                        ? '•'
                        : String(index + 1)
                  }
                </span>
                <span class="execution-plan-update__step-text">${step.step}</span>
              </li>
            `,
          )}
        </ol>
      </section>
    `,
    showAvatar,
    'chat-group--plan-update',
  );
}

function renderAssistantTimelineRow(
  content: TemplateResult,
  showAvatar: boolean,
  rowClass = '',
): TemplateResult {
  return html`
    <div
      class=${`chat-group chat-group--assistant chat-group--timeline${
        showAvatar ? '' : ' chat-group--continuation'
      }${rowClass ? ` ${rowClass}` : ''}`}
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
  animatePlan = false,
): TemplateResult {
  if (item.kind === 'waiting') {
    return renderReadingIndicatorGroup({ showAvatar });
  }
  if (item.kind === 'waiting-status') {
    const key =
      item.status.kind === 'waiting-model'
        ? 'coworkWaitingModel'
        : item.status.kind === 'slow-active'
          ? 'coworkWaitingSlowActive'
          : item.status.kind === 'long-wait'
            ? 'coworkWaitingLong'
            : item.status.kind === 'rate-limited'
              ? 'coworkWaitingRateLimited'
              : item.status.kind === 'retrying'
                ? 'coworkWaitingRetrying'
                : item.status.kind === 'reconnecting'
                  ? 'coworkWaitingReconnecting'
                  : 'coworkWaitingProbeFailed';
    return html`
      <div
        class=${`chat-group chat-group--assistant chat-group--continuation waiting-status waiting-status--${item.status.tone}`}
      >
        <div class="chat-group__avatar" aria-hidden="true"></div>
        <div class="chat-group__content">
          <div class="waiting-status__message" role="status" aria-live="polite">
            <span class="waiting-status__indicator" aria-hidden="true"></span>
            <span>${i18nService.t(key)}</span>
          </div>
        </div>
      </div>
    `;
  }
  if (item.kind === 'plan-update') {
    return renderPlanUpdate(item.item, showAvatar, animatePlan);
  }
  if (item.kind === 'live-process') {
    if (item.item.type === 'thinking') {
      return renderStreamingThinkingGroup(item.item.text, { showAvatar });
    }
    const tool = item.item;
    return renderAssistantTimelineRow(
      html`
        <section class="process-live process-live--tool" data-live-process-id=${tool.id}>
          <details class="process-summary__tool process-live__tool">
            <summary class="process-summary__tool-title">
              <span
                class="process-summary__tool-status process-summary__tool-status--${tool.status}"
                role="img"
                aria-label=${toolStateLabel(tool)}
              ></span>
              <strong>${resolveToolDisplay(tool.name).title}</strong>
              <span class="process-summary__tool-input">${toolSummaryInput(tool.input)}</span>
            </summary>
            <div class="process-summary__tool-detail">
              <div class="process-summary__detail-label">${i18nService.t('coworkToolInput')}</div>
              <pre>${boundedDetail(tool.input) || i18nService.t('coworkToolNoOutput')}</pre>
              ${
                hasToolResult(tool)
                  ? html`
                      <div class="process-summary__detail-label">
                        ${i18nService.t('coworkToolResult')}
                      </div>
                      <pre>${toolResult(tool)}</pre>
                    `
                  : nothing
              }
            </div>
          </details>
        </section>
      `,
      showAvatar,
    );
  }
  if (item.kind === 'process-summary') {
    return renderAssistantTimelineRow(
      html`
        <section class="process-summary-group">
          <button
            type="button"
            class="process-summary"
            data-process-summary-key=${item.key}
            aria-expanded=${expanded}
            aria-label=${`${summaryLabel(item)} · ${i18nService.t(
              expanded ? 'coworkProcessCloseDetails' : 'coworkProcessOpenDetails',
            )}`}
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
                          ${
                            process.type === 'thinking'
                              ? html`
                                  <div class="process-summary__item-heading">
                                    <span
                                      class="process-summary__thinking-marker process-summary__thinking-marker--${process.status}"
                                      aria-hidden="true"
                                    ></span>
                                    <strong>${i18nService.t('coworkThinkingLabel')}</strong>
                                  </div>
                                `
                              : nothing
                          }
                          ${
                            process.type === 'thinking'
                              ? html`
                                  <div class="process-summary__thinking markdown-content">
                                    ${unsafeHTML(toSanitizedMarkdownHtml(process.text))}
                                  </div>
                                `
                              : html`
                                  <details class="process-summary__tool">
                                    <summary class="process-summary__tool-title">
                                      <span
                                        class="process-summary__tool-status process-summary__tool-status--${process.status}"
                                        role="img"
                                        aria-label=${toolStateLabel(process)}
                                      ></span>
                                      <strong>${resolveToolDisplay(process.name).title}</strong>
                                      <span class="process-summary__tool-input"
                                        >${toolSummaryInput(process.input)}</span
                                      >
                                    </summary>
                                    <div class="process-summary__tool-detail">
                                      <div class="process-summary__detail-label">
                                        ${i18nService.t('coworkToolInput')}
                                      </div>
                                      <pre>
${boundedDetail(process.input) || i18nService.t('coworkToolNoOutput')}</pre>
                                      ${
                                        hasToolResult(process)
                                          ? html`
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
                                            `
                                          : nothing
                                      }
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
  if (item.kind === 'content') {
    return renderAssistantTimelineContent(
      stripOpenClawLogHintText(item.item.text, item.item.status === 'streaming'),
      {
        key: item.key,
        timestamp: item.item.startedAt,
        streaming: item.item.status === 'streaming',
        showAvatar,
      },
    );
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
  const latestPlanKey = latestPlanUpdateKey(items);
  return html`
    <section class="active-turn-timeline">
      ${repeat(
        items,
        item => item.key,
        item =>
          renderTimelineItem(
            item,
            now,
            expandedSummaryKeys.has(item.key),
            true,
            item.kind === 'plan-update' && item.key === latestPlanKey,
          ),
      )}
    </section>
  `;
}
