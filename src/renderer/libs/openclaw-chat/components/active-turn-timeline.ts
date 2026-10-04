import './tool-output';

import { COWORK_PLAN_PREVIEW_EVENT, extractPresentPlanPreview } from '@shared/cowork/planPreview';
import { REVIEW_OPEN_EVENT } from '@shared/cowork/sessionReview';
import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { i18nService } from '@/services/i18n';

import { isTranscriptImage } from '../attachments';
import { formatActiveTurnDuration } from '../model/active-turn-footer';
import type { ToolItem } from '../model/chat-transcript-state';
import {
  buildEditDiffView,
  buildEditSplitDiffRows,
  type EditDiffLine,
  type EditDiffViewHunk,
  type EditSplitDiffRow,
  type EditToolDiff,
  parseEditToolDiff,
} from '../model/edit-tool-diff';
import { fileToolCode, fileToolPatch } from '../model/file-tool-presentation';
import {
  type ActiveTurnTimelineItem,
  type ProcessSummaryTimelineItem,
} from '../model/project-turn-items';
import type { WaitingStatusKind } from '../model/run-activity';
import { OPEN_SPAWNED_AGENT_EVENT, spawnedAgentSessionKey } from '../model/spawn-tool-target';
import { toolNesting, toolOperation, toolOutcome, toolTarget } from '../model/tool-presentation';
import { stripOpenClawLogHintText } from '../pipeline/system-message-display';
import { renderChatAvatar } from './chat-avatar';
import { getCodeModeSource, getCodeModeTitle } from './code-mode-presentation';
import { type EditDiffMonacoData, resolveEditDiffLanguage } from './edit-diff-monaco';
import { toSanitizedMarkdownHtml } from './markdown';
import {
  renderAssistantAttachments,
  renderAssistantTimelineContent,
  renderCopyButton,
  renderMessageImages,
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

function toolResult(tool: ToolItem): string {
  if (tool.status === 'running' && tool.progressText) return tool.progressText;
  if (tool.output !== undefined) return readableValue(tool.output);
  if (tool.error !== undefined) return readableValue(tool.error);
  return i18nService.t('coworkToolNoOutput');
}

function hasToolResult(tool: ToolItem): boolean {
  return (
    tool.status !== 'running' ||
    tool.output !== undefined ||
    tool.error !== undefined ||
    Boolean(tool.progressText)
  );
}

function toolSummaryInput(value: unknown): string {
  const compact = readableValue(value).trim().replace(/\s+/g, ' ');
  if (!compact) return '';
  return compact.length <= 160 ? compact : `${compact.slice(0, 159)}…`;
}

function toolSummary(tool: ToolItem): string {
  if (getCodeModeSource(tool.name, tool.input) !== null) {
    return toolSummaryInput(
      getCodeModeTitle(tool.name, tool.input) ?? i18nService.t('coworkCodeMode'),
    );
  }
  const editDiff = parseEditToolDiff(tool.name, tool.input);
  return toolTarget(tool) || editDiff?.path || toolSummaryInput(tool.input);
}

export type EditDiffMode = 'unified' | 'split';

export type EditDiffModeChangeHandler = (toolId: string, mode: EditDiffMode) => void;

export interface TimelineSpeechOptions {
  state: 'idle' | 'loading' | 'playing';
  onSpeak: (groupKey: string, text: string) => void;
}

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
        ${
          diff.path
            ? html`<button
                type="button"
                class="edit-diff__mode-button edit-diff__review"
                @click=${(event: Event) => {
                  event.stopPropagation();
                  const button = event.currentTarget as HTMLElement;
                  const host = (button.getRootNode() as ShadowRoot).host;
                  const owner = host?.closest<HTMLElement>('[data-review-session-id]');
                  if (owner?.dataset.reviewSessionId)
                    window.dispatchEvent(
                      new CustomEvent(REVIEW_OPEN_EVENT, {
                        detail: { sessionId: owner.dataset.reviewSessionId, path: diff.path },
                      }),
                    );
                }}
              >
                ${i18nService.t('reviewOpenFile')}
              </button>`
            : nothing
        }

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

function renderSpawnedAgentLink(tool: ToolItem): TemplateResult | typeof nothing {
  const sessionKey = spawnedAgentSessionKey(tool);
  if (!sessionKey) return nothing;
  return html`<button type="button" class="tool-agent-link"
    title=${i18nService.t('subtaskShowInfo')} aria-label=${i18nService.t('subtaskShowInfo')}
    @click=${(event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent(OPEN_SPAWNED_AGENT_EVENT, { detail: { sessionKey } }));
    }}><svg viewBox="0 0 16 16" width="18" height="18" fill="none" aria-hidden="true">
      <path d="M3.5 12.5 12 4M4.5 4H12v7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg></button>`;
}

function renderToolDetail(
  tool: ToolItem,
  editDiffMode: EditDiffMode,
  onEditDiffModeChange?: EditDiffModeChangeHandler,
): TemplateResult {
  const editDiff = parseEditToolDiff(tool.name, tool.input);
  const inputCode = fileToolCode(tool, false);
  const outputCode = fileToolCode(tool, true);
  const patch = fileToolPatch(tool);
  const media = (tool.presentation?.media ?? []).map(item => ({
    url: item.path,
    label: item.fileName || (item.path.startsWith('data:') ? tool.name : '') || item.path.split(/[\\/]/).pop()?.slice(0, 120) || tool.name,
    kind: isTranscriptImage(item) ? 'image' as const : item.mimeType?.startsWith('video/') || item.kind === 'video' ? 'video' as const : item.mimeType?.startsWith('audio/') || item.kind === 'audio' ? 'audio' as const : 'document' as const,
  }));
  const codeModeSource = getCodeModeSource(tool.name, tool.input);
  return html`
    <div class="process-summary__tool-detail">
      ${renderMessageImages(media.filter(item => item.kind === 'image'), true)}
      ${renderAssistantAttachments(media.filter(item => item.kind !== 'image'))}
      ${
        tool.presentation?.exitCode !== undefined && tool.presentation.exitCode !== 0
          ? html`<div class="process-summary__error">
              ${i18nService.t('messageExitCode').replace('{code}', String(tool.presentation.exitCode))}
            </div>`
          : nothing
      }
      ${patch.length ? html`<div class="process-summary__detail-label">${i18nService.t('coworkToolInput')}</div>
        ${patch.map(file => html`<details class="file-patch" open><summary>${i18nService.t(`messagePatch${file.operation}`)} · ${file.path}${file.moveTo ? html` → ${file.moveTo}` : nothing}</summary>
          ${file.text ? html`<justdo-tool-output .text=${file.text} language="diff"></justdo-tool-output>` : nothing}
        </details>`)}` : nothing}
      ${
        patch.length ? nothing : editDiff
          ? renderEditDiff(tool.id, editDiff, editDiffMode, onEditDiffModeChange)
          : html`
              <div class="process-summary__detail-label">${i18nService.t(codeModeSource !== null ? 'coworkCodeModeSource' : 'coworkToolInput')}</div>
              ${
                tool.input === undefined ||
                tool.input === null ||
                (typeof tool.input === 'object' && Object.keys(tool.input).length === 0)
                  ? html`<span
                      >${i18nService.t(tool.status === 'running' ? 'messageInputPending' : 'messageNoParameters')}</span
                    >`
                  : html`<justdo-tool-output
                      .text=${codeModeSource ?? inputCode?.text ?? readableValue(tool.input)}
                      .language=${codeModeSource !== null ? 'javascript' : inputCode ? resolveEditDiffLanguage(inputCode.path) : ''}
                    ></justdo-tool-output>`
              }
            `
      }
      ${
        hasToolResult(tool)
          ? html`
              <div class="process-summary__detail-label">${i18nService.t('coworkToolResult')}</div>
              ${tool.presentation?.fileRead?.kind === 'truncated' ? html`<span>${i18nService.t('messagePartialOutput')}</span>` : nothing}
              <div
                class=${`process-summary__tool-result${toolOutcome(tool) === 'failed' ? ' process-summary__error' : ''}`}
              >
                <justdo-tool-output
                  .text=${outputCode?.text ?? toolResult(tool)}
                  .language=${outputCode ? resolveEditDiffLanguage(outputCode.path) : ''}
                  .terminal=${toolOperation(tool) === 'commands'}
                  .partial=${tool.presentation?.partial === true}
                  .identity=${{ runId: tool.runId, toolCallId: tool.toolCallId, messageId: tool.presentation?.resultMessageId }}
                ></justdo-tool-output>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function toolStateLabel(tool: ToolItem): string {
  const outcome = toolOutcome(tool);
  if (outcome === 'unknown') return i18nService.t('messageUnknownOutcome');
  if (outcome === 'skipped') return i18nService.t('messageSkippedOutcome');
  if (outcome === 'blocked') return i18nService.t('messageBlockedOutcome');
  if (outcome === 'failed') return i18nService.t('coworkStatusError');
  const stateKey =
    outcome === 'running'
      ? 'coworkToolRunning'
      : outcome === 'failed'
        ? 'coworkStatusError'
        : outcome === 'completed'
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

function renderProgressReceipt(
  tool: ToolItem,
  showAvatar: boolean,
  assistantAvatar?: TemplateResult,
): TemplateResult {
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
    'assistant',
    assistantAvatar,
  );
}

function renderPlanPresentation(
  tool: ToolItem,
  showAvatar: boolean,
  assistantAvatar?: TemplateResult,
): TemplateResult {
  const preview = extractPresentPlanPreview(tool.name, tool.input, tool.id);
  const title = preview?.title || i18nService.t('planReviewTitle');
  return renderAssistantTimelineRow(
    html`
      <button
        type="button"
        class="plan-presentation-card"
        data-plan-presentation-id=${tool.id}
        ?disabled=${!preview}
        @click=${(event: Event) => {
          event.stopPropagation();
          if (!preview) return;
          window.dispatchEvent(
            new CustomEvent(COWORK_PLAN_PREVIEW_EVENT, {
              detail: preview,
            }),
          );
        }}
      >
        <span class="plan-presentation-card__icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none">
            <path
              d="M6 4.75h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 14 16.75H6a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 6 4.75Z"
            />
            <path d="M8 4.75v-1.5h4v1.5M7.25 9.25l.75.75 1.5-1.75M11.25 9.25h2M7.25 13h6" />
          </svg>
        </span>
        <span class="plan-presentation-card__copy">
          <strong>${title}</strong>
        </span>
        <span class="plan-presentation-card__arrow" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <path d="m6 3.5 4.5 4.5L6 12.5" />
          </svg>
        </span>
      </button>
    `,
    showAvatar,
    'chat-group--plan-presentation',
    'assistant',
    assistantAvatar,
  );
}

function renderAssistantTimelineRow(
  content: TemplateResult,
  showAvatar: boolean,
  rowClass = '',
  avatarRole: 'assistant' | 'error' = 'assistant',
  assistantAvatar?: TemplateResult,
): TemplateResult {
  return html`
    <div
      class=${`chat-group chat-group--assistant chat-group--timeline${
        showAvatar ? '' : ' chat-group--continuation'
      }${rowClass ? ` ${rowClass}` : ''}`}
    >
      <div class="chat-group__avatar">
        ${showAvatar ? (avatarRole === 'assistant' && assistantAvatar ? assistantAvatar : renderChatAvatar(avatarRole)) : nothing}
      </div>
      <div class="chat-group__content">${content}</div>
    </div>
  `;
}

export function renderTerminalTimelineMessage(
  message: string,
  status: 'aborted' | 'error',
  showAvatar = true,
  footer: TemplateResult | typeof nothing = nothing,
  assistantAvatar?: TemplateResult,
): TemplateResult {
  const displayMessage = stripOpenClawLogHintText(message).trim();
  const firstLine = displayMessage.split(/\r?\n/)[0];
  const summary = firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
  const hasDetails = displayMessage !== summary;
  return renderAssistantTimelineRow(
    html`
      <div class="process-terminal process-terminal--${status}" role="status">
        ${status === 'aborted' ? html`<span aria-hidden="true">!</span>` : nothing}
        ${
          status === 'error' && hasDetails
            ? html`
                <details class="process-terminal__details">
                  <summary>
                    <span>${summary}</span
                    ><span class="process-terminal__details-label"
                      >${i18nService.t('coworkErrorDetails')}</span
                    >
                  </summary>
                  <pre tabindex="0" aria-label=${i18nService.t('coworkErrorDetails')}>
${displayMessage}</pre>
                </details>
              `
            : html`<span class="process-terminal__text">${displayMessage}</span>`
        }
        ${status === 'error' ? renderCopyButton(displayMessage, i18nService.t('coworkCopyError')) : nothing}
      </div>
      ${
        footer === nothing
          ? nothing
          : html`<footer class="active-turn__footer process-terminal__footer">${footer}</footer>`
      }
    `,
    showAvatar,
    '',
    status === 'error' ? 'error' : 'assistant',
    assistantAvatar,
  );
}

const waitingStatusKeys = {
  'waiting-model': 'coworkWaitingModel',
  'slow-active': 'coworkWaitingSlowActive',
  'long-wait': 'coworkWaitingLong',
  'rate-limited': 'coworkWaitingRateLimited',
  retrying: 'coworkWaitingRetrying',
  'retry-timeout': 'coworkWaitingRetryTimeout',
  'retry-overloaded': 'coworkWaitingRetryOverloaded',
  'retry-auth': 'coworkWaitingRetryAuth',
  'response-paused': 'coworkWaitingResponsePaused',
  disconnected: 'coworkWaitingDisconnected',
  reconnecting: 'coworkWaitingReconnecting',
  'probe-failed': 'coworkWaitingProbeFailed',
} as const satisfies Record<WaitingStatusKind, string>;

export function renderTimelineItem(
  item: ActiveTurnTimelineItem,
  now = Date.now(),
  expanded = false,
  showAvatar = true,
  editDiffModes: ReadonlyMap<string, EditDiffMode> = new Map(),
  onEditDiffModeChange?: EditDiffModeChangeHandler,
  speech?: TimelineSpeechOptions,
  assistantAvatar?: TemplateResult,
): TemplateResult {
  if (item.kind === 'waiting') {
    const labels = {
      starting: 'coworkWorkingStarting',
      queued: 'coworkWorkingQueued',
      preparing: 'coworkWorkingPreparing',
      'waiting-model': 'coworkWorkingWaiting',
      thinking: 'coworkWorkingThinking',
      responding: 'coworkWorkingResponding',
      'running-tool': 'coworkWorkingTool',
      retrying: 'coworkWorkingRetrying',
    } as const;
    return renderReadingIndicatorGroup({
      showAvatar,
      assistantAvatar,
      label: i18nService.t(item.notice ? waitingStatusKeys[item.notice.kind] : labels[item.stage ?? 'starting']),
      warning: item.notice?.tone === 'warning',
      elapsed:
        item.startedAt === undefined
          ? undefined
          : formatActiveTurnDuration(Math.max(0, now - item.startedAt)),
    });
  }
  if (item.kind === 'waiting-status') {
    const key = waitingStatusKeys[item.status.kind];
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
    return renderProgressReceipt(item.item, showAvatar, assistantAvatar);
  }
  if (item.kind === 'plan-presentation') {
    return renderPlanPresentation(item.item, showAvatar, assistantAvatar);
  }
  if (item.kind === 'live-process') {
    if (item.item.type === 'thinking') {
      return renderStreamingThinkingGroup(item.item.text, { showAvatar, assistantAvatar });
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
            data-tool-identity=${JSON.stringify([tool.runId, tool.toolCallId])}
            class=${`process-summary__tool process-live__tool${
              isEditDiff ? ' process-summary__tool--edit' : ''
            }`}
          >
            <summary class="process-summary__tool-title">
              <span
                class="process-summary__tool-status process-summary__tool-status--${toolOutcome(tool)}"
                role="img"
                aria-label=${toolStateLabel(tool)}
              ></span>
              <strong title=${resolveToolDisplay(tool.name).title}
                >${resolveToolDisplay(tool.name).title}</strong
              >
              ${renderSpawnedAgentLink(tool)}
              <span class="process-summary__tool-input" title=${toolSummary(tool)}
                >${toolSummary(tool)}</span
              >
            </summary>
            ${renderToolDetail(tool, editDiffModes.get(tool.id) ?? 'unified', onEditDiffModeChange)}
          </details>
        </section>
      `,
      showAvatar,
      '',
      'assistant',
      assistantAvatar,
    );
  }
  if (item.kind === 'process-summary') {
    const depths = toolNesting(
      item.items.filter((entry): entry is ToolItem => entry.type === 'tool'),
    );
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
                    ${repeat(
                      item.items,
                      process => process.id,
                      process => html`
                        <li
                          class=${`process-summary__item process-summary__item--${process.type}${
                            process.type === 'tool' &&
                            parseEditToolDiff(process.name, process.input) !== null
                              ? ' process-summary__item--edit'
                              : ''
                          }`}
                          style=${process.type === 'tool' ? `margin-inline-start: ${Math.min(depths.get(process) ?? 0, 6) * 16}px` : ''}
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
                                    data-tool-identity=${JSON.stringify([process.runId, process.toolCallId])}
                                    class=${`process-summary__tool${
                                      parseEditToolDiff(process.name, process.input) !== null
                                        ? ' process-summary__tool--edit'
                                        : ''
                                    }`}
                                  >
                                    <summary class="process-summary__tool-title">
                                      <span
                                        class="process-summary__tool-status process-summary__tool-status--${toolOutcome(process)}"
                                        role="img"
                                        aria-label=${toolStateLabel(process)}
                                      ></span>
                                      <strong title=${resolveToolDisplay(process.name).title}
                                        >${resolveToolDisplay(process.name).title}</strong
                                      >
                                      ${renderSpawnedAgentLink(process)}
                                      <span
                                        class="process-summary__tool-input"
                                        title=${toolSummary(process)}
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
      '',
      'assistant',
      assistantAvatar,
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
        assistantAvatar,
        speechState: speech?.state,
        onSpeak: speech?.onSpeak,
      },
    );
  }
  const terminalMessage =
    item.item.status === 'aborted'
      ? i18nService.t('coworkRunInterruptedMessage')
      : item.item.message;
  return renderTerminalTimelineMessage(
    terminalMessage,
    item.item.status,
    showAvatar,
    nothing,
    assistantAvatar,
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
