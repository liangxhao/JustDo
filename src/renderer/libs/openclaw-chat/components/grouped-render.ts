/**
 * Grouped message rendering — aligned with OpenClaw webchat.
 * Renders MessageGroups as Lit html templates with proper CSS classes,
 * markdown rendering, avatar support, and streaming boundary detection.
 */
import { isImageMimeType } from '@shared/cowork/attachments';
import { getPreviewableFileExtension } from '@shared/filePreview';
import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { getTranscriptMedia, type RenderableAttachment } from '@/libs/openclaw-chat/attachments';
import { renderChatAvatar } from '@/libs/openclaw-chat/components/chat-avatar';
import { toSanitizedMarkdownHtml, toStreamingMarkdownHtml } from '@/libs/openclaw-chat/components/markdown';
import { resolveToolDisplay } from '@/libs/openclaw-chat/components/tool-display';
import {
  extractTextCached,
  extractThinkingCached,
  formatReasoningMarkdown,
} from '@/libs/openclaw-chat/pipeline/message-extract';
import {
  normalizeMessage,
  stripMessageDisplayMetadataText,
  stripUnreliableGoalZeroUsageText,
} from '@/libs/openclaw-chat/pipeline/message-normalizer';
import { normalizeRoleForGrouping } from '@/libs/openclaw-chat/pipeline/role-normalizer';
import { detectTextDirection } from '@/libs/openclaw-chat/pipeline/text-direction';
import {
  extractToolCards,
  extractToolCardsCached,
  isToolCardError,
  isToolErrorOutput,
} from '@/libs/openclaw-chat/pipeline/tool-cards';
import {
  extractCanvasShortcodes,
  parseInlineDirectives,
  splitMediaFromOutput,
} from '@/libs/openclaw-chat/shims/backend-helpers';
import type {
  ChatItem,
  MessageContentItem,
  MessageGroup,
  NormalizedMessage,
  ToolCard,
} from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

type AssistantCanvasItem = Extract<MessageContentItem, { type: 'canvas' }>;

type MessageGroupRenderOptions = {
  searchQuery?: string;
  showFooter?: boolean;
  showAvatar?: boolean;
  assistantName?: string;
  workingDirectory?: string;
};

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

export type ThinkingToolsGroupCollapse = {
  toolCount: number;
  collapsedGroup: MessageGroup;
  contentGroup: MessageGroup | null;
};

const THINKING_CONTENT_TYPES = new Set(['thinking', 'reasoning']);
const TOOL_CONTENT_TYPES = new Set([
  'toolcall',
  'tool_call',
  'tooluse',
  'tool_use',
  'toolresult',
  'tool_result',
]);

function contentBlockType(value: unknown): string {
  const block = asRecord(value);
  return typeof block?.type === 'string' ? block.type.toLowerCase() : '';
}

function isThinkingContentBlock(value: unknown): boolean {
  return THINKING_CONTENT_TYPES.has(contentBlockType(value));
}

function isToolContentBlock(value: unknown): boolean {
  return TOOL_CONTENT_TYPES.has(contentBlockType(value));
}

function isCollapsibleProcessBlock(value: unknown): boolean {
  return isThinkingContentBlock(value) || isToolContentBlock(value);
}

function isVisibleContentBlock(value: unknown): boolean {
  if (isCollapsibleProcessBlock(value)) return false;
  const block = asRecord(value);
  if (!block) return true;
  const type = contentBlockType(block);
  return type !== 'text' || typeof block.text !== 'string' || Boolean(block.text.trim());
}

