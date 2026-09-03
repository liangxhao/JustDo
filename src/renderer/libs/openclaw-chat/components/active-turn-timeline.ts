import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { i18nService } from '@/services/i18n';

import { MAX_LIVE_TOOL_OUTPUT_CHARS, type ToolItem } from '../model/chat-transcript-state';
import {
  buildEditDiffView,
  buildEditSplitDiffRows,
  type EditDiffLine,
  type EditDiffViewHunk,
  type EditSplitDiffRow,
  type EditToolDiff,
  parseEditToolDiff,
} from '../model/edit-tool-diff';
import {
  type ActiveTurnTimelineItem,
  type ProcessSummaryTimelineItem,
} from '../model/project-turn-items';
import { stripOpenClawLogHintText } from '../pipeline/message-normalizer';
import { renderChatAvatar } from './chat-avatar';
import { type EditDiffMonacoData, resolveEditDiffLanguage } from './edit-diff-monaco';
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

function toolSummary(tool: ToolItem): string {
  const editDiff = parseEditToolDiff(tool.name, tool.input);
  return editDiff?.path ?? toolSummaryInput(tool.input);
}

export type EditDiffMode = 'unified' | 'split';

export type EditDiffModeChangeHandler = (toolId: string, mode: EditDiffMode) => void;

function editDiffChangeLabel(line: EditDiffLine): string | null {
  return line.kind === 'added'
    ? i18nService.t('coworkEditDiffAddedLine')
    : line.kind === 'removed'
      ? i18nService.t('coworkEditDiffRemovedLine')
      : null;
}

function renderUnifiedDiffLine(line: EditDiffLine): TemplateResult {
  if (line.kind === 'omitted') {
    return html`
      <div class="edit-diff__line edit-diff__line--omitted">
        <span class="edit-diff__marker">⋯</span>
        <code>${i18nService.t('coworkEditDiffTruncated')}</code>
      </div>
    `;
  }
  const marker = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
  const changeLabel = editDiffChangeLabel(line);
  return html`
    <div class=${`edit-diff__line edit-diff__line--${line.kind}`}>
      <span class="edit-diff__marker" aria-hidden="true">${marker}</span>
      ${changeLabel ? html`<span class="sr-only">${changeLabel}</span>` : nothing}
      <code>${line.text || ' '}</code>
    </div>
  `;
}

function renderSplitDiffCell(line: EditDiffLine | null, side: 'before' | 'after'): TemplateResult {
  if (!line) {
    return html`<div
      class=${`edit-diff__split-cell edit-diff__split-cell--${side} is-empty`}
    ></div>`;
  }
  if (line.kind === 'omitted') {
    return html`
      <div class=${`edit-diff__split-cell edit-diff__split-cell--${side} edit-diff__line--omitted`}>
        <span class="edit-diff__marker">⋯</span>
        <code>${i18nService.t('coworkEditDiffTruncated')}</code>
      </div>
    `;
  }
  const marker = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
  const changeLabel = editDiffChangeLabel(line);
  return html`
    <div
      class=${`edit-diff__split-cell edit-diff__split-cell--${side} edit-diff__line--${line.kind}`}
    >
      <span class="edit-diff__marker" aria-hidden="true">${marker}</span>
      ${changeLabel ? html`<span class="sr-only">${changeLabel}</span>` : nothing}
      <code>${line.text || ' '}</code>
    </div>
  `;
}

function renderSplitDiffRows(rows: EditSplitDiffRow[]): TemplateResult {
  return html`
    <div class="edit-diff__split-rows">
      ${rows.map(
        row => html`
          <div class="edit-diff__split-row">
            ${renderSplitDiffCell(row.before, 'before')} ${renderSplitDiffCell(row.after, 'after')}
          </div>
        `,
      )}
    </div>
  `;
}

function editDiffMonacoText(line: EditDiffLine): string {
  return line.kind === 'omitted' ? '⋯' : line.text;
}

function buildEditDiffMonacoData(
  toolId: string,
  path: string | null,
  hunk: EditDiffViewHunk,
  rows: EditSplitDiffRow[],
  mode: EditDiffMode,
): { data: EditDiffMonacoData; height: number } {
  const originalLines = rows.flatMap(row => (row.before ? [editDiffMonacoText(row.before)] : []));
  const modifiedLines = rows.flatMap(row => (row.after ? [editDiffMonacoText(row.after)] : []));
  const visibleLineCount =
    mode === 'split'
      ? Math.max(originalLines.length, modifiedLines.length)
      : Math.max(hunk.lines.length, 1);

  return {
    data: {
      key: `${toolId}:${hunk.editIndex}`,
      language: resolveEditDiffLanguage(path),
      mode,
      modified: modifiedLines.join('\n'),
      original: originalLines.join('\n'),
    },
    height: Math.min(Math.max(visibleLineCount * 20 + 16, 76), 360),
  };
}

