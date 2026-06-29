/**
 * Grouped message rendering — aligned with OpenClaw webchat.
 * Renders MessageGroups as Lit html templates with proper CSS classes,
 * markdown rendering, avatar support, and streaming boundary detection.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { MessageGroup, NormalizedMessage, ToolCard } from '../types';
import { extractTextCached, extractThinkingCached, formatReasoningMarkdown } from '../pipeline/message-extract';
import { normalizeMessage } from '../pipeline/message-normalizer';
import { normalizeRoleForGrouping } from '../pipeline/role-normalizer';
import { extractToolCardsCached } from '../pipeline/tool-cards';
import { toSanitizedMarkdownHtml, toStreamingMarkdownHtml } from './markdown';
import { renderChatAvatar } from './chat-avatar';
import { resolveToolDisplay } from './tool-display';
import { detectTextDirection } from '../pipeline/text-direction';
import { i18nService } from '../../../services/i18n';

const COPY_ICON = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="15" height="15"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
    >${COPY_ICON}</button>
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

// ─── Message Group Rendering ────────────────────────────────────────────────

export function renderMessageGroup(
  group: MessageGroup,
  _opts?: { searchQuery?: string },
): TemplateResult | typeof nothing {
  if (!group.messages || group.messages.length === 0) return nothing;

  const role = normalizeRoleForGrouping(group.role);
  const isTool = role === 'tool';

  // For tool groups with multiple messages, collapse into activity
  if (isTool && group.messages.length > 1) {
    return renderToolActivityGroup(group);
  }

  // Single message groups
  const msg = group.messages[0];
  if (!msg) return nothing;

  const avatar = renderChatAvatar(role);

  return html`
    <div class="chat-group chat-group--${role}" data-group-key=${group.key}>
      <div class="chat-group__avatar">${avatar}</div>
      <div class="chat-group__content">
        ${group.messages.map(m => renderSingleMessage(m.message, role, _opts))}
        ${renderGroupFooter(group)}
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
  const textContent = msg.content.filter((c): c is { type: 'text'; text?: string } => c.type === 'text');
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
  const thinking = extractThinkingCached(rawMessage);
  const toolCards = extractToolCardsCached(rawMessage) as ToolCard[];
  const textContent = msg.content.filter((c): c is { type: 'text'; text?: string } => c.type === 'text');
  const text = textContent.map(c => c.text ?? '').join('\n');
  const dir = detectTextDirection(text);

  // Render thinking, tools, and content as SEPARATE blocks (not nested in one bubble)
  return html`
    ${thinking ? renderThinkingBlock(thinking) : nothing}
    ${toolCards.length > 0 ? renderToolCardsInline(toolCards) : nothing}
    ${text ? html`
      <div class="chat-bubble chat-bubble--assistant">
        ${renderCopyButton(text)}
        <div class="chat-bubble__text markdown-content" dir=${dir}>
          ${unsafeHTML(toSanitizedMarkdownHtml(text))}
        </div>
      </div>
    ` : nothing}
  `;
}

// ─── Thinking Block ─────────────────────────────────────────────────────────

function renderThinkingBlock(thinking: string): TemplateResult {
  const reasoning = formatReasoningMarkdown(thinking);
  return html`
    <details class="chat-thinking">
      <summary class="chat-thinking__summary">Thinking</summary>
      <div class="chat-thinking__content">
        ${unsafeHTML(toSanitizedMarkdownHtml(reasoning))}
      </div>
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
            ? html`<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`
            : html`<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>`}
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

// ─── Tool Cards Inline ──────────────────────────────────────────────────────

function renderToolCardsInline(cards: ToolCard[]): TemplateResult {
  return html`
    <div class="tool-cards-inline">
      ${cards.map(card => {
        const display = resolveToolDisplay(card.name);
        return html`
          <details class="tool-card ${card.isError ? 'tool-card--error' : ''}">
            <summary class="tool-card__name">${display.title}</summary>
            <div class="tool-card__details">
              <section class="tool-detail-box">
                <div class="tool-detail-box__label">${i18nService.t('coworkToolInput')}</div>
                <pre><code>${card.inputText ?? formatToolValue(card.args)}</code></pre>
              </section>
              <section class="tool-detail-box">
                <div class="tool-detail-box__label">${i18nService.t('coworkToolResult')}</div>
                <pre><code>${card.outputText ?? i18nService.t('coworkToolRunning')}</code></pre>
              </section>
            </div>
          </details>
        `;
      })}
    </div>
  `;
}

// ─── Tool Activity Group ────────────────────────────────────────────────────

function renderToolActivityGroup(group: MessageGroup): TemplateResult {
  return html`
    <div class="tool-activity-group" data-group-key=${group.key}>
      <details class="tool-activity-group__disclosure">
        <summary class="tool-activity-group__summary">
          ${group.messages.length} tool operations
        </summary>
        <div class="tool-activity-group__messages">
          ${group.messages.map(m => renderToolMessage(m.message))}
        </div>
      </details>
    </div>
  `;
}

// ─── Group Footer ───────────────────────────────────────────────────────────

function renderGroupFooter(group: MessageGroup): TemplateResult | typeof nothing {
  const ts = group.timestamp;
  if (!ts) return nothing;
  const date = new Date(ts);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const roleName = group.role === 'user' ? 'You' : group.role === 'assistant' ? 'Assistant' : '';
  return html`
    <div class="chat-group__footer">
      ${roleName ? html`<span class="chat-group__sender">${roleName}</span>` : nothing}
      <time class="chat-group__timestamp" datetime=${date.toISOString()}>${time}</time>
    </div>
  `;
}

// ─── Stream Rendering ───────────────────────────────────────────────────────

/**
 * Render streaming thinking content as a separate collapsible block.
 * Shown above the assistant text stream when thinking is in progress.
 */
export function renderStreamingThinkingGroup(text: string): TemplateResult {
  return html`
    <div class="chat-thinking chat-thinking--streaming">
      <div class="chat-thinking__header">
        <span class="chat-thinking__indicator"></span>
        <span class="chat-thinking__label">Thinking</span>
      </div>
      <div class="chat-thinking__content">
        ${unsafeHTML(toStreamingMarkdownHtml(text))}
      </div>
    </div>
  `;
}

export function renderStreamingGroup(
  text: string,
  _startedAt: number,
): TemplateResult {
  return html`
    <div class="chat-group chat-group--assistant chat-group--streaming">
      <div class="chat-group__avatar">${renderChatAvatar('assistant')}</div>
      <div class="chat-group__content">
        <div class="chat-bubble chat-bubble--assistant chat-bubble--streaming">
          ${renderCopyButton(text)}
          <div class="chat-bubble__text markdown-content">
            ${unsafeHTML(toStreamingMarkdownHtml(text))}
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderReadingIndicatorGroup(): TemplateResult {
  return html`
    <div class="chat-group chat-group--assistant">
      <div class="chat-group__avatar">${renderChatAvatar('assistant')}</div>
      <div class="chat-group__content">
        <div class="chat-bubble chat-bubble--assistant">
          <div class="chat-reading-indicator">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>
    </div>
  `;
}
