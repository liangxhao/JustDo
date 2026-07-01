/**
 * Grouped message rendering — aligned with OpenClaw webchat.
 * Renders MessageGroups as Lit html templates with proper CSS classes,
 * markdown rendering, avatar support, and streaming boundary detection.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { i18nService } from '../../../services/i18n';
import {
  extractTextCached,
  extractThinkingCached,
  formatReasoningMarkdown,
} from '../pipeline/message-extract';
import { normalizeMessage } from '../pipeline/message-normalizer';
import { normalizeRoleForGrouping } from '../pipeline/role-normalizer';
import { detectTextDirection } from '../pipeline/text-direction';
import { extractToolCards, extractToolCardsCached } from '../pipeline/tool-cards';
import type { ChatItem, MessageGroup, NormalizedMessage, ToolCard } from '../types';
import { renderChatAvatar } from './chat-avatar';
import { toSanitizedMarkdownHtml, toStreamingMarkdownHtml } from './markdown';
import { resolveToolDisplay } from './tool-display';

const COPY_ICON = html`
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    width="15"
    height="15"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect width="14" height="14" x="8" y="8" rx="2"></rect>
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
  </svg>
`;

async function copyMessage(event: Event, text: string): Promise<void> {
  event.stopPropagation();
  const button = event.currentTarget as HTMLButtonElement;
  try {
    await navigator.clipboard.writeText(text);
    button.classList.add('message-copy--copied');
    button.setAttribute('aria-label', i18nService.t('copied'));
    window.setTimeout(() => {
      button.classList.remove('message-copy--copied');
      button.setAttribute('aria-label', i18nService.t('copyToClipboard'));
    }, 1500);
  } catch (error) {
    console.error('[GroupedRender] Failed to copy message', error);
  }
}

function renderCopyButton(text: string): TemplateResult {
  const label = i18nService.t('copyToClipboard');
  return html`
    <button
      type="button"
      class="message-copy"
      aria-label=${label}
      title=${label}
      @click=${(event: Event) => void copyMessage(event, text)}
    >
      ${COPY_ICON}
    </button>
  `;
}

function formatToolValue(value: unknown): string {
  if (value === undefined || value === null) return '{}';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getAttachedToolMessages(message: unknown): unknown[] {
  const attached = (message as Record<string, unknown> | null)?.__justdoAttachedToolMessages;
  return Array.isArray(attached) ? attached : [];
}

function toolMessagesToCards(messages: unknown[]): ToolCard[] {
  return messages.flatMap((message, index) =>
    extractToolCardsCached(message, `attached-tool:${index}`),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toolCardDedupeKey(card: ToolCard): string {
  const normalizedId = card.id.replace(/^(?:attached-tool:\d+|inline-tool:\d+|preview|tool):/, '');
  const isGeneratedFallbackId = new RegExp(`^(?:${escapeRegExp(card.name)}|tool):\\d+$`).test(
    normalizedId,
  );
  return isGeneratedFallbackId ? `${card.id}:${card.name}` : normalizedId;
}

function hasMeaningfulToolInput(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0 && value.trim() !== '{}';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function mergeToolCard(existing: ToolCard, incoming: ToolCard): ToolCard {
  const shouldUseIncomingInput =
    hasMeaningfulToolInput(incoming.args) && !hasMeaningfulToolInput(existing.args);
  return {
    ...existing,
    args: shouldUseIncomingInput ? incoming.args : (existing.args ?? incoming.args),
    inputText: shouldUseIncomingInput
      ? incoming.inputText
      : (existing.inputText ?? incoming.inputText),
    outputText: incoming.outputText ?? existing.outputText,
    isError: incoming.isError ?? existing.isError,
    messageId: incoming.messageId ?? existing.messageId,
    preview: incoming.preview ?? existing.preview,
  };
}

function dedupeToolCards(cards: ToolCard[]): ToolCard[] {
  const indexByKey = new Map<string, number>();
  const result: ToolCard[] = [];
  for (const card of cards) {
    const key = toolCardDedupeKey(card);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      result[existingIndex] = mergeToolCard(result[existingIndex] ?? card, card);
      continue;
    }
    indexByKey.set(key, result.length);
    result.push(card);
  }
  return result;
}

function shouldOpenToolTimeline(rawMessage: unknown): boolean {
  return (rawMessage as Record<string, unknown> | null)?.__justdoToolTimelineOpen === true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractToolCallId(message: unknown): string | null {
  const raw = message as Record<string, unknown> | null;
  if (!raw) return null;

  const direct = [raw.toolCallId, raw.tool_call_id, raw.toolUseId, raw.tool_use_id].find(
    value => typeof value === 'string' && value.trim(),
  ) as string | undefined;
  if (direct) return direct.trim();

  const content = Array.isArray(raw.content) ? raw.content : [];
  for (const block of content) {
    const item = block as Record<string, unknown> | null;
    if (!item) continue;
    const nested = [item.toolCallId, item.tool_call_id, item.toolUseId, item.tool_use_id, item.id]
      .find(value => typeof value === 'string' && value.trim()) as string | undefined;
    if (nested) return nested.trim();
  }
  return null;
}

function hasLiveToolMessage(messages: unknown[]): boolean {
  const activeByToolId = new Map<string, boolean>();
  let anonymousActive = false;

  for (const message of messages) {
    const raw = message as Record<string, unknown> | null;
    const isActive = raw?.__justdoToolActive === true;
    const toolCallId = extractToolCallId(message);
    if (toolCallId) {
      activeByToolId.set(toolCallId, isActive);
    } else if (isActive) {
      anonymousActive = true;
    }
  }

  return anonymousActive || [...activeByToolId.values()].some(Boolean);
}

function renderAssistantTextBlock(text: string): TemplateResult | typeof nothing {
  if (!text) return nothing;
  const dir = detectTextDirection(text);
  return html`
    <div class="chat-bubble chat-bubble--assistant">
      ${renderCopyButton(text)}
      <div class="chat-bubble__text markdown-content" dir=${dir}>
        ${unsafeHTML(toSanitizedMarkdownHtml(text))}
      </div>
    </div>
  `;
}

function renderAssistantToolCards(
  cards: ToolCard[],
  rawMessage: unknown,
): TemplateResult | typeof nothing {
  const deduped = dedupeToolCards(cards);
  if (deduped.length === 0) return nothing;
  return renderToolTimeline(deduped, !shouldOpenToolTimeline(rawMessage));
}

function renderAssistantMessageInContentOrder(
  rawMessage: unknown,
): Array<TemplateResult | typeof nothing> | null {
  const raw = asRecord(rawMessage);
  const content = Array.isArray(raw?.content) ? raw.content : null;
  if (!content) return null;

  const attachedByToolId = new Map<string, unknown[]>();
  for (const attached of getAttachedToolMessages(rawMessage)) {
    const id = extractToolCallId(attached);
    if (!id) continue;
    attachedByToolId.set(id, [...(attachedByToolId.get(id) ?? []), attached]);
  }

  const ordered: Array<TemplateResult | typeof nothing> = [];
  const consumedAttached = new Set<unknown>();

  for (let index = 0; index < content.length; index += 1) {
    const block = asRecord(content[index]);
    if (!block) continue;
    const type = typeof block.type === 'string' ? block.type.toLowerCase() : '';

    if (type === 'thinking') {
      const thinking = typeof block.thinking === 'string' ? block.thinking : '';
      if (thinking) {
        ordered.push(renderThinkingBlock(thinking));
      }
      continue;
    }

    if (type === 'text') {
      ordered.push(renderAssistantTextBlock(typeof block.text === 'string' ? block.text : ''));
      continue;
    }

    if (['toolcall', 'tool_call', 'tooluse', 'tool_use', 'toolresult', 'tool_result'].includes(type)) {
      const blockMessage = { ...raw, content: [block] };
      const cards = extractToolCards(blockMessage, `inline-tool:${index}`);
      const toolCallId = extractToolCallId(blockMessage);
      const attached = toolCallId ? (attachedByToolId.get(toolCallId) ?? []) : [];
      for (const attachedMessage of attached) {
        consumedAttached.add(attachedMessage);
      }
      ordered.push(renderAssistantToolCards([...cards, ...toolMessagesToCards(attached)], rawMessage));
    }
  }

  const remainingAttached = getAttachedToolMessages(rawMessage).filter(
    attached => !consumedAttached.has(attached),
  );
  if (remainingAttached.length > 0) {
    ordered.push(renderAssistantToolCards(toolMessagesToCards(remainingAttached), rawMessage));
  }

  return ordered.length > 0 ? ordered : null;
}

// ─── Message Group Rendering ────────────────────────────────────────────────

export function renderMessageGroup(
  group: MessageGroup,
  opts?: {
    searchQuery?: string;
    showFooter?: boolean;
    showAvatar?: boolean;
    assistantName?: string;
  },
): TemplateResult | typeof nothing {
  if (!group.messages || group.messages.length === 0) return nothing;

  const role = normalizeRoleForGrouping(group.role);

  // Single message groups
  const msg = group.messages[0];
  if (!msg) return nothing;

  const avatar = renderChatAvatar(role);
  const isContinuation = opts?.showAvatar === false;

  return html`
    <div
      class=${`chat-group chat-group--${role}${isContinuation ? ' chat-group--continuation' : ''}`}
      data-group-key=${group.key}
    >
      <div class="chat-group__avatar">${opts?.showAvatar ?? true ? avatar : nothing}</div>
      <div class="chat-group__content">
        ${group.messages.map(m => renderSingleMessage(m.message, role, opts))}
        ${renderGroupFooter(group, opts?.showFooter ?? true, opts?.assistantName)}
      </div>
    </div>
  `;
}

export function renderMessageGroupWithTrailingStream(
  group: MessageGroup,
  streamText: string,
  toolMessages: unknown[] = [],
  thinkingText: string | null = null,
  opts?: { searchQuery?: string; showAvatar?: boolean },
): TemplateResult | typeof nothing {
  if (!group.messages || group.messages.length === 0) return nothing;

  const role = normalizeRoleForGrouping(group.role);
  const toolCards = dedupeToolCards(toolMessagesToCards(toolMessages));
  const hasStreamText = streamText.trim().length > 0;
  const isContinuation = opts?.showAvatar === false;

  return html`
    <div
      class=${`chat-group chat-group--${role} chat-group--streaming${
        isContinuation ? ' chat-group--continuation' : ''
      }`}
      data-group-key=${group.key}
    >
      <div class="chat-group__avatar">
        ${opts?.showAvatar ?? true ? renderChatAvatar(role) : nothing}
      </div>
      <div class="chat-group__content">
        ${group.messages.map(m => renderSingleMessage(m.message, role, opts))}
        ${thinkingText ? renderStreamingThinkingBlock(thinkingText) : nothing}
        ${toolCards.length > 0 ? renderToolTimeline(toolCards, !hasLiveToolMessage(toolMessages)) : nothing}
        ${hasStreamText
          ? html`
              <div class="chat-bubble chat-bubble--assistant">
                ${renderCopyButton(streamText)}
                <div class="chat-bubble__text markdown-content">
                  ${unsafeHTML(toStreamingMarkdownHtml(streamText))}
                </div>
              </div>
            `
          : renderReadingIndicator()}
      </div>
    </div>
  `;
}

function renderSingleMessage(
  message: unknown,
  role: string,
  _opts?: { searchQuery?: string },
): TemplateResult {
  const normalized = normalizeMessage(message) as NormalizedMessage | null;
  if (!normalized) return html`<div class="chat-bubble chat-bubble--empty"></div>`;

  const isUser = role === 'user';
  const isTool = role === 'tool';

  if (isTool) return renderToolMessage(message);
  if (isUser) return renderUserMessage(normalized);
  return renderAssistantMessage(normalized, message);
}

// ─── User Message ───────────────────────────────────────────────────────────

function renderUserMessage(msg: NormalizedMessage): TemplateResult {
  const textContent = msg.content.filter(
    (c): c is { type: 'text'; text?: string } => c.type === 'text',
  );
  const text = textContent.map(c => c.text ?? '').join('\n');
  const dir = detectTextDirection(text);
  const htmlContent = toSanitizedMarkdownHtml(text);

  return html`
    <div class="chat-bubble chat-bubble--user" dir=${dir}>
      ${renderCopyButton(text)}
      <div class="chat-bubble__text">${unsafeHTML(htmlContent)}</div>
    </div>
  `;
}

// ─── Assistant Message ──────────────────────────────────────────────────────

function renderAssistantMessage(msg: NormalizedMessage, rawMessage: unknown): TemplateResult {
  const orderedBlocks = renderAssistantMessageInContentOrder(rawMessage);
  if (orderedBlocks) {
    return html`${orderedBlocks}`;
  }

  const thinking = extractThinkingCached(rawMessage);
  const toolCards = dedupeToolCards([
    ...(extractToolCardsCached(rawMessage) as ToolCard[]),
    ...toolMessagesToCards(getAttachedToolMessages(rawMessage)),
  ]);
  const textContent = msg.content.filter(
    (c): c is { type: 'text'; text?: string } => c.type === 'text',
  );
  const text = textContent.map(c => c.text ?? '').join('\n');

  return html`
    ${thinking ? renderThinkingBlock(thinking) : nothing}
    ${toolCards.length > 0
      ? renderToolTimeline(toolCards, !shouldOpenToolTimeline(rawMessage))
      : nothing}
    ${renderAssistantTextBlock(text)}
  `;
}

// ─── Thinking Block ─────────────────────────────────────────────────────────

function renderThinkingBlock(thinking: string): TemplateResult {
  const reasoning = formatReasoningMarkdown(thinking);
  return html`
    <details class="chat-thinking">
      <summary class="chat-thinking__summary">Thinking</summary>
      <div class="chat-thinking__content">${unsafeHTML(toSanitizedMarkdownHtml(reasoning))}</div>
    </details>
  `;
}

// ─── Tool Message ───────────────────────────────────────────────────────────

function renderToolMessage(message: unknown): TemplateResult {
  const m = message as Record<string, unknown>;
  const toolName = (m.toolName ?? m.tool_name ?? 'tool') as string;
  const text = extractTextCached(message) ?? '';
  const input = m.args ?? m.arguments ?? m.input ?? m.toolInput ?? m.tool_input;
  const isError = Boolean(m.isError) || text.toLowerCase().includes('error');
  const display = resolveToolDisplay(toolName);

  return html`
    <details class="tool-message ${isError ? 'tool-message--error' : ''}">
      <summary class="tool-message__header">
        <span class="tool-message__icon">
          ${isError
            ? html`<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                <path
                  d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
                />
              </svg>`
            : html`<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                <path
                  d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"
                />
              </svg>`}
        </span>
        <span class="tool-message__name">${display.title}</span>
      </summary>
      <div class="tool-message__details">
        <section class="tool-detail-box">
          <div class="tool-detail-box__label">${i18nService.t('coworkToolInput')}</div>
          <pre><code>${formatToolValue(input)}</code></pre>
        </section>
        <section class="tool-detail-box">
          <div class="tool-detail-box__label">${i18nService.t('coworkToolResult')}</div>
          <pre><code>${text || i18nService.t('coworkToolRunning')}</code></pre>
        </section>
      </div>
    </details>
  `;
}

// ─── Tool Timeline ──────────────────────────────────────────────────────────

function renderToolTimeline(cards: ToolCard[], collapsed: boolean): TemplateResult {
  const toolNames = cards.map(card => resolveToolDisplay(card.name).title).join('、');
  const summary = `${cards.length} ${i18nService.t('coworkToolTimelineSummaryLabel')}: ${toolNames}`;
  return html`
    <details class="tool-timeline" ?open=${!collapsed}>
      <summary class="tool-timeline__summary">${summary}</summary>
      <ol class="tool-timeline__list">
        ${cards.map(card => renderToolTimelineItem(card, collapsed))}
      </ol>
    </details>
  `;
}

function formatToolTimelineSummaryInput(card: ToolCard): string {
  if (card.args !== undefined && typeof card.args !== 'string') {
    try {
      return JSON.stringify(card.args);
    } catch {
      return formatToolValue(card.args).trim().replace(/\s+/g, ' ');
    }
  }
  const input = card.inputText ?? formatToolValue(card.args);
  return input.trim().replace(/\s+/g, ' ');
}

function renderToolTimelineItem(card: ToolCard, collapsed: boolean): TemplateResult {
  const display = resolveToolDisplay(card.name);
  const resultText = card.outputText ?? i18nService.t('coworkToolRunning');
  const summaryInput = formatToolTimelineSummaryInput(card);
  const statusClass = card.isError
    ? 'tool-timeline__item--error'
    : card.outputText
      ? 'tool-timeline__item--completed'
      : 'tool-timeline__item--running';
  return html`
    <li class="tool-timeline__item ${statusClass}">
      <div class="tool-timeline__marker" aria-hidden="true"></div>
      <details class="tool-timeline__body" ?open=${!collapsed}>
        <summary class="tool-timeline__title">
          <span class="tool-timeline__name">${display.title}</span>
          <span class="tool-timeline__summary-input">${summaryInput}</span>
        </summary>
        <div class="tool-message__details">
          <section class="tool-detail-box">
            <div class="tool-detail-box__label">${i18nService.t('coworkToolInput')}</div>
            <pre><code>${card.inputText ?? formatToolValue(card.args)}</code></pre>
          </section>
          <section class="tool-detail-box">
            <div class="tool-detail-box__label">${i18nService.t('coworkToolResult')}</div>
            <pre><code>${resultText}</code></pre>
          </section>
        </div>
      </details>
    </li>
  `;
}

// ─── Group Footer ───────────────────────────────────────────────────────────

function renderGroupFooter(
  group: MessageGroup,
  showFooter: boolean,
  assistantName?: string,
): TemplateResult | typeof nothing {
  if (!showFooter) return nothing;
  const ts = group.timestamp;
  if (!ts) return nothing;
  const date = new Date(ts);
  const time = formatGroupTimestamp(date);
  const roleName = getGroupFooterLabel(group, assistantName);
  return html`
    <div class="chat-group__footer">
      ${roleName ? html`<span class="chat-group__sender">${roleName}</span>` : nothing}
      <time class="chat-group__timestamp" datetime=${date.toISOString()}>${time}</time>
    </div>
  `;
}

export function getGroupFooterLabel(group: MessageGroup, assistantName?: string): string {
  if (group.role === 'assistant') {
    const modelName = group.modelName?.trim() ?? '';
    const senderLabel = group.senderLabel?.trim() ?? '';
    return modelName || senderLabel || assistantName?.trim() || 'Assistant';
  }
  if (group.role === 'user') {
    return 'You';
  }
  return group.senderLabel?.trim() ?? '';
}

export function formatGroupTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function shouldRenderGroupFooterByNextItem(
  group: MessageGroup,
  nextItem: ChatItem | MessageGroup | null | undefined,
): boolean {
  if (group.role === 'assistant') {
    if (nextItem?.kind === 'stream' && nextItem.isStreaming) {
      return false;
    }
    if (nextItem?.kind === 'group' && nextItem.role === 'assistant') {
      return false;
    }
  }

  if (group.role === 'user') {
    return !(nextItem?.kind === 'group' && nextItem.role === 'user');
  }

  return true;
}

export function shouldRenderGroupAvatarByPrevItem(
  group: MessageGroup,
  prevItem: ChatItem | MessageGroup | null | undefined,
): boolean {
  if (!prevItem) return true;
  if (prevItem.kind === 'group' && prevItem.role === group.role) {
    return false;
  }
  if (prevItem.kind === 'stream' && group.role === 'assistant') {
    return false;
  }
  return true;
}

// ─── Stream Rendering ───────────────────────────────────────────────────────

/**
 * Render streaming thinking content as a separate collapsible block.
 * Shown above the assistant text stream when thinking is in progress.
 */