export function splitThinkingToolsGroup(group: MessageGroup): ThinkingToolsGroupCollapse | null {
  if (normalizeRoleForGrouping(group.role) !== 'assistant' || group.messages.length === 0) {
    return null;
  }

  let hasThinking = false;
  let hasVisibleContent = false;
  const cards: ToolCard[] = [];
  for (const entry of group.messages) {
    const raw = asRecord(entry.message);
    const attachedToolMessages = getAttachedToolMessages(entry.message);
    if (raw?.__justdoToolActive === true || hasLiveToolMessage(attachedToolMessages)) {
      return null;
    }
    const content = Array.isArray(raw?.content) ? raw.content : [];
    for (const value of content) {
      const block = asRecord(value);
      if (!block) continue;
      if (isThinkingContentBlock(block)) {
        hasThinking = true;
        continue;
      }
      if (isVisibleContentBlock(block)) {
        hasVisibleContent = true;
      }
    }
    cards.push(
      ...(extractToolCardsCached(entry.message) as ToolCard[]),
      ...toolMessagesToCards(attachedToolMessages),
    );
  }

  const toolCount = dedupeToolCards(cards).length;
  if (!hasThinking || toolCount === 0) return null;

  if (!hasVisibleContent) {
    return { toolCount, collapsedGroup: group, contentGroup: null };
  }

  const collapsedMessages = group.messages.flatMap(entry => {
    const raw = asRecord(entry.message);
    if (!raw || !Array.isArray(raw.content)) return [entry];
    const content = raw.content.filter(isCollapsibleProcessBlock);
    if (content.length === 0 && getAttachedToolMessages(raw).length === 0) return [];
    return [
      {
        ...entry,
        message: {
          ...raw,
          content,
        },
      },
    ];
  });
  const contentMessages = group.messages.flatMap(entry => {
    const raw = asRecord(entry.message);
    if (!raw || !Array.isArray(raw.content)) return [];
    const content = raw.content.filter(isVisibleContentBlock);
    if (content.length === 0) return [];
    const {
      __justdoAttachedToolMessages: _attachedTools,
      __justdoToolActive: _toolActive,
      __justdoToolTimelineOpen: _toolTimelineOpen,
      ...contentMessage
    } = raw;
    return [{ ...entry, message: { ...contentMessage, content } }];
  });

  return {
    toolCount,
    collapsedGroup: { ...group, key: `${group.key}:thinking-tools`, messages: collapsedMessages },
    contentGroup: {
      ...group,
      key: `${group.key}:content`,
      messages: contentMessages,
    },
  };
}

