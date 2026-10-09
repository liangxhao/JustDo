import './message-media';

/**
 * Ordinary message rendering for persisted Content and streaming text.
 * Thinking and Tool presentation belongs exclusively to the canonical timeline.
 */
import { isLocalHtmlFilePath, parseLocalHtmlLink } from '@shared/browser/browserLinkOpening';
import { getPreviewableFileExtension } from '@shared/preview/filePreview';
import { isGatewayInjectedModelRef } from '@shared/providers/modelRef';
import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import { openMessageHtmlLink, openMessageWebLink } from '@/features/browser/messageBrowserLinks';
import { renderMessageQuoteText } from '@/features/cowork/components/composer/messageQuote';
import { isImageFilePath } from '@/features/cowork/components/preview/imageFilePreview';
import {
  getTranscriptMedia,
  isTranscriptImage,
  type RenderableAttachment,
} from '@/libs/openclaw-chat/attachments';
import { renderChatAvatar } from '@/libs/openclaw-chat/components/chat-avatar';
import {
  toSanitizedMarkdownHtml,
  toStreamingMarkdownHtml,
} from '@/libs/openclaw-chat/components/markdown';
import { formatActiveTurnDuration } from '@/libs/openclaw-chat/model/active-turn-footer';
import { extractTextCached } from '@/libs/openclaw-chat/pipeline/message-extract';
import { normalizeMessage } from '@/libs/openclaw-chat/pipeline/message-normalizer';
import { normalizeRoleForGrouping } from '@/libs/openclaw-chat/pipeline/role-normalizer';
import { detectTextDirection } from '@/libs/openclaw-chat/pipeline/text-direction';
import type {
  ChatItem,
  MessageContentItem,
  MessageGroup,
  NormalizedMessage,
  UserMessageHistoryAction,
} from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

import { readTranscriptIdentity } from '../model/transcript-identity';
import { renderBrowserAnnotation } from './browser-annotation-message';
import { renderBrowserRecording } from './browser-recording-message';

type AssistantCanvasItem = Extract<MessageContentItem, { type: 'canvas' }>;

type MessageRenderOptions = {
  searchQuery?: string;
  showFooter?: boolean;
  showAvatar?: boolean;
  assistantName?: string;
  assistantAvatar?: TemplateResult;
  peerColors?: Readonly<Record<string, string>>;
  peerNames?: Readonly<Record<string, string>>;
  peerPerspective?: boolean;
  workingDirectory?: string;
  speechState?: 'idle' | 'loading' | 'playing';
  onSpeak?: (groupKey: string, text: string) => void;
  userMessageActions?: {
    entryId: string;
    canEdit?: boolean;
    canWithdraw?: boolean;
    onAction: (action: UserMessageHistoryAction, entryId: string) => void;
    editor?: {
      value: string;
      submitting: boolean;
      onChange: (value: string) => void;
      onCancel: () => void;
      onSubmit: () => void;
    };
  };
  assistantMessageFork?: {
    entryId: string;
    onFork: (entryId: string) => void;
  };
};

type AssistantTimelineContentOptions = Pick<
  MessageRenderOptions,
  'onSpeak' | 'showAvatar' | 'speechState' | 'workingDirectory' | 'assistantAvatar'
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

const SPEAKER_ICON = html`
  <svg
    class="message-speech__icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    aria-hidden="true"
  >
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
    ></path>
  </svg>
`;

const PLAYING_SPEECH_ICON = html`
  <span class="message-speech__wave" aria-hidden="true">
    <span></span><span></span><span></span><span></span>
  </span>
`;

const EDIT_ICON = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.8"
      d="m16.86 3.49 3.65 3.65M5 19l3.9-.78L19.6 7.52a2.58 2.58 0 0 0-3.65-3.65L5.25 14.57 5 19Z"
    ></path>
  </svg>
`;

const WITHDRAW_ICON = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.8"
      d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 10v6m4-6v6"
    ></path>
  </svg>
`;

const FORK_ICON = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.8"
      d="M7 4v4a4 4 0 0 0 4 4h6m0 0-3-3m3 3-3 3M7 20v-4"
    ></path>
  </svg>
