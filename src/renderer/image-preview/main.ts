import './style.css';

import type { ImagePreviewDocument } from '@shared/imagePreview';

import {
  createImagePreviewTransform,
  type ImagePreviewTransform,
  zoomImagePreviewTransform,
} from './transform';

type ImagePreviewWindowApi = {
  getCurrent: () => Promise<ImagePreviewDocument | null>;
  onSourceChanged: (callback: (document: ImagePreviewDocument) => void) => () => void;
  showImageContextMenu: (imageUrl: string) => Promise<{ success: boolean; error?: string }>;
};

declare global {
  interface Window {
    imagePreviewWindow: ImagePreviewWindowApi;
  }
}

type PreviewDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffsetX: number;
  startOffsetY: number;
};

const viewport = document.querySelector<HTMLElement>('#image-preview');
const image = document.querySelector<HTMLImageElement>('#preview-image');
if (!viewport || !image) {
  throw new Error('Image preview elements are missing');
}

let currentDocument: ImagePreviewDocument | null = null;
let transform: ImagePreviewTransform = createImagePreviewTransform();
let drag: PreviewDrag | null = null;

const renderTransform = (): void => {
  image.style.transform = `translate3d(${transform.offsetX}px, ${transform.offsetY}px, 0) scale(${transform.scale})`;
};

const resetTransform = (): void => {
  transform = createImagePreviewTransform();
  renderTransform();
};

const displayDocument = (previewDocument: ImagePreviewDocument): void => {
  currentDocument = previewDocument;
  document.title = previewDocument.title;
  image.src = previewDocument.src;
  image.alt = previewDocument.alt;
  resetTransform();
};

viewport.addEventListener(
  'wheel',
  event => {
    const viewportRect = viewport.getBoundingClientRect();
    const deltaMultiplier =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportRect.height : 1;
    event.preventDefault();
    transform = zoomImagePreviewTransform({
      transform,
      wheelDeltaY: event.deltaY * deltaMultiplier,
      pointerX: event.clientX,
      pointerY: event.clientY,
      viewportCenterX: viewportRect.left + viewportRect.width / 2,
      viewportCenterY: viewportRect.top + viewportRect.height / 2,
    });
    renderTransform();
  },
  { passive: false },
);

viewport.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target !== image) return;
  event.preventDefault();
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add('image-preview--dragging');
  drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startOffsetX: transform.offsetX,
    startOffsetY: transform.offsetY,
  };
});

viewport.addEventListener('pointermove', event => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  transform = {
    ...transform,
    offsetX: drag.startOffsetX + event.clientX - drag.startX,
    offsetY: drag.startOffsetY + event.clientY - drag.startY,
  };
  renderTransform();
});

const endDrag = (event: PointerEvent): void => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  viewport.classList.remove('image-preview--dragging');
  drag = null;
};

viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);
image.addEventListener('dragstart', event => event.preventDefault());
image.addEventListener('dblclick', resetTransform);
image.addEventListener('contextmenu', event => {
  event.preventDefault();
  if (currentDocument) {
    void window.imagePreviewWindow.showImageContextMenu(currentDocument.src);
  }
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.close();
});

window.imagePreviewWindow.onSourceChanged(displayDocument);
void window.imagePreviewWindow.getCurrent().then(document => {
  if (document) displayDocument(document);
});
