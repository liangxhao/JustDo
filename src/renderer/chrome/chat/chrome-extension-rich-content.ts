import {
  type AssistantDeliverable,
  getChromeAssistantDeliverables,
  getChromeDeliveryMediaUrls,
} from '@shared/chrome/chromeExtensionDeliverables';
import {
  isLocalAssistantDeliverableSource,
  unwrapAssistantDeliverableSource,
} from '@shared/openclaw/assistantDeliverables';
import { parseManagedOutgoingMediaSource } from '@shared/openclaw/assistantMedia';
import type { MessageFileLinkTarget } from '@shared/preview/messageFileLink';
import { html, render } from 'lit';

import { getTranscriptMedia, isTranscriptImage } from '@/libs/openclaw-chat/attachments';
import {
  consumeMessageFileLinkNode,
  installMessageFileLinks,
  type MessageFileLinkRegistry,
} from '@/libs/openclaw-chat/components/markdown/markdown-file-links';
import { renderBrowserAnnotation } from '@/libs/openclaw-chat/components/message/browser-annotation-message';
import { renderBrowserRecording } from '@/libs/openclaw-chat/components/message/browser-recording-message';
import { renderAttachmentActionIcon, renderMessageFileIcon } from '@/libs/openclaw-chat/components/message/message-file-icon';
import { renderCompactionMessage } from '@/libs/openclaw-chat/components/timeline/compaction-divider';
import { projectProgressReceipt } from '@/libs/openclaw-chat/model/tools/progress-receipt';
import { MARKDOWN_PARSE_LIMIT } from '@/libs/openclaw-chat/pipeline/constants';
import { normalizeMessage } from '@/libs/openclaw-chat/pipeline/message-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import {
  createMarkdownRenderer,
  renderMarkdownHtml,
} from '../../../../plugins/chrome-extensions/chrome-assistant/scripts/chrome-extension-markdown-entry.mjs';
import {
  questionPresentationResponse,
  renderQuestionPresentation,
} from '../../../../plugins/extensions/ask-user-question/browser/presentation';
import {
  parseQuestionResult,
  parseQuestions,
} from '../../../../plugins/extensions/ask-user-question/contracts/result';
import { i18nService } from './chrome-extension-i18n';

const imageRetries = new WeakMap<HTMLImageElement, () => void>();
const renderMessageMarkdown = createMarkdownRenderer(markdown =>
  installMessageFileLinks(markdown, { localHtmlRules: false }),
);
const incompleteMessageStatuses = new Set([
  'streaming', 'inProgress', 'running', 'unknown', 'interrupted',
]);
const deliveryReference = (source: string) => unwrapAssistantDeliverableSource(source.trim());

export function processDetailLabels() {
  return {
    thinkingExpand: i18nService.t('thinkingExpand'),
    thinkingCollapse: i18nService.t('thinkingCollapse'),
    toolInput: i18nService.t('coworkToolInput'),
    toolResult: i18nService.t('coworkToolResult'),
  };
}

export function renderThinkingMarkdown(host: HTMLElement, text: string): void {
  if (text.length <= MARKDOWN_PARSE_LIMIT) {
    host.innerHTML = renderMarkdownHtml(text);
    return;
  }
  const plain = host.ownerDocument.createElement('div');
  plain.className = 'process-thinking-plain';
  plain.textContent = text.replace(/\r\n?/g, '\n');
  host.replaceChildren(plain);
}

export function isIncompleteFileLinkSource(entry: {
  status?: string;
  display?: { stopReason?: string };
}): boolean {
  const stopReason = entry.display?.stopReason;
  return incompleteMessageStatuses.has(entry.status ?? '') ||
    stopReason === 'aborted' || stopReason === 'error';
}

/** Copy the same normalized text that is rendered, excluding cards and attachments. */
export function messageCopyText(entry: {
  role: string;
  text?: string;
  rawMessage?: Record<string, unknown>;
}): string {
  const raw = entry.rawMessage ?? { role: entry.role, content: entry.text };
  return normalizeMessage(raw)
    .content.flatMap(item => (item.type === 'text' ? [item.text] : []))
    .join('\n\n');
}

export function pendingInputLabel(
  state: string,
  incomplete = false,
): { label: string; description: string } {
  const description = i18nService.t(
    incomplete
      ? 'messagePendingInputReadFailed'
      : state === 'cancelled'
        ? 'messagePendingInputCancelled'
        : state === 'interrupted'
          ? 'messagePendingInputInterrupted'
          : 'messagePendingInputQueued',
  );
  const label = i18nService.t(
    incomplete
      ? 'messagePendingInputIncompleteShort'
      : state === 'cancelled'
        ? 'messagePendingInputCancelledShort'
        : state === 'interrupted'
          ? 'messagePendingInputInterruptedShort'
          : 'messagePendingInputQueuedShort',
  );
  return { label, description };
}
export function retryRichImages(host: HTMLElement) {
  host.querySelectorAll('img').forEach(img => imageRetries.get(img)?.());
}