`;

function renderUserMessageActions(
  actions: NonNullable<MessageRenderOptions['userMessageActions']>,
): TemplateResult {
  const editLabel = i18nService.t('coworkEditLastMessage');
  const withdrawLabel = i18nService.t('coworkWithdrawLastMessage');
  return html`
    <span class="user-message-actions">
      ${
        actions.canEdit
          ? html`
              <button
                type="button"
                class="user-message-action user-message-action--edit"
                aria-label=${editLabel}
                title=${editLabel}
                @click=${(event: Event) => {
                  event.stopPropagation();
                  actions.onAction('edit', actions.entryId);
                }}
              >
                ${EDIT_ICON}
              </button>
            `
          : nothing
      }
      ${
        actions.canWithdraw
          ? html`
              <button
                type="button"
                class="user-message-action user-message-action--withdraw"
                aria-label=${withdrawLabel}
                title=${withdrawLabel}
                @click=${(event: Event) => {
                  event.stopPropagation();
                  actions.onAction('withdraw', actions.entryId);
                }}
              >
                ${WITHDRAW_ICON}
              </button>
            `
          : nothing
      }
    </span>
  `;
}

function renderAssistantMessageFork(
  action: NonNullable<MessageRenderOptions['assistantMessageFork']>,
): TemplateResult {
  const label = i18nService.t('coworkForkFromMessage');
  return html`
    <button
      type="button"
      class="assistant-message-action assistant-message-action--fork"
      aria-label=${label}
      title=${label}
      @click=${(event: Event) => {
        event.stopPropagation();
        action.onFork(action.entryId);
      }}
    >
      ${FORK_ICON}
    </button>
  `;
}

function renderUserMessageEditor(
  editor: NonNullable<NonNullable<MessageRenderOptions['userMessageActions']>['editor']>,
): TemplateResult {
  return html`
    <div class="user-message-editor">
      <textarea
        class="user-message-editor__input"
        .value=${editor.value}
        ?disabled=${editor.submitting}
        aria-label=${i18nService.t('coworkEditLastMessageInput')}
        @input=${(event: Event) => editor.onChange((event.currentTarget as HTMLTextAreaElement).value)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            editor.onCancel();
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            editor.onSubmit();
          }
        }}
      ></textarea>
      <div class="user-message-editor__actions">
        <button type="button" ?disabled=${editor.submitting} @click=${editor.onCancel}>
          ${i18nService.t('cancel')}
        </button>
        <button
          type="button"
          class="user-message-editor__submit"
          ?disabled=${editor.submitting}
          @click=${editor.onSubmit}
        >
          ${i18nService.t('coworkSendMessage')}
        </button>
      </div>
    </div>
  `;
}

const copyFeedbackTimers = new WeakMap<HTMLButtonElement, number>();
const copyRequests = new WeakMap<HTMLButtonElement, symbol>();

function clearCopyFeedbackTimer(button: HTMLButtonElement): void {
  const activeTimer = copyFeedbackTimers.get(button);
  if (activeTimer !== undefined) window.clearTimeout(activeTimer);
  copyFeedbackTimers.delete(button);
}

async function copyMessage(event: Event, text: string, label: string): Promise<void> {
  event.stopPropagation();
  const button = event.currentTarget as HTMLButtonElement;
  const request = Symbol();
  copyRequests.set(button, request);
  clearCopyFeedbackTimer(button);
  const isCurrent = () => button.isConnected && copyRequests.get(button) === request;
  try {
    await navigator.clipboard.writeText(text);
    if (!isCurrent()) return;
    button.classList.add('message-copy--copied');
    button.title = i18nService.t('copied');
    button.setAttribute('aria-label', button.title);
    const timer = window.setTimeout(() => {
      if (!isCurrent()) return;
      button.classList.remove('message-copy--copied');
      button.title = label;
      button.setAttribute('aria-label', label);
      copyFeedbackTimers.delete(button);
    }, 1500);
    copyFeedbackTimers.set(button, timer);
  } catch {
    if (!isCurrent()) return;
    button.classList.remove('message-copy--copied');
    button.title = i18nService.t('messageCopyFailed');
    button.setAttribute('aria-label', button.title);
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: button.title }));
  }
}

export function renderCopyButton(
  text: string,
  label = i18nService.t('copyToClipboard'),
): TemplateResult {
  return html`
    <button
      type="button"
      class="message-copy"
      aria-label=${label}
      title=${label}
      @click=${(event: Event) => void copyMessage(event, text, label)}
    >
      ${COPY_ICON}
    </button>
  `;
}

function renderSpeechButton(
  groupKey: string,
  text: string,
  opts?: MessageRenderOptions,
): TemplateResult | typeof nothing {
  if (!text || !opts?.onSpeak) return nothing;
  const state = opts.speechState ?? 'idle';
  const label = i18nService.t(state === 'idle' ? 'localTtsPlay' : 'localTtsStop');
  return html`
    <button
      type="button"
      class=${`message-speech message-speech--${state}`}
      aria-label=${label}
      title=${label}
      @click=${() => opts.onSpeak?.(groupKey, text)}
    >
      ${
        state === 'loading'
          ? html`<span class="message-speech__loading" aria-hidden="true"></span>`
          : state === 'playing'
            ? PLAYING_SPEECH_ICON
            : SPEAKER_ICON
      }
    </button>
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
    if (parsed.hostname) return `//${decodeURIComponent(parsed.hostname)}${pathname}`;
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return url.replace(/^file:\/\/\/?/i, '');
  }
}