export function renderStreamingThinkingGroup(
  text: string,
  opts?: { showAvatar?: boolean },
): TemplateResult {
  const isContinuation = opts?.showAvatar === false;
  return html`
    <div
      class=${`chat-group chat-group--assistant chat-group--streaming-thinking${
        isContinuation ? ' chat-group--continuation' : ''
      }`}
    >
      <div class="chat-group__avatar">
        ${opts?.showAvatar ?? true ? renderChatAvatar('assistant') : nothing}
      </div>
      <div class="chat-group__content">${renderStreamingThinkingBlock(text)}</div>
    </div>
  `;
}

export function renderStreamingGroup(
  text: string,
  _startedAt: number,
  toolMessages: unknown[] = [],
  thinkingText: string | null = null,
  opts?: { showAvatar?: boolean },
): TemplateResult {
  const toolCards = dedupeToolCards(toolMessagesToCards(toolMessages));
  const hasText = text.trim().length > 0;
  const isContinuation = opts?.showAvatar === false;
  return html`
    <div
      class=${`chat-group chat-group--assistant chat-group--streaming${
        isContinuation ? ' chat-group--continuation' : ''
      }`}
    >
      <div class="chat-group__avatar">
        ${opts?.showAvatar ?? true ? renderChatAvatar('assistant') : nothing}
      </div>
      <div class="chat-group__content">
        ${thinkingText ? renderStreamingThinkingBlock(thinkingText) : nothing}
        ${toolCards.length > 0 ? renderToolTimeline(toolCards, !hasLiveToolMessage(toolMessages)) : nothing}
        ${hasText
          ? html`
              <div class="chat-bubble chat-bubble--assistant">
                ${renderCopyButton(text)}
                <div class="chat-bubble__text markdown-content">
                  ${unsafeHTML(toStreamingMarkdownHtml(text))}
                </div>
              </div>
            `
          : renderReadingIndicator()}
      </div>
    </div>
  `;
}

function renderReadingIndicator(): TemplateResult {
  return html`
    <div class="chat-reading-indicator" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
}

function renderStreamingThinkingBlock(text: string): TemplateResult {
  return html`
    <div class="chat-thinking chat-thinking--streaming">
      <div class="chat-thinking__header">
        <span class="chat-thinking__indicator"></span>
        <span class="chat-thinking__label">Thinking</span>
      </div>
      <div class="chat-thinking__content">${unsafeHTML(toStreamingMarkdownHtml(text))}</div>
    </div>
  `;
}

export function renderReadingIndicatorGroup(opts?: { showAvatar?: boolean }): TemplateResult {
  const isContinuation = opts?.showAvatar === false;
  return html`
    <div
      class=${`chat-group chat-group--assistant chat-group--reading-indicator${
        isContinuation ? ' chat-group--continuation' : ''
      }`}
    >
      <div class="chat-group__avatar">
        ${opts?.showAvatar ?? true ? renderChatAvatar('assistant') : nothing}
      </div>
      <div class="chat-group__content">
        <div class="chat-reading-indicator" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
  `;
}
