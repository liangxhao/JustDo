/**
 * Ordinary message rendering for persisted Content and streaming text.
 * Thinking and Tool presentation belongs exclusively to the canonical timeline.
 */
import { isImageMimeType } from '@shared/cowork/attachments';
import { getPreviewableFileExtension } from '@shared/filePreview';
import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { getTranscriptMedia, type RenderableAttachment } from '@/libs/openclaw-chat/attachments';
import { renderChatAvatar } from '@/libs/openclaw-chat/components/chat-avatar';
import {
  toSanitizedMarkdownHtml,
  toStreamingMarkdownHtml,
} from '@/libs/openclaw-chat/components/markdown';
import {
  normalizeMessage,
  stripMessageDisplayMetadataText,
  stripUnreliableGoalZeroUsageText,
} from '@/libs/openclaw-chat/pipeline/message-normalizer';
import { normalizeRoleForGrouping } from '@/libs/openclaw-chat/pipeline/role-normalizer';
import { detectTextDirection } from '@/libs/openclaw-chat/pipeline/text-direction';
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
} from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

type AssistantCanvasItem = Extract<MessageContentItem, { type: 'canvas' }>;

type MessageRenderOptions = {
  searchQuery?: string;
  showFooter?: boolean;
  showAvatar?: boolean;
  assistantName?: string;
  workingDirectory?: string;
};

type AssistantTimelineContentOptions = Pick<
  MessageRenderOptions,
  'showAvatar' | 'workingDirectory'
> & {
  key: string;
  timestamp: number;
  streaming: boolean;
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

function contentBlockType(value: unknown): string {
  const block = asRecord(value);
  return typeof block?.type === 'string' ? block.type.toLowerCase() : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  if (/^(?:https?|data|blob|localfile):/i.test(trimmed) || trimmed.startsWith('/api/')) {
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

  const ordered: Array<TemplateResult | typeof nothing> = [];

  for (let index = 0; index < content.length; index += 1) {
    const block = asRecord(content[index]);
    if (!block) continue;
    const type = typeof block.type === 'string' ? block.type.toLowerCase() : '';

    if (type === 'thinking' || type === 'reasoning') {
      // The canonical timeline exclusively owns Thinking presentation.
      continue;
    }

    if (type === 'text') {
      const cleaned = cleanOrderedAssistantText(
        typeof block.text === 'string' ? block.text : '',
        goalReplyContext,
      );
      ordered.push(renderAssistantTextBlock(cleaned.text));
      ordered.push(...cleaned.canvases.map(renderAssistantCanvas));
      continue;
    }

    if (type === 'canvas') {
      const canvas = extractCanvasItem(block);
      if (canvas) ordered.push(renderAssistantCanvas(canvas));
      continue;
    }

    if (
      ['toolcall', 'tool_call', 'tooluse', 'tool_use', 'toolresult', 'tool_result'].includes(type)
    ) {
      continue;
    }
  }

  return ordered.length > 0 ? ordered : null;
}

// ─── Message Group Rendering ────────────────────────────────────────────────

export function renderMessageBlock(
  group: MessageGroup,
  opts?: MessageRenderOptions,
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

export function renderMessageBlockWithTrailingStream(
  group: MessageGroup,
  streamText: string,
  thinkingText: string | null = null,
  opts?: MessageRenderOptions,
): TemplateResult | typeof nothing {
  if (!group.messages || group.messages.length === 0) return nothing;

  const role = normalizeRoleForGrouping(group.role);
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
  opts?: MessageRenderOptions,
): TemplateResult | typeof nothing {
  const normalized = normalizeMessage(message) as NormalizedMessage | null;
  if (!normalized) return html`<div class="chat-bubble chat-bubble--empty"></div>`;

  const isUser = role === 'user';
  const isTool = role === 'tool';

  // The canonical timeline exclusively owns Tool presentation.
  if (isTool) return nothing;
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
      ${renderCopyButton(text)} ${renderMessageImages(images, false, workingDirectory)}
      ${renderAssistantAttachments(visibleAttachments, workingDirectory)}
      ${
        text
          ? html`<div class="chat-bubble__text markdown-content">${unsafeHTML(htmlContent)}</div>`
          : nothing
      }
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

  const textContent = msg.content.filter(
    (c): c is { type: 'text'; text?: string } => c.type === 'text',
  );
  const text = textContent.map(c => c.text ?? '').join('\n');

  return html`
    ${renderAssistantTextBlock(text)} ${canvases.map(renderAssistantCanvas)}
    ${renderMessageImages(images, true, workingDirectory)}
    ${renderAssistantAttachments(attachments, workingDirectory)}
  `;
}

/**
 * Render canonical active-turn Content with the same group and bubble structure
 * used by persisted assistant messages. Keeping this adapter here prevents the
 * live and history projections from drifting visually.
 */
export function renderAssistantTimelineContent(
  text: string,
  opts: AssistantTimelineContentOptions,
): TemplateResult {
  if (opts.streaming) {
    return renderStreamingGroup(text, opts.timestamp, null, {
      showAvatar: opts.showAvatar,
    });
  }

  return renderMessageBlock(
    {
      kind: 'group',
      key: opts.key,
      role: 'assistant',
      messages: [
        {
          key: `${opts.key}:message`,
          message: {
            role: 'assistant',
            content: text,
            timestamp: opts.timestamp,
          },
        },
      ],
      timestamp: opts.timestamp,
      isStreaming: false,
    },
    {
      showAvatar: opts.showAvatar,
      showFooter: false,
      workingDirectory: opts.workingDirectory,
    },
  ) as TemplateResult;
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
  thinkingText: string | null = null,
  opts?: { showAvatar?: boolean },
): TemplateResult {
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