function renderEditDiff(
  toolId: string,
  diff: EditToolDiff,
  mode: EditDiffMode,
  onModeChange?: EditDiffModeChangeHandler,
): TemplateResult {
  const view = buildEditDiffView(diff);
  const addedLinesLabel = i18nService
    .t('coworkEditDiffAddedLines')
    .replace('{count}', String(view.addedCount));
  const removedLinesLabel = i18nService
    .t('coworkEditDiffRemovedLines')
    .replace('{count}', String(view.removedCount));

  return html`
    <section class="edit-diff" aria-label=${i18nService.t('coworkEditDiffLabel')}>
      <header class="edit-diff__header">
        <code class="edit-diff__path" title=${diff.path ?? ''}>${diff.path ?? ''}</code>
        <div
          class="edit-diff__mode-switch"
          role="group"
          aria-label=${i18nService.t('coworkEditDiffMode')}
        >
          ${(['unified', 'split'] as const).map(candidate => {
            const active = candidate === mode;
            return html`
              <button
                type="button"
                class=${`edit-diff__mode-button${active ? ' is-active' : ''}`}
                aria-pressed=${active}
                @click=${(event: Event) => {
                  event.stopPropagation();
                  onModeChange?.(toolId, candidate);
                }}
              >
                ${i18nService.t(
                  candidate === 'unified' ? 'coworkEditDiffUnifiedMode' : 'coworkEditDiffSplitMode',
                )}
              </button>
            `;
          })}
        </div>
        <span class="edit-diff__stats">
          <span class="edit-diff__stat edit-diff__stat--added">
            <span aria-hidden="true">+${view.addedCount}</span>
            <span class="sr-only">${addedLinesLabel}</span>
          </span>
          <span class="edit-diff__stat edit-diff__stat--removed">
            <span aria-hidden="true">-${view.removedCount}</span>
            <span class="sr-only">${removedLinesLabel}</span>
          </span>
        </span>
      </header>
      ${
        mode === 'split'
          ? html`
              <div class="edit-diff__split-header">
                <span>${i18nService.t('coworkEditDiffBefore')}</span>
                <span>${i18nService.t('coworkEditDiffAfter')}</span>
              </div>
            `
          : nothing
      }
      ${view.hunks.map(hunk => {
        const splitRows = buildEditSplitDiffRows(hunk.lines);
        const { data, height } = buildEditDiffMonacoData(toolId, diff.path, hunk, splitRows, mode);
        return html`
          <div class="edit-diff__hunk">
            ${
              view.totalEditCount > 1
                ? html`<div class="edit-diff__hunk-header">
                    @@ ${hunk.editIndex + 1}/${view.totalEditCount} @@
                  </div>`
                : nothing
            }
            <div
              class=${`edit-diff__monaco-host edit-diff__monaco-host--${mode}`}
              data-edit-diff-monaco
              style=${`height: ${height}px`}
              .editDiffData=${data}
            >
              <div class="edit-diff__monaco-fallback">
                ${
                  mode === 'split'
                    ? renderSplitDiffRows(splitRows)
                    : html`<div class="edit-diff__lines">
                        ${hunk.lines.map(renderUnifiedDiffLine)}
                      </div>`
                }
              </div>
            </div>
          </div>
        `;
      })}
      ${
        view.omittedEditCount > 0
          ? html`
              <div class="edit-diff__edits-omitted">
                ${i18nService
                  .t('coworkEditDiffEditsOmitted')
                  .replace('{count}', String(view.omittedEditCount))}
              </div>
            `
          : nothing
      }
    </section>
  `;
}

function renderToolDetail(
  tool: ToolItem,
  editDiffMode: EditDiffMode,
  onEditDiffModeChange?: EditDiffModeChangeHandler,
): TemplateResult {
  const editDiff = parseEditToolDiff(tool.name, tool.input);
  return html`
    <div class="process-summary__tool-detail">
      ${
        editDiff
          ? renderEditDiff(tool.id, editDiff, editDiffMode, onEditDiffModeChange)
          : html`
              <div class="process-summary__detail-label">${i18nService.t('coworkToolInput')}</div>
              <pre>${boundedDetail(tool.input) || i18nService.t('coworkToolNoOutput')}</pre>
            `
      }
      ${
        hasToolResult(tool)
          ? html`
              <div class="process-summary__detail-label">${i18nService.t('coworkToolResult')}</div>
              <pre class=${tool.status === 'failed' ? 'process-summary__error' : ''}>
${toolResult(tool)}</pre>
            `
          : nothing
      }
    </div>
  `;
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

function progressReceiptSteps(input: unknown): Array<{ step: string; status: string }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const plan = (input as Record<string, unknown>).plan;
  if (!Array.isArray(plan)) return [];
  return plan.flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const step = (candidate as Record<string, unknown>).step;
    const status = (candidate as Record<string, unknown>).status;
    if (
      typeof step !== 'string' ||
      (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
    ) {
      return [];
    }
    return [{ step: step.trim(), status }];
  });
}

