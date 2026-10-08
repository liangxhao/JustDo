import { isLocalHtmlFilePath, isWebBrowserLink } from '@shared/browser/browserLinkOpening';

import { openMessageHtmlLink, openMessageWebLink } from '@/features/browser/messageBrowserLinks';
import { IMAGE_PREVIEW_EVENT } from '@/features/cowork/components/preview/imageFilePreview';
import { i18nService } from '@/services/i18n';

import { showImageContextMenu } from './message-render';

export function handleMessageLinkClick(event: Event, workingDirectory?: string): boolean {
  const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement) as
    HTMLAnchorElement | undefined;
  if (!anchor) return false;
  const filePath = anchor.getAttribute('data-local-html-path');
  const href = anchor.getAttribute('href');
  if (filePath && isLocalHtmlFilePath(filePath)) {
    event.preventDefault();
    event.stopPropagation();
    openMessageHtmlLink(
      filePath,
      workingDirectory,
      anchor.getAttribute('data-local-html-suffix') ?? undefined,
    );
    return true;
  }
  if (!isWebBrowserLink(href)) return false;
  event.preventDefault();
  event.stopPropagation();
  void openMessageWebLink(href);
  return true;
}

/** Content interactions shared by the transcript and standalone message readers. */
export function handleMessageImageClick(event: Event): boolean {
  const image = event
    .composedPath()
    .find(
      node =>
        node instanceof HTMLImageElement &&
        (node.classList.contains('chat-bubble__image') ||
          node.classList.contains('markdown-inline-image')),
    ) as HTMLImageElement | undefined;
  if (!image) return false;
  event.preventDefault();
  event.stopPropagation();
  const src = image.currentSrc || image.src;
  if (src)
    window.dispatchEvent(new CustomEvent(IMAGE_PREVIEW_EVENT, { detail: { src, alt: image.alt } }));
  return true;
}

export function handleMessageImageContextMenu(event: Event): void {
  const image = event
    .composedPath()
    .find(
      node => node instanceof HTMLImageElement && node.classList.contains('markdown-inline-image'),
    ) as HTMLImageElement | undefined;
  if (image) void showImageContextMenu(event, image.currentSrc || image.src);
}

export function handleMessageDiagramToggle(event: Event): void {
  const target = event
    .composedPath()
    .find(node => node instanceof HTMLElement && node.classList.contains('mermaid-toggle')) as
    HTMLButtonElement | undefined;
  const block = target?.closest<HTMLElement>('.mermaid-block');
  if (!target || !block) return;
  const showSource = !block.classList.contains('is-source');
  block.classList.toggle('is-source', showSource);
  const preview = block.querySelector<HTMLElement>('.mermaid-preview');
  const source = block.querySelector<HTMLElement>('.mermaid-source');
  const label = block.querySelector<HTMLElement>('.code-block-lang');
  if (preview) preview.hidden = showSource;
  if (source) source.hidden = !showSource;
  if (label) label.textContent = showSource ? 'mermaid' : 'mermaid (rendered)';
  const buttonLabel = i18nService.t(showSource ? 'renderDiagram' : 'showCode');
  target.setAttribute('aria-label', buttonLabel);
  target.title = buttonLabel;
}