function resolveAttachmentUrl(url: string, workingDirectory?: string): string {
  const trimmed = url.trim();
  const isAbsoluteLocalPath = /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(trimmed);
  const hasProtocol = /^[A-Za-z][A-Za-z\d+.-]*:/u.test(trimmed);
  const directory = workingDirectory?.trim();
  if (!trimmed || isAbsoluteLocalPath || hasProtocol || !directory) return trimmed;

  const separator = directory.includes('\\') ? '\\' : '/';
  return `${directory.replace(/[\\/]+$/u, '')}${separator}${trimmed.replace(/^[\\/]+/u, '')}`;
}

type AttachmentOpenOptions = {
  workingDirectory?: string;
};

function isHtmlDocumentPath(filePath: string): boolean {
  return /\.(?:html?|xhtml)$/iu.test(filePath);
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
      if (isTranscriptImage(media)) return null;
      return {
        url: media.path,
        kind:
          media.mimeType?.startsWith('audio/') ||
          media.kind === 'audio' ||
          /\.(mp3|wav|ogg|m4a|flac|aac)(?:[?#].*)?$/i.test(media.path)
            ? ('audio' as const)
            : media.mimeType?.startsWith('video/') ||
                media.kind === 'video' ||
                /\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(media.path)
              ? ('video' as const)
              : ('document' as const),
        label: media.fileName || labelForMediaPath(media.path),
        ...(media.mimeType ? { mimeType: media.mimeType } : {}),
      };
    })
    .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);
}