export function renderRichContent(
  host: HTMLElement,
  entry: {
    role: string;
    text?: string;
    status?: string;
    display?: { stopReason?: string };
    rawMessage?: Record<string, unknown>;
    item?: {
      id?: string;
      input?: unknown;
      status?: string;
      questionResult?: unknown;
      output?: unknown;
    };
  },
  loadImage: (source: string) => Promise<string>,
  openDelivery?: (source: string) => Promise<void>,
  openMessageFile?: (link: MessageFileLinkTarget) => Promise<void>,
) {
  if (entry.role === 'question-presentation' && entry.item) {
    const result =
      entry.item.status === 'completed' ? parseQuestionResult(entry.item.questionResult) : null;
    const input = entry.item.input;
    const questions =
      result?.questions ??
      parseQuestions(
        input && typeof input === 'object'
          ? (input as Record<string, unknown>).questions
          : undefined,
      );
    if (questions)
      render(
        renderQuestionPresentation(
          questions,
          questionPresentationResponse(
            entry.item.status,
            result?.response,
            typeof entry.item.output === 'string' ? entry.item.output : undefined,
          ),
          key => i18nService.t(key),
        ),
        host,
      );
    return;
  }
  if (entry.role === 'compaction') {
    let content = host.querySelector<HTMLElement>(':scope > .compaction-content');
    if (!content) {
      content = document.createElement('div');
      content.className = 'compaction-content';
      host.append(content);
    }
    render(
      renderCompactionMessage(entry.rawMessage as GatewayMessage | undefined, Date.now()),
      content,
    );
    return;
  }
  if (entry.role === 'progress-receipt' && entry.item) {
    const presentation = projectProgressReceipt(entry.item);
    const section = document.createElement('section');
    section.className = 'progress-card-receipt';
    if (entry.item.id) section.dataset.progressReceiptId = entry.item.id;
    if (entry.item.status === 'running' || entry.item.status === 'inProgress')
      section.setAttribute('role', 'status');
    const icon = document.createElement('span');
    icon.className = 'progress-card-receipt__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none"><path d="M4.25 4.25h7.5M4.25 8h7.5M4.25 11.75h4.5"/><path d="m2 4.25.55.55L3.6 3.7M2 8l.55.55L3.6 7.45M2 11.75l.55.55 1.05-1.1"/></svg>';
    const label = document.createElement('span');
    label.textContent = Object.entries(presentation.values).reduce(
      (text, [key, value]) => text.replace(`{${key}}`, value),
      i18nService.t(presentation.key),
    );
    section.append(icon, label);
    host.append(section);
    return;
  }
  const raw = entry.rawMessage ?? { role: entry.role, content: entry.text };
  const content = normalizeMessage(raw).content.slice();
  const deliverables = new Map<string, AssistantDeliverable>();
  for (const delivery of entry.role === 'assistant' ? getChromeAssistantDeliverables(raw) : []) {
    const reference = deliveryReference(delivery.source);
    if (!deliverables.has(reference)) deliverables.set(reference, delivery);
  }
  const contentReferences = new Set(content.flatMap(item =>
    item.type === 'attachment' ? [deliveryReference(item.attachment.url)] : [],
  ));
  for (const media of getTranscriptMedia(raw)) {
    const reference = deliveryReference(media.path);
    if (isTranscriptImage(media) && !contentReferences.has(reference)) {
      contentReferences.add(reference);
      content.push({
        type: 'attachment',
        attachment: {
          kind: 'image',
          url: media.path,
          label: media.fileName || i18nService.t('coworkImagePreviewTitle'),
        },
      });
    }
  }
  for (const [reference, delivery] of deliverables) {
    if (contentReferences.has(reference)) continue;
    content.push({
      type: 'attachment',
      attachment: {
        kind: delivery.kind,
        label: delivery.name,
        url: delivery.source,
        mimeType: delivery.mimeType,
      },
    });
  }
  const manifestReferences = new Set(entry.role === 'assistant'
    ? getChromeDeliveryMediaUrls(raw).map(deliveryReference)
    : []);
  const shownDeliveries = new Set<string>();
  const canOpenMessageFile =
    entry.role === 'user' || entry.role === 'assistant' ? openMessageFile : undefined;
  const incomplete = entry.role === 'assistant' && isIncompleteFileLinkSource(entry);
  let images: HTMLElement | null = null;
  type DocumentCard = { node: HTMLElement; name: string; managed: boolean };
  const documentCards: DocumentCard[] = [];
  const flushDocumentCards = () => {
    if (!documentCards.length) return;
    const groups = new Map<string, { cards: DocumentCard[]; mixedSources: boolean }>();
    for (const card of documentCards) {
      const group = groups.get(card.name);
      if (group) {
        group.mixedSources ||= card.managed !== group.cards[0].managed;
        group.cards.push(card);
      } else groups.set(card.name, { cards: [card], mixedSources: false });
    }
    for (const card of documentCards) {
      const group = groups.get(card.name);
      if (!group?.mixedSources) host.append(card.node);
      else if (card === group.cards[0]) {
        const options = document.createElement('div');
        options.className = 'chrome-delivery-options';
        options.append(...group.cards.map(item => item.node));
        host.append(options);
      }
    }
    documentCards.length = 0;
  };
  for (const item of content) {
    const reference = item.type === 'attachment' ? deliveryReference(item.attachment.url) : undefined;
    const delivery = reference === undefined ? undefined : deliverables.get(reference);
    if (reference !== undefined) {
      if (manifestReferences.has(reference) && (!delivery || raw.__chromeExtensionOmitDeliveryMedia === true)) continue;
      if (delivery) {
        if (shownDeliveries.has(reference)) continue;
        shownDeliveries.add(reference);
      }
    }
    if (item.type === 'attachment' && item.attachment.kind === 'document' &&
        delivery?.kind === 'document' && canOpenDeliverySource(delivery.source)) {
      images = null;
      if (item.attachment.listMarker) flushDocumentCards();
      const node = document.createElement('div');
      renderDelivery(node, delivery, openDelivery);
      documentCards.push({ node, name: delivery.name, managed: Boolean(parseManagedOutgoingMediaSource(deliveryReference(delivery.source))) });
      continue;
    }
    flushDocumentCards();
    if (
      item.type === 'attachment' &&
      (item.attachment.kind === 'image' || delivery?.kind === 'image')
    ) {
      if (!images) {
        images = document.createElement('div');
        images.className = 'chat-bubble__images';
        host.append(images);
      }
      const img = document.createElement('img');
      img.className = 'chat-bubble__image';
      img.alt = delivery?.name ?? item.attachment.label;
      images.append(img);
      images.style.setProperty('--image-columns', String(images.childElementCount));
      hydrateImage(
        img,
        delivery ? unwrapAssistantDeliverableSource(delivery.source) : item.attachment.url,
        loadImage,
        Boolean(delivery && openDelivery),
      );
      if (delivery && openDelivery) {
        const actions = document.createElement('div');
        renderDelivery(actions, delivery, openDelivery);
        host.append(actions);
      }
      continue;
    }
    images = null;
    const node = document.createElement('div');
    if (item.type === 'browser_annotation') render(renderBrowserAnnotation(item), node);
    else if (item.type === 'browser_recording')
      render(renderBrowserRecording(item.recording), node);
    else if (item.type === 'text' && item.text) {
      if (canOpenMessageFile) renderMessageFileLinks(node, item.text, incomplete, canOpenMessageFile);
      else node.innerHTML = renderMessageMarkdown(item.text);
    } else if (item.type === 'attachment') {
      if (delivery) renderDelivery(node, delivery, openDelivery);
      else node.textContent = item.attachment.label;
    } else continue;
    host.append(node);
    for (const img of node.querySelectorAll('img'))
      hydrateImage(
        img,
        img.getAttribute('data-image-source') || img.getAttribute('src') || '',
        loadImage,
      );
  }
  flushDocumentCards();
}