function renderProgressReceipt(tool: ToolItem, showAvatar: boolean): TemplateResult {
  const steps = progressReceiptSteps(tool.input);
  const input =
    tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
      ? (tool.input as Record<string, unknown>)
      : null;
  const markdown = typeof input?.markdown === 'string' ? input.markdown.trim() : '';
  const completed = steps.filter(step => step.status === 'completed').length;
  const current =
    steps.find(step => step.status === 'in_progress') ??
    steps.find(step => step.status === 'pending') ??
    [...steps].reverse().find(step => step.status === 'completed');
  const label =
    tool.status === 'running'
      ? i18nService.t('coworkProgressReceiptUpdating')
      : tool.status === 'failed'
        ? i18nService.t('coworkProgressReceiptFailed')
        : tool.status === 'cancelled' || tool.status === 'interrupted'
          ? i18nService.t('coworkProgressReceiptInterrupted')
          : steps.length > 0
            ? i18nService
                .t('coworkProgressReceiptUpdated')
                .replace('{completed}', String(completed))
                .replace('{total}', String(steps.length))
                .replace('{current}', current?.step ?? '')
            : markdown
              ? i18nService.t('coworkProgressReceiptNoteUpdated')
              : input
                ? i18nService.t('coworkProgressReceiptCleared')
                : i18nService.t('coworkProgressReceiptChanged');
  return renderAssistantTimelineRow(
    html`
      <section
        class="progress-card-receipt"
        data-progress-receipt-id=${tool.id}
        role=${tool.status === 'running' ? 'status' : nothing}
      >
        <span class="progress-card-receipt__icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M4.25 4.25h7.5M4.25 8h7.5M4.25 11.75h4.5" />
            <path d="m2 4.25.55.55L3.6 3.7M2 8l.55.55L3.6 7.45M2 11.75l.55.55 1.05-1.1" />
          </svg>
        </span>
        <span>${label}</span>
      </section>
    `,
    showAvatar,
    'chat-group--progress-receipt',
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
  editDiffModes: ReadonlyMap<string, EditDiffMode> = new Map(),
  onEditDiffModeChange?: EditDiffModeChangeHandler,
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
  if (item.kind === 'progress-receipt') {
    return renderProgressReceipt(item.item, showAvatar);
  }
  if (item.kind === 'live-process') {
    if (item.item.type === 'thinking') {
      return renderStreamingThinkingGroup(item.item.text, { showAvatar });
    }
    const tool = item.item;
    const isEditDiff = parseEditToolDiff(tool.name, tool.input) !== null;
    return renderAssistantTimelineRow(
      html`
        <section
          class=${`process-live process-live--tool${isEditDiff ? ' process-live--edit' : ''}`}
          data-live-process-id=${tool.id}
        >
          <details
            class=${`process-summary__tool process-live__tool${
              isEditDiff ? ' process-summary__tool--edit' : ''
            }`}
          >
            <summary class="process-summary__tool-title">
              <span
                class="process-summary__tool-status process-summary__tool-status--${tool.status}"
                role="img"
                aria-label=${toolStateLabel(tool)}
              ></span>
              <strong>${resolveToolDisplay(tool.name).title}</strong>
              <span class="process-summary__tool-input">${toolSummary(tool)}</span>
            </summary>
            ${renderToolDetail(tool, editDiffModes.get(tool.id) ?? 'unified', onEditDiffModeChange)}
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
                          class=${`process-summary__item process-summary__item--${process.type}${
                            process.type === 'tool' &&
                            parseEditToolDiff(process.name, process.input) !== null
                              ? ' process-summary__item--edit'
                              : ''
                          }`}
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
                                  <details
                                    class=${`process-summary__tool${
                                      parseEditToolDiff(process.name, process.input) !== null
                                        ? ' process-summary__tool--edit'
                                        : ''
                                    }`}
                                  >
                                    <summary class="process-summary__tool-title">
                                      <span
                                        class="process-summary__tool-status process-summary__tool-status--${process.status}"
                                        role="img"
                                        aria-label=${toolStateLabel(process)}
                                      ></span>
                                      <strong>${resolveToolDisplay(process.name).title}</strong>
                                      <span class="process-summary__tool-input"
                                        >${toolSummary(process)}</span
                                      >
                                    </summary>
                                    ${renderToolDetail(
                                      process,
                                      editDiffModes.get(process.id) ?? 'unified',
                                      onEditDiffModeChange,
                                    )}
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
  const terminalMessage =
    item.item.status === 'aborted'
      ? i18nService.t('coworkRunInterruptedMessage')
      : item.item.message;
  return renderAssistantTimelineRow(
    html`
      <div class="process-terminal process-terminal--${item.item.status}" role="status">
        <span aria-hidden="true">!</span>
        <span>${terminalMessage}</span>
      </div>
    `,
    showAvatar,
  );
}

export function renderActiveTurnTimeline(
  items: ActiveTurnTimelineItem[],
  now = Date.now(),
  expandedSummaryKeys: ReadonlySet<string> = new Set(),
  editDiffModes: ReadonlyMap<string, EditDiffMode> = new Map(),
  onEditDiffModeChange?: EditDiffModeChangeHandler,
): TemplateResult {
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
            editDiffModes,
            onEditDiffModeChange,
          ),
      )}
    </section>
  `;
}
