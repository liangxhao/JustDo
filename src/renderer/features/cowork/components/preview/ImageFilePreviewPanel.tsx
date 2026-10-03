import { ArrowPathIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { createImagePreviewTransform, zoomImagePreviewTransform } from '@/image-preview/transform';
import { i18nService } from '@/services/i18n';

import { FilePreviewToolbarContext } from './FilePreviewToolbarContext';
import type { ImageFilePreview } from './imageFilePreview';

export default function ImageFilePreviewPanel({
  preview,
  onClose,
  isObscured = false,
  embedded = false,
}: {
  preview: ImageFilePreview;
  onClose: () => void;
  isObscured?: boolean;
  embedded?: boolean;
}) {
  const sharedToolbarTarget = useContext(FilePreviewToolbarContext);
  const toolbarTarget = embedded ? sharedToolbarTarget : null;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState(createImagePreviewTransform);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  useEffect(() => {
    setFailed(false);
    setTransform(createImagePreviewTransform());
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      setTransform(current =>
        zoomImagePreviewTransform({
          transform: current,
          wheelDeltaY:
            event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1),
          pointerX: event.clientX,
          pointerY: event.clientY,
          viewportCenterX: rect.left + rect.width / 2,
          viewportCenterY: rect.top + rect.height / 2,
        }),
      );
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [preview.src]);

  const fileActions = (
    <>
      <button
        type="button"
        className="rounded p-2 text-secondary hover:bg-surface-raised"
        title={i18nService.t('coworkImagePreviewReset')}
        aria-label={i18nService.t('coworkImagePreviewReset')}
        onClick={() => setTransform(createImagePreviewTransform())}
      >
        <ArrowPathIcon className="h-4 w-4" />
      </button>
      {!toolbarTarget && (
        <button
          type="button"
          className="rounded p-2 text-secondary hover:bg-surface-raised"
          title={i18nService.t('close')}
          aria-label={i18nService.t('close')}
          onClick={onClose}
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      )}
    </>
  );

  return (
    <section
      className={`absolute inset-0 flex min-h-0 flex-col bg-background ${isObscured ? 'hidden' : ''}`}
      aria-hidden={isObscured || undefined}
      aria-label={i18nService.t('coworkImagePreviewTitle')}
    >
      {!toolbarTarget && (
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {preview.label || i18nService.t('coworkImagePreviewTitle')}
          </span>
          {fileActions}
        </header>
      )}
      {toolbarTarget &&
        !isObscured &&
        createPortal(
          <div className="flex shrink-0 items-center gap-1">{fileActions}</div>,
          toolbarTarget,
        )}
      <div
        ref={viewportRef}
        className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden p-4"
        onDoubleClick={() => setTransform(createImagePreviewTransform())}
        onPointerDown={event => {
          if (event.button !== 0 || failed) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            offsetX: transform.offsetX,
            offsetY: transform.offsetY,
          };
        }}
        onPointerMove={event => {
          const active = drag.current;
          if (!active || active.id !== event.pointerId) return;
          setTransform(current => ({
            ...current,
            offsetX: active.offsetX + event.clientX - active.x,
            offsetY: active.offsetY + event.clientY - active.y,
          }));
        }}
        onPointerUp={event => {
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        {failed ? (
          <p role="alert" className="text-sm text-muted">
            {i18nService.t('coworkImagePreviewOpenFailed')}
          </p>
        ) : (
          <img
            src={preview.src}
            alt={preview.label}
            draggable={false}
            className="max-h-full max-w-full select-none object-contain"
            style={{
              transform: `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`,
              cursor: transform.scale > 1 ? 'grab' : 'default',
            }}
            onError={() => setFailed(true)}
            onContextMenu={event => {
              event.preventDefault();
              void window.electron.shell.showImageContextMenu(preview.src).catch(() => undefined);
            }}
          />
        )}
      </div>
    </section>
  );
}