function renderMessageFileLinks(
  host: HTMLElement,
  text: string,
  streaming: boolean,
  openFile: (link: MessageFileLinkTarget) => Promise<void>,
) {
  const registry: MessageFileLinkRegistry = new Map();
  host.innerHTML = renderMessageMarkdown(text, {
    fileLinks: true,
    messageFileLinksMode: true,
    fileLinksStreaming: streaming,
    messageFileLinkRegistry: registry,
  });
  for (const anchor of host.querySelectorAll<HTMLAnchorElement>('a[data-message-file-token]')) {
    const link = consumeMessageFileLinkNode(anchor, registry);
    if (!link) continue;
    anchor.classList.add('chrome-message-file-link');
    const status = host.ownerDocument.createElement('span');
    status.className = 'chrome-message-file-link__status';
    status.setAttribute('role', 'status');
    anchor.after(status);
    anchor.addEventListener('auxclick', event => event.preventDefault());
    anchor.addEventListener('click', async event => {
      event.preventDefault();
      if (!anchor.isConnected || anchor.hasAttribute('aria-busy')) return;
      status.textContent = '';
      anchor.setAttribute('aria-busy', 'true');
      try {
        await openFile(link);
      } catch {
        if (anchor.isConnected) status.textContent = i18nService.t('coworkUnsupportedFileOpenFailed');
      } finally {
        anchor.removeAttribute('aria-busy');
      }
    });
  }
}