async function openAttachment(
  event: Event,
  source: string,
  options: AttachmentOpenOptions = {},
): Promise<void> {
  event.stopPropagation();
  try {
    const url = resolveAttachmentUrl(source, options.workingDirectory);
    const localPath = localPathFromAttachmentUrl(url);
    if (/^https?:\/\//i.test(url)) {
      await openMessageWebLink(url);
      return;
    }
    const htmlLink = /^file:/iu.test(url)
      ? parseLocalHtmlLink(url)
      : isLocalHtmlFilePath(localPath)
        ? { filePath: localPath, navigationSuffix: '' }
        : parseLocalHtmlLink(encodeURI(url));
    if (htmlLink) {
      openMessageHtmlLink(
        localPathFromAttachmentUrl(htmlLink.filePath),
        options.workingDirectory,
        htmlLink.navigationSuffix,
      );
      return;
    }
    // Invalid file URLs for HTML still go through the preview boundary instead
    // of being handed to the operating system as a network/device path.
    if (isHtmlDocumentPath(localPath)) {
      openMessageHtmlLink(url, options.workingDirectory);
      return;
    }
    if (
      !/^https?:\/\//i.test(url) &&
      (getPreviewableFileExtension(localPath) || isImageFilePath(localPath))
    ) {
      window.dispatchEvent(
        new CustomEvent('cowork:preview-file', {
          detail: { filePath: localPath, workingDirectory: options.workingDirectory },
        }),
      );
      return;
    }
    const result = await window.electron.shell.openPath(localPath, options.workingDirectory);
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
  source: string,
  options: AttachmentOpenOptions = {},
): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  const action = await window.electron.shell.showAttachmentContextMenu();
  if (!action) return;
  if (action === 'open') {
    await openAttachment(event, source, options);
    return;
  }
  try {
    const url = resolveAttachmentUrl(source, options.workingDirectory);
    const isExternal = /^https?:\/\//i.test(url);
    const localPath = localPathFromAttachmentUrl(url);
    const result =
      action === 'open-with-system'
        ? isExternal
          ? await window.electron.shell.openExternal(url)
          : await window.electron.shell.openPath(localPath, options.workingDirectory)
        : isExternal
          ? { success: false, notFound: true }
          : await window.electron.shell.showItemInFolder(localPath, options.workingDirectory);
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

export function renderAssistantAttachments(
  attachments: RenderableAttachment[],
  workingDirectory?: string,
): TemplateResult | typeof nothing {
  if (attachments.length === 0) return nothing;
  return html`
    <div class="message-attachments">
      ${attachments.map(attachment => {
        if (attachment.kind === 'audio' || attachment.kind === 'video') {
          const src = resolveImageSourceUrl(attachment.url, workingDirectory).replace(
            /^localfile:\/\/\//i,
            'localmedia://local/',
          );
          if (/^(?:localmedia:|blob:|data:(?:audio|video)\/)/i.test(src)) {
            return html`<justdo-message-media
              .src=${src}
              .kind=${attachment.kind}
              .label=${attachment.label}
            ></justdo-message-media>`;
          }
        }
        const managed = /^\/api\/chat\/media\/outgoing\//u.test(attachment.url.trim());
        const source = managed ? undefined : attachment.url;
        const canOpen = Boolean(source);
        const url = source ? resolveAttachmentUrl(source, workingDirectory) : '';
        const unavailable = i18nService
          .t('coworkAttachmentUnavailable')
          .replace('{filename}', attachment.label);
        const openOptions: AttachmentOpenOptions = {
          workingDirectory,
        };
        return html`
          <button
            type="button"
            class=${`message-attachment${canOpen ? '' : ' message-attachment--unavailable'}`}
            title=${canOpen ? url : unavailable}
            aria-label=${`${i18nService.t('coworkOpenAttachment')}: ${attachment.label}`}
            ?disabled=${!canOpen}
            @click=${
              canOpen ? (event: Event) => void openAttachment(event, source!, openOptions) : nothing
            }
            @contextmenu=${
              canOpen
                ? (event: Event) => void showAttachmentContextMenu(event, source!, openOptions)
                : nothing
            }
          >
            <span class="message-attachment__icon">${ATTACHMENT_ICON}</span>
            <span class="message-attachment__content">
              <span class="message-attachment__name">${attachment.label}</span>
            </span>
            <span class="message-attachment__open" aria-hidden="true">↗</span>
          </button>
        `;
      })}
    </div>
  `;
}

function renderAttachmentError(
  item: Extract<MessageContentItem, { type: 'attachment_error' }>,
): TemplateResult {
  const { attachment } = item;
  const unavailable = i18nService
    .t('coworkAttachmentUnavailable')
    .replace('{filename}', attachment.label);
  return html`
    <div
      class="message-attachment message-attachment--unavailable"
      title=${unavailable}
      aria-label=${unavailable}
    >
      <span class="message-attachment__icon">${ATTACHMENT_ICON}</span>
      <span class="message-attachment__content">
        <span class="message-attachment__name message-attachment__name--with-warning">
          <span class="message-attachment__filename">${attachment.label}</span>
          <span class="message-attachment__warning" title=${unavailable} aria-label=${unavailable}>
            !
          </span>
        </span>
      </span>
    </div>
  `;
}

export function renderMessageImages(
  images: RenderableAttachment[],
  assistant = false,
  workingDirectory?: string,
): TemplateResult | typeof nothing {
  if (images.length === 0) return nothing;
  return html`
    <div
      class=${`chat-bubble__images${assistant ? ' chat-bubble__images--assistant' : ''}`}
      style=${`--image-columns: ${images.length}`}
    >
      ${images.map(image => {
        const sourceUrl = resolveImageSourceUrl(image.url, workingDirectory);
        return renderListedAttachment(
          image,
          html`
            <img
              class="chat-bubble__image"
              src=${sourceUrl}
              alt=${image.label}
              title=${`${image.label} · ${i18nService.t('coworkImageOpenPreviewHint')}`}
              draggable="false"
              @contextmenu=${(event: Event) => void showImageContextMenu(event, sourceUrl)}
            />
          `,
        );
      })}
    </div>
  `;
}

function renderListedAttachment(
  attachment: RenderableAttachment,
  content: TemplateResult | typeof nothing,
): TemplateResult | typeof nothing {
  const marker = attachment.listMarker;
  if (!marker) return content;
  return html`
    <div class="message-attachment-list-item">
      <span class="message-attachment-list-item__marker" aria-hidden="true"
        >${marker === '-' ? '•' : marker}</span
      >
      <div class="message-attachment-list-item__content">${content}</div>
    </div>
  `;
}

export async function showImageContextMenu(event: Event, sourceUrl: string): Promise<void> {
  event.preventDefault();
  event.stopPropagation();

  const image = event.currentTarget;
  const imageUrl = image instanceof HTMLImageElement ? image.currentSrc || image.src : sourceUrl;
  try {
    const result = await window.electron.shell.showImageContextMenu(imageUrl);
    if (result.success) return;
    window.dispatchEvent(
      new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkSaveImageFailed'),
      }),
    );
    console.error('[GroupedRender] Failed to save image', result.error);
  } catch (error) {
    window.dispatchEvent(
      new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkSaveImageFailed'),
      }),
    );
    console.error('[GroupedRender] Failed to show image context menu', error);
  }
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