export function getThinkingToolsGroupToolCount(group: MessageGroup): number | null {
  return splitThinkingToolsGroup(group)?.toolCount ?? null;
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
    const nested = [
      item.toolCallId,
      item.tool_call_id,
      item.toolUseId,
      item.tool_use_id,
      item.id,
    ].find(value => typeof value === 'string' && value.trim()) as string | undefined;
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

function safeCanvasUrl(value: string | undefined): string | null {
  const url = value?.trim();
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function renderAssistantCanvas(item: AssistantCanvasItem): TemplateResult {
  const title = item.preview.title?.trim() || i18nService.t('coworkCanvasTitle');
  const url = safeCanvasUrl(item.preview.url);
  const preferredHeight = item.preview.preferredHeight;
  const height =
    typeof preferredHeight === 'number' && Number.isFinite(preferredHeight)
      ? Math.min(800, Math.max(160, preferredHeight))
      : 360;

  return html`
    <section class="assistant-canvas" aria-label=${title}>
      <div class="assistant-canvas__title">${title}</div>
      ${
        url
          ? html`<iframe
              class="assistant-canvas__frame"
              src=${url}
              title=${title}
              style=${`height: ${height}px`}
              loading="lazy"
              referrerpolicy="no-referrer"
              sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
            ></iframe>`
          : html`<div class="assistant-canvas__unavailable">
              ${i18nService.t('coworkCanvasUnavailable')}
            </div>`
      }
    </section>
  `;
}

function extractCanvasItem(block: Record<string, unknown>): AssistantCanvasItem | null {
  if (contentBlockType(block) !== 'canvas') return null;
  const normalized = normalizeMessage({ role: 'assistant', content: [block], timestamp: 0 });
  return (
    normalized.content.find((item): item is AssistantCanvasItem => item.type === 'canvas') ?? null
  );
}

function cleanOrderedAssistantText(
  text: string,
  goalReplyContext: string,
): {
  text: string;
  canvases: AssistantCanvasItem[];
} {
  const extracted = extractCanvasShortcodes(text);
  const directives = parseInlineDirectives(stripDeliveredAttachmentLines(extracted.text), {
    stripAudioTag: true,
    stripReplyTags: true,
  });
  const visibleText = stripUnreliableGoalZeroUsageText(
    stripMessageDisplayMetadataText(directives.text),
    goalReplyContext,
  );
  return {
    text: visibleText,
    canvases: extracted.previews.map(preview => ({ type: 'canvas', preview, rawText: null })),
  };
}

function stripDeliveredAttachmentLines(text: string): string {
  const parsed = splitMediaFromOutput(text);
  return (parsed.segments ?? [])
    .filter((segment): segment is { type: 'text'; text: string } => segment.type === 'text')
    .map(segment => segment.text)
    .join('\n')
    .trim();
}

const ATTACHMENT_ICON = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <path d="M14 2v6h6"></path>
  </svg>
`;

function localPathFromAttachmentUrl(url: string): string {
  if (!url.startsWith('file://')) return url;
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname);
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return url.replace(/^file:\/\/\/?/i, '');
  }
}

function labelForMediaPath(mediaPath: string): string {
  const trimmed = mediaPath.trim();
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      return parsed.pathname.split('/').pop()?.trim() || parsed.hostname || trimmed;
    }
  } catch {
    // Fall back to path splitting below.
  }
  return trimmed.split(/[\\/]/).pop()?.trim() || trimmed;
}

function extractTranscriptAttachments(message: unknown): RenderableAttachment[] {
  return getTranscriptMedia(message)
    .map(media => {
      if (media.mimeType && isImageMimeType(media.mimeType)) return null;
      return {
        url: media.path,
        kind: media.mimeType?.startsWith('audio/') ? ('audio' as const) : ('document' as const),
        label: labelForMediaPath(media.path),
        ...(media.mimeType ? { mimeType: media.mimeType } : {}),
      };
    })
    .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);
}

async function openAttachment(event: Event, url: string, workingDirectory?: string): Promise<void> {
  event.stopPropagation();
  try {
    const localPath = localPathFromAttachmentUrl(url);
    if (!/^https?:\/\//i.test(url) && getPreviewableFileExtension(localPath)) {
      window.dispatchEvent(
        new CustomEvent('cowork:preview-file', {
          detail: { filePath: localPath, workingDirectory },
        }),
      );
      return;
    }
    const result = /^https?:\/\//i.test(url)
      ? await window.electron.shell.openExternal(url)
      : await window.electron.shell.openPath(localPath, workingDirectory);
    if (!result.success) {
      if ('notFound' in result && result.notFound) {
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkAttachmentNotFound').replace('{filepath}', url),
          }),
        );
        return;
      }
      console.error('[GroupedRender] Failed to open attachment', result.error);
    }
  } catch (error) {
    console.error('[GroupedRender] Failed to open attachment', error);
  }
}

async function showAttachmentContextMenu(
  event: Event,
  url: string,
  workingDirectory?: string,
): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  const action = await window.electron.shell.showAttachmentContextMenu();
  if (!action) return;
  if (action === 'open') {
    await openAttachment(event, url, workingDirectory);
    return;
  }

  try {
    const isExternal = /^https?:\/\//i.test(url);
    const localPath = localPathFromAttachmentUrl(url);
    const result =
      action === 'open-with-system'
        ? isExternal
          ? await window.electron.shell.openExternal(url)
          : await window.electron.shell.openPath(localPath, workingDirectory)
        : isExternal
          ? { success: false, notFound: true }
          : await window.electron.shell.showItemInFolder(localPath, workingDirectory);
    if (!result.success) {
      if ('notFound' in result && result.notFound) {
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkAttachmentNotFound').replace('{filepath}', url),
          }),
        );
        return;
      }
      console.error('[GroupedRender] Failed to handle attachment menu action', result.error);
    }
  } catch (error) {
    console.error('[GroupedRender] Failed to handle attachment menu action', error);
  }
}

function renderAssistantAttachments(
  attachments: RenderableAttachment[],
  workingDirectory?: string,
): TemplateResult | typeof nothing {
  if (attachments.length === 0) return nothing;
  return html`
    <div class="message-attachments">
      ${attachments.map(
        attachment => html`
          <button
            type="button"
            class="message-attachment"
            title=${attachment.url}
            aria-label=${`${i18nService.t('coworkOpenAttachment')}: ${attachment.label}`}
            @click=${(event: Event) => void openAttachment(event, attachment.url, workingDirectory)}
            @contextmenu=${(event: Event) =>
              void showAttachmentContextMenu(event, attachment.url, workingDirectory)}
          >
            <span class="message-attachment__icon">${ATTACHMENT_ICON}</span>
            <span class="message-attachment__name">${attachment.label}</span>
            <span class="message-attachment__open" aria-hidden="true">↗</span>
          </button>
        `,
      )}
    </div>
  `;
}

function renderMessageImages(
  images: RenderableAttachment[],
  assistant = false,
  workingDirectory?: string,
): TemplateResult | typeof nothing {
  if (images.length === 0) return nothing;
  return html`
    <div class=${`chat-bubble__images${assistant ? ' chat-bubble__images--assistant' : ''}`}>
      ${images.map(
        image => html`
          <img
            class="chat-bubble__image"
            src=${resolveImageSourceUrl(image.url, workingDirectory)}
            alt=${image.label}
            title=${image.label}
          />
        `,
      )}
    </div>
  `;
}

function resolveImageSourceUrl(url: string, workingDirectory?: string): string {
  const trimmed = url.trim();
  if (
    /^(?:https?|data|blob|localfile):/i.test(trimmed) ||
    trimmed.startsWith('/api/')
  ) {
    return trimmed;
  }

  const localPath = localPathFromAttachmentUrl(trimmed);
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(localPath) || /^[\\/]/.test(localPath);
  const baseDirectory = workingDirectory?.trim();
  if (!isAbsolute && !baseDirectory) return trimmed;

  const directory = baseDirectory ?? '';
  const resolvedPath = isAbsolute
    ? localPath
    : `${directory}${/[\\/]$/.test(directory) ? '' : '/'}${localPath}`;
  const slashPath = resolvedPath.replace(/\\/g, '/');
  const encodedPath = slashPath
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  if (slashPath.startsWith('//')) return `localfile://${encodedPath}`;
  return `localfile:///${encodedPath.replace(/^\/+/, '')}`;
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
  const goalReplyContext = content
    .map(block => {
      const record = asRecord(block);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join('\n');

  const attachedByToolId = new Map<string, unknown[]>();
  for (const attached of getAttachedToolMessages(rawMessage)) {
    const id = extractToolCallId(attached);
    if (!id) continue;
    attachedByToolId.set(id, [...(attachedByToolId.get(id) ?? []), attached]);
  }

  const ordered: Array<TemplateResult | typeof nothing> = [];
  const consumedAttached = new Set<unknown>();
  let pendingToolCards: ToolCard[] = [];

  const flushPendingToolCards = () => {
    if (pendingToolCards.length === 0) return;
    ordered.push(renderAssistantToolCards(pendingToolCards, rawMessage));
    pendingToolCards = [];
  };

  for (let index = 0; index < content.length; index += 1) {
    const block = asRecord(content[index]);
    if (!block) continue;
    const type = typeof block.type === 'string' ? block.type.toLowerCase() : '';

    if (type === 'thinking' || type === 'reasoning') {
      flushPendingToolCards();
      const thinking =
        typeof block.thinking === 'string'
          ? block.thinking
          : typeof block.text === 'string'
            ? block.text
            : '';
      if (thinking) {
        ordered.push(renderThinkingBlock(thinking));
      }
      continue;
    }

    if (type === 'text') {
      flushPendingToolCards();
      const cleaned = cleanOrderedAssistantText(
        typeof block.text === 'string' ? block.text : '',
        goalReplyContext,
      );
      ordered.push(renderAssistantTextBlock(cleaned.text));
      ordered.push(...cleaned.canvases.map(renderAssistantCanvas));
      continue;
    }

    if (type === 'canvas') {
      flushPendingToolCards();
      const canvas = extractCanvasItem(block);
      if (canvas) ordered.push(renderAssistantCanvas(canvas));
      continue;
    }

    if (
      ['toolcall', 'tool_call', 'tooluse', 'tool_use', 'toolresult', 'tool_result'].includes(type)
    ) {
      const blockMessage = { ...raw, content: [block] };
      const cards = extractToolCards(blockMessage, `inline-tool:${index}`);
      const toolCallId = extractToolCallId(blockMessage);
      const attached = toolCallId ? (attachedByToolId.get(toolCallId) ?? []) : [];
      for (const attachedMessage of attached) {
        consumedAttached.add(attachedMessage);
      }
      pendingToolCards = [...pendingToolCards, ...cards, ...toolMessagesToCards(attached)];
    }
  }
  flushPendingToolCards();

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
  opts?: MessageGroupRenderOptions,
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
      <div class="chat-group__avatar">${(opts?.showAvatar ?? true) ? avatar : nothing}</div>
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
  opts?: MessageGroupRenderOptions,
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
        ${(opts?.showAvatar ?? true) ? renderChatAvatar(role) : nothing}
      </div>
      <div class="chat-group__content">
        ${group.messages.map(m => renderSingleMessage(m.message, role, opts))}
        ${thinkingText ? renderStreamingThinkingBlock(thinkingText) : nothing}
        ${
          toolCards.length > 0
            ? renderToolTimeline(toolCards, !hasLiveToolMessage(toolMessages))
            : nothing
        }
        ${
          hasStreamText
            ? html`
                <div class="chat-bubble chat-bubble--assistant">
                  ${renderCopyButton(streamText)}
                  <div class="chat-bubble__text markdown-content">
                    ${unsafeHTML(toStreamingMarkdownHtml(streamText))}
                  </div>
                </div>
              `
            : renderReadingIndicator()
        }
      </div>
    </div>
  `;
}

function renderSingleMessage(
  message: unknown,
  role: string,
  opts?: MessageGroupRenderOptions,
): TemplateResult {
  const normalized = normalizeMessage(message) as NormalizedMessage | null;
  if (!normalized) return html`<div class="chat-bubble chat-bubble--empty"></div>`;

  const isUser = role === 'user';
  const isTool = role === 'tool';

  if (isTool) return renderToolMessage(message);
  if (isUser) return renderUserMessage(normalized, message, opts?.workingDirectory);
  return renderAssistantMessage(normalized, message, opts?.workingDirectory);
}

// ─── User Message ───────────────────────────────────────────────────────────

function renderUserMessage(
  msg: NormalizedMessage,
  rawMessage: unknown,
  workingDirectory?: string,
): TemplateResult {
  const textContent = msg.content.filter(
    (c): c is { type: 'text'; text?: string } => c.type === 'text',
  );
  const rawText = textContent.map(c => c.text ?? '').join('\n');
  const text =
    rawText.trim() === '[User sent media without caption]' &&
    msg.content.some(item => item.type === 'attachment' && item.attachment.kind === 'image')
      ? ''
      : rawText;
  const dir = detectTextDirection(text);
  const htmlContent = toSanitizedMarkdownHtml(text);
  const images = msg.content
    .filter(
      (item): item is Extract<MessageContentItem, { type: 'attachment' }> =>
        item.type === 'attachment' && item.attachment.kind === 'image',
    )
    .map(item => item.attachment);
  const attachments = msg.content
    .filter(
      (item): item is Extract<MessageContentItem, { type: 'attachment' }> =>
        item.type === 'attachment' && item.attachment.kind !== 'image',
    )
    .map(item => item.attachment);
  const visibleAttachments = [...attachments, ...extractTranscriptAttachments(rawMessage)];

  return html`
    <div class="chat-bubble chat-bubble--user" dir=${dir}>
      ${renderCopyButton(text)}
      ${renderMessageImages(images, false, workingDirectory)}
      ${renderAssistantAttachments(visibleAttachments, workingDirectory)}
      ${text
        ? html`<div class="chat-bubble__text markdown-content">${unsafeHTML(htmlContent)}</div>`
        : nothing}
    </div>
  `;
}

// ─── Assistant Message ──────────────────────────────────────────────────────

function renderAssistantMessage(
  msg: NormalizedMessage,
  rawMessage: unknown,
  workingDirectory?: string,
): TemplateResult {
  const orderedBlocks = renderAssistantMessageInContentOrder(rawMessage);
  const images = msg.content
    .filter(
      (item): item is Extract<MessageContentItem, { type: 'attachment' }> =>
        item.type === 'attachment' && item.attachment.kind === 'image',
    )
    .map(item => item.attachment);
  const attachments = msg.content
    .filter(
      (item): item is Extract<MessageContentItem, { type: 'attachment' }> =>
        item.type === 'attachment' && item.attachment.kind !== 'image',
    )
    .map(item => item.attachment);
  const canvases = msg.content.filter(
    (item): item is AssistantCanvasItem => item.type === 'canvas',
  );
  if (orderedBlocks) {
    return html`${orderedBlocks}${renderMessageImages(
      images,
      true,
      workingDirectory,
    )}${renderAssistantAttachments(attachments, workingDirectory)}`;
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
    ${
      toolCards.length > 0
        ? renderToolTimeline(toolCards, !shouldOpenToolTimeline(rawMessage))
        : nothing
    }
    ${renderAssistantTextBlock(text)} ${canvases.map(renderAssistantCanvas)}
    ${renderMessageImages(images, true, workingDirectory)}
    ${renderAssistantAttachments(attachments, workingDirectory)}
  `;
}

// ─── Thinking Block ─────────────────────────────────────────────────────────

function renderThinkingBlock(thinking: string): TemplateResult {
  const reasoning = formatReasoningMarkdown(thinking);
  return html`
    <details class="chat-thinking">
      <summary class="chat-thinking__summary">${i18nService.t('coworkThinkingLabel')}</summary>
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
  const explicitError = m.isError ?? m.is_error;
  const isError = typeof explicitError === 'boolean' ? explicitError : isToolErrorOutput(text);
  const display = resolveToolDisplay(toolName);

  return html`
    <details class="tool-message ${isError ? 'tool-message--error' : ''}">
      <summary class="tool-message__header">
        <span class="tool-message__icon">
          ${
            isError
              ? html`<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                  <path
                    d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
                  />
                </svg>`
              : html`<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                  <path
                    d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"
                  />
                </svg>`
          }
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
  const toolNames = cards
    .map(card => resolveToolDisplay(card.name).title)
    .join(i18nService.t('coworkToolTimelineNameSeparator'));
  const summary = `${cards.length} ${i18nService.t('coworkToolTimelineSummaryLabel')}: ${toolNames}`;
  return html`
    <details class="tool-timeline" ?open=${!collapsed}>
      <summary class="tool-timeline__summary">${summary}</summary>
      <ol class="tool-timeline__list">
        ${cards.map(card => renderToolTimelineItem(card))}
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

function renderToolTimelineItem(card: ToolCard): TemplateResult {
  const display = resolveToolDisplay(card.name);
  const isCompleted = card.outputText !== undefined;
  const resultText = isCompleted
    ? card.outputText || i18nService.t('coworkToolNoOutput')
    : i18nService.t('coworkToolRunning');
  const summaryInput = formatToolTimelineSummaryInput(card);
  const statusClass = isToolCardError(card)
    ? 'tool-timeline__item--error'
    : isCompleted
      ? 'tool-timeline__item--completed'
      : 'tool-timeline__item--running';
  return html`
    <li class="tool-timeline__item ${statusClass}">
      <div class="tool-timeline__marker" aria-hidden="true"></div>
      <details class="tool-timeline__body">
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
    if (modelName === 'openclaw/gateway-injected' || modelName === 'gateway-injected') {
      return i18nService.t('coworkSystemMessageLabel');
    }
    return (
      modelName || assistantName?.trim() || senderLabel || i18nService.t('coworkAssistantLabel')
    );
  }
  if (group.role === 'user') {
    return i18nService.t('coworkYouLabel');
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

export function renderThinkingToolsContentGroup(
  contentGroup: MessageGroup,
  sourceGroup: MessageGroup,
  nextItem: ChatItem | MessageGroup | null | undefined,
  opts?: Omit<MessageGroupRenderOptions, 'showFooter' | 'showAvatar'>,
): TemplateResult | typeof nothing {
  return renderMessageGroup(contentGroup, {
    ...opts,
    showFooter: shouldRenderGroupFooterByNextItem(sourceGroup, nextItem),
    showAvatar: false,
  });
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
        ${(opts?.showAvatar ?? true) ? renderChatAvatar('assistant') : nothing}
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
        ${(opts?.showAvatar ?? true) ? renderChatAvatar('assistant') : nothing}
      </div>
      <div class="chat-group__content">
        ${thinkingText ? renderStreamingThinkingBlock(thinkingText) : nothing}
        ${
          toolCards.length > 0
            ? renderToolTimeline(toolCards, !hasLiveToolMessage(toolMessages))
            : nothing
        }
        ${
          hasText
            ? html`
                <div class="chat-bubble chat-bubble--assistant">
                  ${renderCopyButton(text)}
                  <div class="chat-bubble__text markdown-content">
                    ${unsafeHTML(toStreamingMarkdownHtml(text))}
                  </div>
                </div>
              `
            : renderReadingIndicator()
        }
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
        <span class="chat-thinking__label">${i18nService.t('coworkThinkingLabel')}</span>
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
        ${(opts?.showAvatar ?? true) ? renderChatAvatar('assistant') : nothing}
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
