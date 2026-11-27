import '../tools/tool-output';
import '../tools/tool-image';
import '../native-widget/anchor';
import '../mcp-app/view';
import './terminal-error-message';

import { PRODUCT_NAME } from '@shared/productMetadata';
import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import type { OpenMessageFileLink } from '@/libs/openclaw-chat/message-actions';
import {
  COWORK_PLAN_PREVIEW_EVENT,
  extractPresentPlanPreview,
} from '@/libs/openclaw-chat/model/turn/plan-preview';
import { i18nService } from '@/services/i18n';
import { resolveFileCodeLanguage, resolveWriteCodeLanguage } from '@/shared/editor/file-code-language';
import { VS_CODE_MONOKAI_LINE_HEIGHT } from '@/shared/editor/vscode-code-theme';

import {
  questionPresentationResponse,
  renderQuestionPresentation,
} from '../../../../../../plugins/extensions/ask-user-question/browser/presentation';
import { parseQuestions } from '../../../../../../plugins/extensions/ask-user-question/contracts/result';
import { isTranscriptImage } from '../../attachments';
import type { ToolImageArtifactReader } from '../../gateway/history/tool-image-artifacts';
import type { ThinkingItem, ToolItem } from '../../model/chat-transcript-state';
import { formatActiveTurnDuration } from '../../model/timeline/active-turn-footer';
import {
  type ActiveTurnTimelineItem,
  type ProcessSummaryTimelineItem,
} from '../../model/timeline/project-turn-items';
import {
  buildEditDiffView,
  buildEditSplitDiffRows,
  type EditDiffLine,
  type EditDiffViewHunk,
  type EditSplitDiffRow,
  type EditToolDiff,
} from '../../model/tools/edit-tool-diff';
import { fileToolCode, fileToolPatch } from '../../model/tools/file-tool-presentation';
import { projectProgressReceipt } from '../../model/tools/progress-receipt';
import {
  OPEN_SPAWNED_AGENT_EVENT,
  spawnedAgentSessionKey,
} from '../../model/tools/spawn-tool-target';
import { asToolRecord } from '../../model/tools/tool-message-adapter';
import {
  projectProcessNesting,
  toolOperation,
  toolOutcome,
  toolTarget,
} from '../../model/tools/tool-presentation';
import type { WaitingStatusKind, WaitingStatusProjection } from '../../model/turn/run-activity';
import { stripOpenClawLogHintText } from '../../pipeline/system-message-display';
import { renderChatAvatar } from '../message/chat-avatar';
import {
  renderAssistantAttachments,
  renderAssistantTimelineContent,
  renderCopyButton,
  renderMessageImages,
  renderReadingIndicatorGroup,
  renderStreamingThinkingGroup,
} from '../message/message-render';
import { renderThinkingContent, type ThinkingContentRenderer } from '../message/thinking-content';
import type { EditDiffMonacoData } from '../tools/edit-diff-monaco';
import { resolveToolDisplay } from '../tools/tool-display';
import {
  projectToolInlinePreview,
  readableToolValue,
  type ToolInlinePreview,
  toolInputText,
  toolResultText,
} from '../tools/tool-inline-preview';
import { type ToolResultScope, withToolResultScope } from '../tools/tool-result-scope';
import { renderCompactionMessage } from './compaction-divider';
import { disclosureContent } from './disclosure-content';
import { REVIEW_OPEN_EVENT } from './review-navigation';
import { runProgressDetail, runProgressLabelKeys } from './run-progress-label';

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

function renderSummaryMetrics(item: ProcessSummaryTimelineItem): TemplateResult {
  const metrics = [
    { label: i18nService.t('coworkThinkingLabel'), count: item.thinkingCount },
    { label: resolveToolDisplay('tool').title, count: item.toolCount },
  ];
  return html`
    <span class="process-summary__metrics" aria-hidden="true">
      ${metrics.filter(metric => metric.count > 0).map(metric => html`
        <span class="process-summary__metric">
          <span>${metric.label}</span>
          <span class="process-summary__count">${metric.count}</span>
        </span>
      `)}
    </span>
  `;
}