type BubbleContentItem =
  | { type: 'text'; text?: string; name?: string; args?: unknown }
  | Extract<MessageContentItem, { type: 'browser_annotation' }>
  | Extract<MessageContentItem, { type: 'browser_recording' }>
  | Extract<MessageContentItem, { type: 'attachment' | 'attachment_error' }>;

function renderOrderedBubble(
  items: BubbleContentItem[],
  role: 'user' | 'assistant',
  workingDirectory?: string,
  trailingAction: TemplateResult | typeof nothing = nothing,
): TemplateResult | typeof nothing {
  if (items.length === 0) return nothing;
  const text = items
    .filter((item): item is Extract<BubbleContentItem, { type: 'text' }> => item.type === 'text')
    .map(item => item.text ?? '')
    .filter(Boolean)
    .join('\n');
  const dir = detectTextDirection(text);
  const groupedItems: (BubbleContentItem | RenderableAttachment[])[] = [];
  for (const item of items) {
    if (item.type === 'text' && !item.text?.trim()) continue;
    if (item.type === 'attachment' && item.attachment.kind === 'image') {
      const previous = groupedItems[groupedItems.length - 1];
      if (Array.isArray(previous) && previous.length < 3) {
        previous.push(item.attachment);
      } else {
        groupedItems.push([item.attachment]);
      }
    } else {
      groupedItems.push(item);
    }
  }

  return html`
    <div class=${`chat-bubble chat-bubble--${role}`} dir=${dir}>
      ${text ? renderCopyButton(text) : nothing}
      <div class="chat-bubble__content">
        ${groupedItems.map(item => {
          if (Array.isArray(item)) {
            return renderMessageImages(item, role === 'assistant', workingDirectory);
          }
          if (item.type === 'text') {
            if (!item.text) return nothing;
            return html`
              <div class="chat-bubble__text markdown-content" dir=${detectTextDirection(item.text)}>
                ${unsafeHTML(toSanitizedMarkdownHtml(item.text))}
              </div>
            `;
          }
          if (item.type === 'attachment_error') {
            return renderAttachmentError(item);
          }
          if (item.type === 'browser_recording') {
            return renderBrowserRecording(item.recording);
          }
          if (item.type === 'browser_annotation') {
            return renderBrowserAnnotation(item);
          }
          return renderListedAttachment(
            item.attachment,
            renderAssistantAttachments([item.attachment], workingDirectory),
          );
        })}
      </div>
      ${trailingAction}
    </div>
  `;
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

  const peerLabel = group.senderId
    ? opts?.peerNames?.[group.senderId] || group.senderLabel || group.senderId
    : '';
  const localAssistant =
    opts?.peerPerspective && role === 'assistant' && opts.assistantName
      ? { id: `local:${opts.assistantName}`, label: opts.assistantName }
      : undefined;
  const avatar =
    (role === 'assistant' && !group.senderId ? opts?.assistantAvatar : undefined) ??
    renderChatAvatar(
      role,
      group.senderId
        ? { id: group.senderId, label: peerLabel, color: opts?.peerColors?.[group.senderId] }
        : localAssistant,
    );
  const showAvatar = opts?.showAvatar ?? true;
  const isContinuation = !showAvatar;
  const speechText =
    group.role === 'assistant'
      ? group.messages
          .map(message => extractTextCached(message.message)?.trim() ?? '')
          .filter(Boolean)
          .join('\n\n')
      : '';
  let speechMessageIndex = -1;
  group.messages.forEach((message, index) => {
    if (extractTextCached(message.message)?.trim()) speechMessageIndex = index;
  });
  const speechAction = renderSpeechButton(group.key, speechText, opts);

  return html`
    <div
      class=${`chat-group chat-group--${role} chat-group--content${
        isContinuation ? ' chat-group--continuation' : ''
      }`}
      data-group-key=${group.key}
    >
      <div class="chat-group__avatar">${showAvatar ? avatar : nothing}</div>
      <div class="chat-group__content">
        ${
          opts?.userMessageActions?.editor
            ? renderUserMessageEditor(opts.userMessageActions.editor)
            : html`${group.messages.map((message, index) =>
                renderSingleMessage(
                  message.message,
                  role,
                  opts,
                  index === speechMessageIndex ? speechAction : nothing,
                ),
              )}
              ${renderGroupFooter(group, opts)}`
        }
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
      class=${`chat-group chat-group--${role} chat-group--content chat-group--streaming${
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
  trailingAction: TemplateResult | typeof nothing = nothing,
): TemplateResult | typeof nothing {
  const normalized = normalizeMessage(message) as NormalizedMessage | null;
  if (!normalized) return html`<div class="chat-bubble chat-bubble--empty"></div>`;

  const isUser = role === 'user';
  const isTool = role === 'tool';

  // The canonical timeline exclusively owns Tool presentation.
  if (isTool) return nothing;
  if (isUser) {
    return renderUserMessage(normalized, message, opts?.workingDirectory);
  }
  const identity = readTranscriptIdentity(message);
  return html`<div
    data-quote-source
    data-assistant-entry=${identity?.kind === 'openclaw-id' ? identity.value : nothing}
  >
    ${renderAssistantMessage(normalized, message, opts?.workingDirectory, trailingAction)}
  </div>`;
}

// ─── User Message ───────────────────────────────────────────────────────────

function renderUserMessage(
  msg: NormalizedMessage,
  rawMessage: unknown,
  workingDirectory?: string,
): TemplateResult {
  const hasImage = msg.content.some(
    item => item.type === 'attachment' && item.attachment.kind === 'image',
  );
  const content = msg.content.flatMap<BubbleContentItem>(item => {
    if (item.type === 'attachment') return [item];
    if (item.type === 'browser_annotation') return [item];
    if (item.type === 'browser_recording') return [item];
    if (item.type !== 'text') return [];
    if (hasImage && item.text?.trim() === '[User sent media without caption]') return [];
    return [
      {
        type: 'text',
        text: item.text
          ? renderMessageQuoteText(item.text, i18nService.t('messageQuoteLabel'))
          : item.text,
      },
    ];
  });
  const transcriptAttachments = extractTranscriptAttachments(rawMessage).map(attachment => ({
    type: 'attachment' as const,
    attachment,
  }));

  return renderOrderedBubble(
    [...content, ...transcriptAttachments],
    'user',
    workingDirectory,
  ) as TemplateResult;
}

// ─── Assistant Message ──────────────────────────────────────────────────────

function renderAssistantMessage(
  msg: NormalizedMessage,
  rawMessage: unknown,
  workingDirectory?: string,
  trailingAction: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  const sections: Array<
    | { kind: 'bubble'; items: BubbleContentItem[] }
    | { kind: 'content'; content: TemplateResult | typeof nothing }
  > = [];
  let bubbleItems: BubbleContentItem[] = [];
  const flushBubble = () => {
    if (bubbleItems.length === 0) return;
    sections.push({ kind: 'bubble', items: bubbleItems });
    bubbleItems = [];
  };

  const existingUrls = new Set(
    msg.content.flatMap(item => (item.type === 'attachment' ? [item.attachment.url] : [])),
  );
  const media = extractTranscriptAttachments(rawMessage).filter(
    item => !existingUrls.has(item.url),
  );
  const content = [
    ...msg.content,
    ...media.map(attachment => ({ type: 'attachment' as const, attachment })),
  ];
  for (const item of content) {
    if (item.type === 'attachment' || item.type === 'attachment_error') {
      bubbleItems.push(item);
      continue;
    }
    if (item.type === 'text') {
      bubbleItems.push({ type: 'text', text: item.text });
      continue;
    }
    if (item.type === 'canvas') {
      flushBubble();
      sections.push({ kind: 'content', content: renderAssistantCanvas(item) });
    }
  }
  flushBubble();

  let lastBubbleIndex = -1;
  sections.forEach((section, index) => {
    if (section.kind === 'bubble') lastBubbleIndex = index;
  });
  return html`${sections.map((section, index) =>
    section.kind === 'bubble'
      ? renderOrderedBubble(
          section.items,
          'assistant',
          workingDirectory,
          index === lastBubbleIndex ? trailingAction : nothing,
        )
      : section.content,
  )}`;
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
    return html`<div data-quote-source>
      ${renderStreamingGroup(text, opts.timestamp, null, {
        showAvatar: opts.showAvatar,
        assistantAvatar: opts.assistantAvatar,
      })}
    </div>`;
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
      assistantAvatar: opts.assistantAvatar,
      showFooter: false,
      speechState: opts.speechState,
      onSpeak: opts.onSpeak,
      workingDirectory: opts.workingDirectory,
    },
  ) as TemplateResult;
}

