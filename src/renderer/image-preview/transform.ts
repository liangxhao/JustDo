export const IMAGE_PREVIEW_MIN_SCALE = 1;
export const IMAGE_PREVIEW_MAX_SCALE = 8;

export type ImagePreviewTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

type ImagePreviewZoomOptions = {
  transform: ImagePreviewTransform;
  wheelDeltaY: number;
  pointerX: number;
  pointerY: number;
  viewportCenterX: number;
  viewportCenterY: number;
};

export function createImagePreviewTransform(): ImagePreviewTransform {
  return { scale: IMAGE_PREVIEW_MIN_SCALE, offsetX: 0, offsetY: 0 };
}

export function zoomImagePreviewTransform({
  transform,
  wheelDeltaY,
  pointerX,
  pointerY,
  viewportCenterX,
  viewportCenterY,
}: ImagePreviewZoomOptions): ImagePreviewTransform {
  const nextScale = Math.min(
    IMAGE_PREVIEW_MAX_SCALE,
    Math.max(IMAGE_PREVIEW_MIN_SCALE, transform.scale * Math.exp(-wheelDeltaY * 0.0015)),
  );

  if (nextScale === IMAGE_PREVIEW_MIN_SCALE) return createImagePreviewTransform();
  if (nextScale === transform.scale) return transform;

  const scaleRatio = nextScale / transform.scale;
  const pointerFromCenterX = pointerX - viewportCenterX;
  const pointerFromCenterY = pointerY - viewportCenterY;

  return {
    scale: nextScale,
    offsetX: pointerFromCenterX - (pointerFromCenterX - transform.offsetX) * scaleRatio,
    offsetY: pointerFromCenterY - (pointerFromCenterY - transform.offsetY) * scaleRatio,
  };
}