function toolSummaryInput(value: unknown): string {
  const compact = readableToolValue(value).trim().replace(/\s+/g, ' ');
  if (!compact) return '';
  return compact.length <= 160 ? compact : `${compact.slice(0, 159)}…`;
}

function toolSummary(tool: ToolItem, preview: ToolInlinePreview | null): string {
  if (preview?.kind === 'exec' && preview.language === 'javascript') {
    return toolSummaryInput(i18nService.t('coworkCodeMode'));
  }
  const path = preview?.kind === 'edit' ? preview.diff.path : preview?.kind === 'write' ? preview.path : null;
  return toolTarget(tool) || path || toolSummaryInput(tool.input);
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

function renderUnifiedDiffLine(line: EditDiffLine, index: number): TemplateResult {
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
    <div class=${`edit-diff__line edit-diff__line--${line.kind}`} data-edit-diff-line-index=${index}>
      <span class="edit-diff__marker" aria-hidden="true">${marker}</span>
      ${changeLabel ? html`<span class="sr-only">${changeLabel}</span>` : nothing}
      <code>${line.text || ' '}</code>
    </div>
  `;
}

function renderSplitDiffCell(line: EditDiffLine | null, side: 'before' | 'after', index: number): TemplateResult {
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
      data-edit-diff-line-index=${index}
    >
      <span class="edit-diff__marker" aria-hidden="true">${marker}</span>
      ${changeLabel ? html`<span class="sr-only">${changeLabel}</span>` : nothing}
      <code>${line.text || ' '}</code>
    </div>
  `;
}

function renderSplitDiffRows(rows: EditSplitDiffRow[], lines: readonly EditDiffLine[]): TemplateResult {
  const indices = new Map(lines.map((line, index) => [line, index]));
  return html`
    <div class="edit-diff__split-rows">
      ${rows.map(
        row => html`
          <div class="edit-diff__split-row">
            ${renderSplitDiffCell(row.before, 'before', row.before ? indices.get(row.before)! : -1)}
            ${renderSplitDiffCell(row.after, 'after', row.after ? indices.get(row.after)! : -1)}
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
      language: resolveFileCodeLanguage(path),
      mode,
      modified: modifiedLines.join('\n'),
      original: originalLines.join('\n'),
      lines: hunk.lines,
    },
    height: Math.min(Math.max(visibleLineCount * VS_CODE_MONOKAI_LINE_HEIGHT + 16, 76), 360),
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
  const reviewLabel = i18nService.t('reviewOpenFile');

  return html`
    <section class="edit-diff" aria-label=${i18nService.t('coworkEditDiffLabel')}>
      <header class="edit-diff__header">
        ${
          diff.path
            ? html`<button
                type="button"
                class="edit-diff__mode-button edit-diff__review"
                title=${reviewLabel}
                aria-label=${reviewLabel}
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
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M13 5h6v6m0-6-8 8" />
                  <path d="M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" />
                </svg>
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
            const label = i18nService.t(
              candidate === 'unified' ? 'coworkEditDiffUnifiedMode' : 'coworkEditDiffSplitMode',
            );
            return html`
              <button
                type="button"
                class=${`edit-diff__mode-button${active ? ' is-active' : ''}`}
                title=${label}
                aria-label=${label}
                aria-pressed=${active}
                @click=${(event: Event) => {
                  event.stopPropagation();
                  onModeChange?.(toolId, candidate);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d=${candidate === 'unified' ? 'M7 10h10m-10 4h10' : 'M12 5v14m-6-9h3m6 0h3m-12 4h3m6 0h3'} />
                </svg>
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
                    ? renderSplitDiffRows(splitRows, hunk.lines)
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
  return html`<button
    type="button"
    class="tool-agent-link"
    title=${i18nService.t('subtaskShowInfo')}
    aria-label=${i18nService.t('subtaskShowInfo')}
    @click=${(event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent(OPEN_SPAWNED_AGENT_EVENT, { detail: { sessionKey } }));
    }}
  >
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="M3.5 12.5 12 4M4.5 4H12v7.5"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>`;
}

function renderToolDetail(
  tool: ToolItem,
  preview: ToolInlinePreview | null,
  sessionKey?: string,
  resultScope?: ToolResultScope,
): TemplateResult {
  const raw = preview !== null;
  const outputCode = raw ? null : fileToolCode(tool, true);
  const patch = raw ? [] : fileToolPatch(tool);
  const input = patch.length ? null : toolInputText(tool.input);
  const result = raw ? tool.output ?? tool.error : outputCode?.text ?? toolResultText(tool);
  const media = (tool.presentation?.media ?? []).map(item => ({
    url: item.path,
    label:
      item.fileName ||
      (item.path.startsWith('data:') ? tool.name : '') ||
      item.path.split(/[\\/]/).pop()?.slice(0, 120) ||
      tool.name,
    kind: isTranscriptImage(item)
      ? ('image' as const)
      : item.mimeType?.startsWith('video/') || item.kind === 'video'
        ? ('video' as const)
        : item.mimeType?.startsWith('audio/') || item.kind === 'audio'
          ? ('audio' as const)
          : ('document' as const),
  }));
  return html`
    <div class="process-summary__tool-detail">
      ${renderMessageImages(
        media.filter(item => item.kind === 'image'),
        true,
      )}
      ${renderAssistantAttachments(media.filter(item => item.kind !== 'image'), undefined, sessionKey)}
      <div class="process-summary__detail-label">${i18nService.t('coworkToolInput')}</div>
      ${
        patch.length
          ? patch.map(file => html`
              <details class="file-patch" open>
                <summary>
                  ${i18nService.t(`messagePatch${file.operation}`)} ·
                  ${file.path}${file.moveTo ? html` → ${file.moveTo}` : nothing}
                </summary>
                ${file.text ? html`<justdo-tool-output .text=${file.text} language="diff"></justdo-tool-output>` : nothing}
              </details>`)
          : input === null
            ? html`<span>${i18nService.t(tool.status === 'running' ? 'messageInputPending' : 'messageNoParameters')}</span>`
            : html`<justdo-tool-output
                data-tool-search-source=${raw ? 'raw-input' : nothing}
                data-tool-search-mirror=${preview && 'rawInputPath' in preview
                  ? preview.rawInputPath?.join('.') ?? nothing
                  : nothing}
                data-tool-search-edit-root=${preview?.kind === 'edit' ? preview.rawInputRoot ?? nothing : nothing}
                .text=${input}
              ></justdo-tool-output>`
      }
      ${
        result !== undefined || tool.status !== 'running'
          ? html`
              <div class="process-summary__detail-label">${i18nService.t('coworkToolResult')}</div>
              ${tool.presentation?.fileRead?.kind === 'truncated' ? html`<span>${i18nService.t('messagePartialOutput')}</span>` : nothing}
              <div
                class=${`process-summary__tool-result${toolOutcome(tool) === 'failed' ? ' process-summary__error' : ''}`}
              >
                <justdo-tool-output
                  data-tool-search-source=${raw ? 'raw-result' : nothing}
                  .text=${result ?? (raw ? '' : i18nService.t('coworkToolNoOutput'))}
                  .showEmptyResult=${raw && result === undefined}
                  .language=${outputCode ? resolveFileCodeLanguage(outputCode.path) : ''}
                  .terminal=${!raw && toolOperation(tool) === 'commands'}
                  .partial=${tool.presentation?.partial === true}
                  .identity=${{ runId: tool.runId, toolCallId: tool.toolCallId, messageId: tool.presentation?.resultMessageId }}
                  .resultScope=${resultScope}
                ></justdo-tool-output>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderToolPreview(
  tool: ToolItem,
  preview: ToolInlinePreview,
  editDiffMode: EditDiffMode,
  onEditDiffModeChange?: EditDiffModeChangeHandler,
  resultScope?: ToolResultScope,
): TemplateResult | typeof nothing {
  if (preview.kind === 'edit') return renderEditDiff(tool.id, preview.diff, editDiffMode, onEditDiffModeChange);
  if (preview.kind === 'write') {
    if (preview.text === undefined) return nothing;
    const path = preview.path ?? null;
    const codeLanguage = resolveWriteCodeLanguage(path);
    return html`
      <justdo-tool-output
        data-tool-search-source="write"
        .text=${preview.text}
        .language=${codeLanguage ?? resolveFileCodeLanguage(path)}
        .collapsible=${true}
        .editorStyle=${codeLanguage !== undefined}
        .identity=${{ runId: tool.runId, toolCallId: tool.toolCallId }}
      ></justdo-tool-output>
    `;
  }

  const result = toolResultText(tool);
  if (preview.command === undefined && result === undefined && tool.status === 'running') return nothing;
  return html`
    <div class="process-summary__tool-result">
      <justdo-tool-output
        data-tool-search-source="exec-result"
        .text=${result ?? ''}
        .showEmptyResult=${tool.status !== 'running'}
        .terminal=${true}
        .terminalCommand=${preview.command}
        .terminalCommandLanguage=${preview.language}
        .paginate=${false}
        .partial=${tool.presentation?.partial === true}
        .identity=${{ runId: tool.runId, toolCallId: tool.toolCallId, messageId: tool.presentation?.resultMessageId }}
        .resultScope=${resultScope}
      ></justdo-tool-output>
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

function renderProgressReceipt(
  tool: ToolItem,
  showAvatar: boolean,
  assistantAvatar?: TemplateResult,
): TemplateResult {
  const presentation = projectProgressReceipt(tool);
  const label = Object.entries(presentation.values).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, value),
    i18nService.t(presentation.key),
  );
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
  const filteredMessage = stripOpenClawLogHintText(message).trim();
  const diagnosticMessage =
    status === 'error' ? filteredMessage.replace(/\bOpenClaw\b/g, PRODUCT_NAME) : filteredMessage;
  const displayMessage =
    status === 'error' ? diagnosticMessage.replace(/^⚠[\uFE0E\uFE0F]?\s*/u, '') : diagnosticMessage;
  return renderAssistantTimelineRow(
    html`
      <div class="process-terminal process-terminal--${status}" role="status">
        ${status === 'aborted' ? html`<span aria-hidden="true">!</span>` : nothing}
        ${
          status === 'error'
            ? html`<chat-terminal-error .message=${displayMessage}></chat-terminal-error>`
            : html`<span class="process-terminal__text">${displayMessage}</span>`
        }
        ${status === 'error' ? renderCopyButton(diagnosticMessage, i18nService.t('coworkCopyError')) : nothing}
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
  'retry-tool-call-format': 'coworkWaitingToolCallFormat',
  'response-paused': 'coworkWaitingResponsePaused',
  'outcome-unconfirmed': 'coworkWaitingOutcomeUnconfirmed',
  disconnected: 'coworkWaitingDisconnected',
  reconnecting: 'coworkWaitingReconnecting',
  'probe-failed': 'coworkWaitingProbeFailed',
} as const satisfies Record<WaitingStatusKind, string>;

function waitingStatusLabel(status: WaitingStatusProjection): string {
  if (
    status.kind === 'retry-tool-call-format' &&
    status.retryAttempt !== undefined &&
    status.maxRetries !== undefined
  ) {
    return i18nService
      .t('coworkWaitingToolCallFormatCount')
      .replace('{attempt}', String(status.retryAttempt))
      .replace('{max}', String(status.maxRetries));
  }
  return i18nService.t(waitingStatusKeys[status.kind]);
}

function renderWaitingStatus(status: WaitingStatusProjection): TemplateResult {
  return html`
    <div
      class=${`chat-group chat-group--assistant chat-group--continuation waiting-status waiting-status--${status.tone}`}
    >
      <div class="chat-group__avatar" aria-hidden="true"></div>
      <div class="chat-group__content">
        <div class="waiting-status__message" role="status" aria-live="polite">
          ${status.kind === 'outcome-unconfirmed'
            ? nothing
            : html`<span class="waiting-status__indicator" aria-hidden="true"></span>`}
          <span>${waitingStatusLabel(status)}</span>
        </div>
      </div>
    </div>
  `;
}

function renderToolImages(tool: ToolItem, readImage?: ToolImageArtifactReader) {
  const images = tool.presentation?.imageArtifacts;
  if (!readImage || !images?.length) return nothing;
  return html`
    <div class="process-tool-images">
      ${repeat(images, image => image.id, image => html`
        <tool-image-artifact .artifact=${image} .readImage=${readImage}></tool-image-artifact>
      `)}
    </div>
  `;
}

function renderToolInputPreview(
  tool: ToolItem,
  inlinePreview: ToolInlinePreview | null,
  readImage?: ToolImageArtifactReader,
) {
  if (inlinePreview?.kind === 'edit' && inlinePreview.diff.path) {
    const path = inlinePreview.diff.path;
    return html`<span class="process-summary__tool-input" data-tool-search-source="edit-path" title=${path}>${path}</span>`;
  }
  const inputTitle = asToolRecord(tool.input)?.title;
  const title = typeof inputTitle === 'string' ? toolSummaryInput(inputTitle) : '';
  if (!title && readImage && tool.presentation?.imageArtifacts?.length) return nothing;
  if (!title && inlinePreview?.kind === 'exec' && !inlinePreview.language && inlinePreview.command !== undefined)
    return nothing;
  const preview = title || toolSummary(tool, inlinePreview);
  return html`<span class="process-summary__tool-input" title=${preview}>${preview}</span>`;
}

function renderToolRow(
  tool: ToolItem,
  preview: ToolInlinePreview | null,
  options: {
    editDiffMode: EditDiffMode;
    onEditDiffModeChange?: EditDiffModeChangeHandler;
    sessionKey?: string;
    readToolImage?: ToolImageArtifactReader;
    live?: boolean;
  },
): TemplateResult {
  const title = resolveToolDisplay(tool.name).title;
  const renderRow = (resultScope?: ToolResultScope): TemplateResult => {
    const detailContent = () => renderToolDetail(tool, preview, options.sessionKey, resultScope);
    const details = html`
      <details
        data-tool-identity=${JSON.stringify([tool.runId, tool.toolCallId])}
        class=${`process-summary__tool${options.live ? ' process-live__tool' : ''}${
          preview?.kind === 'edit' ? ' process-summary__tool--edit' : ''
        }`}
      >
        <summary class="process-summary__tool-title">
          <span
            class=${`process-summary__tool-status process-summary__tool-status--${toolOutcome(tool)}`}
            role="img"
            aria-label=${toolStateLabel(tool)}
          ></span>
          <strong title=${title}>${title}</strong>
          ${renderSpawnedAgentLink(tool)}
          ${renderToolInputPreview(tool, preview, options.readToolImage)}
        </summary>
        <div class="process-disclosure-content">
          ${preview || options.live ? disclosureContent(detailContent) : detailContent()}
        </div>
      </details>
    `;
    if (!preview) return details;
    return html`
      <div class="process-tool-preview-layout">
        ${details}
        <div class="process-tool-preview">
          ${renderToolPreview(tool, preview, options.editDiffMode, options.onEditDiffModeChange, resultScope)}
        </div>
      </div>
    `;
  };
  return html`
    ${preview?.kind === 'exec'
      ? withToolResultScope(
          JSON.stringify([tool.runId, tool.toolCallId, tool.presentation?.resultMessageId]),
          renderRow,
        )
      : renderRow()}
    ${renderToolImages(tool, options.readToolImage)}
  `;
}

function toolNestingStyle(depth = 0): string | typeof nothing {
  return depth ? `--tool-nesting-indent: ${Math.min(depth, 6) * 16}px` : nothing;
}

function renderProcessItem(
  process: ThinkingItem | ToolItem,
  depths: ReadonlyMap<ToolItem, number>,
  editDiffModes: ReadonlyMap<string, EditDiffMode>,
  onEditDiffModeChange?: EditDiffModeChangeHandler,
  renderThinking?: ThinkingContentRenderer,
  sessionKey?: string,
  readToolImage?: ToolImageArtifactReader,
): TemplateResult {
  const preview = process.type === 'tool' ? projectToolInlinePreview(process) : null;
  return html`
    <div role="listitem"
      class=${`process-summary__item process-summary__item--${process.type}${
        preview?.kind === 'edit'
          ? ' process-summary__item--edit'
          : ''
      }`}
      style=${process.type === 'tool' ? toolNestingStyle(depths.get(process)) : nothing}
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
                ${renderThinking?.(process) ?? renderThinkingContent(process.text, false)}
              </div>
            `
          : renderToolRow(process, preview, {
              editDiffMode: editDiffModes.get(process.id) ?? 'unified',
              onEditDiffModeChange,
              sessionKey,
              readToolImage,
            })
      }
    </div>
  `;
}