// ─── Group Footer ───────────────────────────────────────────────────────────

function renderGroupFooter(
  group: MessageGroup,
  opts?: MessageRenderOptions,
): TemplateResult | typeof nothing {
  const userMessageActions = group.role === 'user' ? opts?.userMessageActions : undefined;
  const assistantMessageFork = group.role === 'assistant' ? opts?.assistantMessageFork : undefined;
  const showMetadata = opts?.showFooter ?? true;
  if (!showMetadata && !userMessageActions && !assistantMessageFork) return nothing;
  const ts = group.timestamp;
  if ((!ts || !showMetadata) && !userMessageActions && !assistantMessageFork) return nothing;
  const date = new Date(ts);
  const time = ts && showMetadata ? formatGroupTimestamp(date) : '';
  const roleName = showMetadata
    ? getGroupFooterLabel(group, opts?.assistantName, opts?.peerNames, opts?.peerPerspective)
    : '';
  const duration =
    group.role === 'assistant' &&
    typeof group.durationMs === 'number' &&
    Number.isFinite(group.durationMs) &&
    group.durationMs >= 0
      ? formatActiveTurnDuration(group.durationMs)
      : null;
  return html`
    <div class="chat-group__footer">
      ${userMessageActions ? renderUserMessageActions(userMessageActions) : nothing}
      ${roleName ? html`<span class="chat-group__sender">${roleName}</span>` : nothing}
      ${
        roleName
          ? html`<span class="chat-group__footer-separator" aria-hidden="true">·</span>`
          : nothing
      }
      ${ts && showMetadata ? html`<time class="chat-group__timestamp" datetime=${date.toISOString()}>${time}</time>` : nothing}
      ${
        duration
          ? html`
              <span class="chat-group__footer-separator" aria-hidden="true">·</span>
              <span
                >${i18nService.t('coworkRunWorkedDuration').replace('{duration}', duration)}</span
              >
            `
          : nothing
      }
      ${assistantMessageFork ? renderAssistantMessageFork(assistantMessageFork) : nothing}
    </div>
  `;
}