function canOpenDeliverySource(source: string): boolean {
  return (
    isLocalAssistantDeliverableSource(source) ||
    parseManagedOutgoingMediaSource(unwrapAssistantDeliverableSource(source)) !== null
  );
}

function renderDelivery(
  host: HTMLElement,
  delivery: AssistantDeliverable,
  openDelivery?: (source: string) => Promise<void>,
) {
  const document = host.ownerDocument;
  const button = openDelivery ? document.createElement('button') : null;
  const card = button ?? document.createElement('div');
  const managed = Boolean(parseManagedOutgoingMediaSource(deliveryReference(delivery.source)));
  card.className = 'chrome-delivery-card';
  card.title = delivery.name;
  render(
    html`
      ${renderMessageFileIcon(delivery.name)}
      <span class="chrome-delivery-card__name">${delivery.name}</span>
      ${button ? html`<span class="chrome-delivery-card__action" aria-hidden="true">
        ${renderAttachmentActionIcon(managed)}
      </span>` : ''}
    `,
    card,
  );
  host.append(card);
  if (!button || !openDelivery) return;

  button.type = 'button';
  button.setAttribute('aria-label', `${i18nService.t(managed ? 'messageDownload' : 'coworkOpenAttachment')} ${delivery.name}`);
  const status = document.createElement('span');
  status.className = 'chrome-delivery-card__status';
  status.setAttribute('role', 'status');
  host.append(status);
  button.addEventListener('click', async () => {
    if (button.hasAttribute('aria-busy') || !button.isConnected) return;
    status.textContent = '';
    if (!canOpenDeliverySource(delivery.source)) {
      status.textContent = i18nService.t('coworkUnsupportedFileOpenFailed');
      return;
    }
    button.setAttribute('aria-busy', 'true');
    try {
      await openDelivery(delivery.source);
    } catch {
      if (button.isConnected) status.textContent = i18nService.t('coworkUnsupportedFileOpenFailed');
    } finally {
      if (button.isConnected) button.removeAttribute('aria-busy');
    }
  });
}

function hydrateImage(
  img: HTMLImageElement,
  source: string,
  loadImage: (source: string) => Promise<string>,
  hideUntilLoaded = false,
) {
  let pending = false;
  let loaded = false;
  let lastAttempt = 0;
  img.removeAttribute('src');
  img.classList.add('chat-bubble__image');
  if (hideUntilLoaded) {
    img.hidden = true;
    img.addEventListener('load', () => {
      img.hidden = false;
    });
  }
  img.addEventListener('error', () => {
    loaded = false;
    if (hideUntilLoaded) {
      img.hidden = true;
      img.removeAttribute('src');
    }
  });
  img.tabIndex = 0;
  img.title = i18nService.t('coworkImageOpenPreviewHint');
  img.referrerPolicy = 'no-referrer';
  const load = () => {
    if (pending || loaded || Date.now() - lastAttempt < 1000) return;
    pending = true;
    lastAttempt = Date.now();
    const ready = /^(?:https?:|data:image\/)/i.test(source)
      ? Promise.resolve(source)
      : loadImage(source);
    void ready
      .then(url => {
        if (!/^(?:https?:|data:image\/)/i.test(url)) return;
        img.src = url;
        loaded = true;
      })
      .catch(() => {
        // Background preview loading does not change the file card or report an error.
      })
      .finally(() => {
        pending = false;
      });
  };
  imageRetries.set(img, load);
  load();
  const preview = () => {
    if (!img.getAttribute('src')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'image-preview';
    dialog.setAttribute('aria-label', i18nService.t('coworkImagePreviewTitle'));
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', i18nService.t('close'));
    const full = document.createElement('img');
    full.src = img.src;
    full.alt = img.alt;
    const reset = document.createElement('button');
    reset.className = 'image-preview-reset';
    reset.textContent = i18nService.t('coworkImagePreviewReset');
    let zoom = 1,
      x = 0,
      y = 0;
    const transform = () => {
      full.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    };
    reset.onclick = () => {
      zoom = 1;
      x = 0;
      y = 0;
      transform();
    };
    full.addEventListener(
      'wheel',
      event => {
        event.preventDefault();
        zoom = Math.max(0.25, Math.min(8, zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
        transform();
      },
      { passive: false },
    );
    full.addEventListener('pointerdown', event => {
      full.setPointerCapture(event.pointerId);
    });
    full.addEventListener('pointermove', event => {
      if (!full.hasPointerCapture(event.pointerId)) return;
      x += event.movementX;
      y += event.movementY;
      transform();
    });
    full.draggable = false;
    close.onclick = () => dialog.close();
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
    dialog.append(close, reset, full);
    document.body.append(dialog);
    dialog.showModal();
  };
  img.addEventListener('dblclick', preview);
  img.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      preview();
    }
  });
}
