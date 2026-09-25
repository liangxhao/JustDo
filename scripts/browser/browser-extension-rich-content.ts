import { render } from 'lit';
import { normalizeMessage } from '../../src/renderer/libs/openclaw-chat/pipeline/message-normalizer';
import {
  getTranscriptMedia,
  isTranscriptImage,
} from '../../src/renderer/libs/openclaw-chat/attachments';
import { renderBrowserAnnotation } from '../../src/renderer/libs/openclaw-chat/components/browser-annotation-message';
import { renderBrowserRecording } from '../../src/renderer/libs/openclaw-chat/components/browser-recording-message';
import { i18nService } from './browser-extension-i18n';
import { renderMarkdownHtml } from './browser-extension-markdown-entry.mjs';

const imageRetries = new WeakMap<HTMLImageElement, () => void>();
export function retryRichImages(host: HTMLElement) {
  host.querySelectorAll('img').forEach(img => imageRetries.get(img)?.());
}

export function renderRichContent(
  host: HTMLElement,
  entry: { role: string; text: string; rawMessage?: Record<string, unknown> },
  loadImage: (source: string) => Promise<string>,
) {
  const raw = entry.rawMessage ?? { role: entry.role, content: entry.text };
  const content = normalizeMessage(raw).content.slice();
  for (const media of getTranscriptMedia(raw)) {
    if (
      isTranscriptImage(media) &&
      !content.some(item => item.type === 'attachment' && item.attachment.url === media.path)
    ) {
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
  const delivery = raw.openclawDelivery as { mediaUrls?: unknown } | undefined;
  const omitted =
    raw.__browserExtensionOmitDeliveryMedia === true && Array.isArray(delivery?.mediaUrls)
      ? new Set(delivery.mediaUrls)
      : new Set();
  let images: HTMLElement | null = null;
  for (const item of content) {
    if (item.type === 'attachment' && omitted.has(item.attachment.url)) continue;
    if (item.type === 'attachment' && item.attachment.kind === 'image') {
      if (!images) {
        images = document.createElement('div');
        images.className = 'chat-bubble__images';
        host.append(images);
      }
      const img = document.createElement('img');
      img.className = 'chat-bubble__image';
      img.alt = item.attachment.label;
      images.append(img);
      images.style.setProperty('--image-columns', String(images.childElementCount));
      hydrateImage(img, item.attachment.url, loadImage);
      continue;
    }
    images = null;
    const node = document.createElement('div');
    if (item.type === 'browser_annotation') render(renderBrowserAnnotation(item), node);
    else if (item.type === 'browser_recording')
      render(renderBrowserRecording(item.recording), node);
    else if (item.type === 'text' && item.text) node.innerHTML = renderMarkdownHtml(item.text);
    else if (item.type === 'attachment') node.textContent = item.attachment.label;
    else continue;
    host.append(node);
    for (const img of node.querySelectorAll('img'))
      hydrateImage(
        img,
        img.getAttribute('data-image-source') || img.getAttribute('src') || '',
        loadImage,
      );
  }
}

function hydrateImage(
  img: HTMLImageElement,
  source: string,
  loadImage: (source: string) => Promise<string>,
) {
  const originalAlt = img.alt;
  let pending = false;
  let loaded = false;
  let lastAttempt = 0;
  img.removeAttribute('src');
  img.classList.add('chat-bubble__image');
  img.addEventListener('error', () => {
    loaded = false;
    img.alt = i18nService.t('coworkImagePreviewOpenFailed');
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
        if (!/^(?:https?:|data:image\/)/i.test(url)) throw new Error('Invalid image source');
        img.alt = originalAlt;
        img.src = url;
        loaded = true;
      })
      .catch(() => {
        img.alt = i18nService.t('coworkImagePreviewOpenFailed');
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