export function getGroupFooterLabel(
  group: MessageGroup,
  assistantName?: string,
  peerNames?: Readonly<Record<string, string>>,
  peerPerspective = false,
): string {
  if (group.senderId) return peerNames?.[group.senderId] || group.senderLabel || group.senderId;
  if (group.role === 'assistant') {
    if (peerPerspective && assistantName) return assistantName;
    const modelName = group.modelName?.trim() ?? '';
    const senderLabel = group.senderLabel?.trim() ?? '';
    if (isGatewayInjectedModelRef(modelName) || isGatewayInjectedModelRef(senderLabel)) {
      return i18nService.t('coworkSystemMessageLabel');
    }
    return modelName || senderLabel || i18nService.t('coworkAssistantLabel');
  }
  if (group.role === 'user') {
    return group.senderLabel?.trim() || i18nService.t('coworkYouLabel');
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
  opts?: { showAvatar?: boolean; assistantAvatar?: TemplateResult },
): TemplateResult {
  const isContinuation = opts?.showAvatar === false;
  return html`
    <div
      class=${`chat-group chat-group--assistant chat-group--streaming-thinking${
        isContinuation ? ' chat-group--continuation' : ''
      }`}
    >
      <div class="chat-group__avatar">
        ${(opts?.showAvatar ?? true) ? (opts?.assistantAvatar ?? renderChatAvatar('assistant')) : nothing}
      </div>
      <div class="chat-group__content">${renderStreamingThinkingBlock(text)}</div>
    </div>
  `;
}

export function renderStreamingGroup(
  text: string,
  _startedAt: number,
  thinkingText: string | null = null,
  opts?: { showAvatar?: boolean; assistantAvatar?: TemplateResult },
): TemplateResult {
  const hasText = text.trim().length > 0;
  const isContinuation = opts?.showAvatar === false;
  return html`
    <div
      class=${`chat-group chat-group--assistant chat-group--content chat-group--streaming${
        isContinuation ? ' chat-group--continuation' : ''
      }`}
    >
      <div class="chat-group__avatar">
        ${(opts?.showAvatar ?? true) ? (opts?.assistantAvatar ?? renderChatAvatar('assistant')) : nothing}
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

export function renderReadingIndicatorGroup(opts?: {
  showAvatar?: boolean;
  assistantAvatar?: TemplateResult;
  label?: string;
  elapsed?: string;
  warning?: boolean;
}): TemplateResult {
  const isContinuation = opts?.showAvatar === false;
  return html`
    <div
      class=${`chat-group chat-group--assistant chat-group--reading-indicator${
        isContinuation ? ' chat-group--continuation' : ''
      }`}
    >
      <div class="chat-group__avatar">
        <svg class="chat-working-indicator__spark" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2 14.8 9.2 22 12 14.8 14.8 12 22 9.2 14.8 2 12 9.2 9.2Z"
          />
        </svg>
      </div>
      <div class="chat-group__content">
        <div
          class=${`chat-working-indicator${opts?.warning ? ' chat-working-indicator--warning' : ''}`}
        >
          <span class="chat-working-indicator__label" role="status" aria-live="polite"
            >${opts?.label ?? i18nService.t('coworkWorkingStarting')}</span
          >
          ${opts?.elapsed ? html`<span class="chat-working-indicator__elapsed" aria-live="off">${opts.elapsed}</span>` : nothing}
        </div>
      </div>
    </div>
  `;
}