export function renderTimelineItem(
  item: ActiveTurnTimelineItem,
  now = Date.now(),
  expanded = false,
  showAvatar = true,
  editDiffModes: ReadonlyMap<string, EditDiffMode> = new Map(),
  onEditDiffModeChange?: EditDiffModeChangeHandler,
  speech?: TimelineSpeechOptions,
  assistantAvatar?: TemplateResult,
  renderThinking?: ThinkingContentRenderer,
  contentOptions?: {
    workingDirectory?: string;
    onOpenFile?: OpenMessageFileLink;
    sessionKey?: string;
    readToolImage?: ToolImageArtifactReader;
    withinCompletedProcess?: boolean;
  },
  renderProcessItems?: (
    items: readonly (ThinkingItem | ToolItem)[],
    render: (item: ThinkingItem | ToolItem) => unknown,
  ) => unknown,
): TemplateResult {
  if (item.kind === 'mcp-app') {
    return renderAssistantTimelineRow(
      html`<mcp-app-anchor .preview=${item.preview}></mcp-app-anchor>`,
      showAvatar,
      '',
      'assistant',
      assistantAvatar,
    );
  }
  if (item.kind === 'app-reference') {
    return renderAssistantTimelineRow(
      html`<mcp-app-anchor .reference=${item.reference}></mcp-app-anchor>`,
      showAvatar,
      '',
      'assistant',
      assistantAvatar,
    );
  }
  if (item.kind === 'native-widget') {
    return renderAssistantTimelineRow(
      html`<native-widget-anchor .preview=${item.preview}></native-widget-anchor>`,
      showAvatar,
      '',
      'assistant',
      assistantAvatar,
    );
  }
  if (item.kind === 'waiting') {
    if (item.notice?.kind === 'outcome-unconfirmed') return renderWaitingStatus(item.notice);
    return renderReadingIndicatorGroup({
      showAvatar,
      assistantAvatar,
      label: item.notice
        ? waitingStatusLabel(item.notice)
        : i18nService.t(runProgressLabelKeys[item.stage ?? 'starting']),
      detail: runProgressDetail(item.activity, now),
      warning: item.notice?.tone === 'warning',
      elapsed:
        item.startedAt === undefined
          ? undefined
          : formatActiveTurnDuration(Math.max(0, now - item.startedAt)),
    });
  }
  if (item.kind === 'waiting-status') return renderWaitingStatus(item.status);
  if (item.kind === 'progress-receipt') {
    return renderProgressReceipt(item.item, showAvatar, assistantAvatar);
  }
  if (item.kind === 'question-presentation') {
    const result =
      item.item.status === 'completed' ? item.item.presentation?.questionResult : undefined;
    const questions =
      result?.questions ?? parseQuestions((item.item.input as Record<string, unknown>)?.questions);
    if (!questions) return html``;
    return renderAssistantTimelineRow(
      renderQuestionPresentation(
        questions,
        questionPresentationResponse(
          item.item.status,
          result?.response,
          item.item.error ?? item.item.output,
        ),
        key => i18nService.t(key),
      ),
      showAvatar,
      'chat-group--question',
      'assistant',
      assistantAvatar,
    );
  }
  if (item.kind === 'plan-presentation') {
    return renderPlanPresentation(item.item, showAvatar, assistantAvatar);
  }
  if (item.kind === 'live-process') {
    if (item.item.type === 'thinking') {
      return renderStreamingThinkingGroup(item.item.text, {
        processId: item.item.id,
        streaming: item.item.status === 'running',
        showAvatar,
        assistantAvatar,
        thinkingContent: renderThinking?.(item.item),
      });
    }
    const tool = item.item;
    const preview = projectToolInlinePreview(tool);
    return renderAssistantTimelineRow(
      html`
        <section
          class=${`process-live process-live--tool${preview ? ' process-live--preview' : ''}`}
          style=${toolNestingStyle(item.toolDepth)}
          data-live-process-id=${tool.id}
        >
          ${renderToolRow(tool, preview, {
            editDiffMode: editDiffModes.get(tool.id) ?? 'unified',
            onEditDiffModeChange,
            sessionKey: contentOptions?.sessionKey,
            readToolImage: contentOptions?.readToolImage,
            live: true,
          })}
        </section>
      `,
      showAvatar,
      '',
      'assistant',
      assistantAvatar,
    );
  }
  if (item.kind === 'process-summary') {
    const { items: ordered, depths } = projectProcessNesting(item.items);
    const tail = ordered[ordered.length - 1];
    const renderProcess = (process: ThinkingItem | ToolItem) => renderProcessItem(
      process, depths, editDiffModes, onEditDiffModeChange, renderThinking,
      contentOptions?.sessionKey, contentOptions?.readToolImage,
    );
    const renderContents = () =>
      html` <div class="process-summary__items" role="list">
        ${renderProcessItems?.(ordered, renderProcess) ?? repeat(ordered, process => process.id, renderProcess)}
      </div>`;
    // The surrounding completed process already supplies the disclosure for these images.
    if (contentOptions?.withinCompletedProcess && contentOptions.readToolImage &&
        item.items.some(process => process.type === 'tool' && process.presentation?.imageArtifacts?.length)) {
      return renderAssistantTimelineRow(renderContents(), showAvatar, '', 'assistant', assistantAvatar);
    }
    return renderAssistantTimelineRow(
      html`
        <details class="process-summary-group" ?open=${expanded}>
          <summary
            role="button"
            @click=${(event: Event) => event.preventDefault()}
            class="process-summary"
            data-process-summary-key=${item.key}
            data-process-summary-tail=${tail ? JSON.stringify([tail.type, tail.id]) : nothing}
            aria-expanded=${expanded}
            aria-label=${`${summaryLabel(item)} · ${i18nService.t(
              expanded ? 'coworkProcessCloseDetails' : 'coworkProcessOpenDetails',
            )}`}
          >
            ${renderSummaryMetrics(item)}
            <span class="process-summary__chevron" aria-hidden="true">›</span>
          </summary>
          <div class="process-disclosure-content">
            ${expanded ? renderContents() : disclosureContent(renderContents)}
          </div>
        </details>
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
        ...contentOptions,
      },
    );
  }
  if (item.kind === 'compaction') return renderCompactionMessage(item.item.message, now);
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
