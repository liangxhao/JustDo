import { describe, expect, test } from 'vitest';

import {
  createImagePreviewTransform,
  IMAGE_PREVIEW_MAX_SCALE,
  IMAGE_PREVIEW_MIN_SCALE,
  zoomImagePreviewTransform,
} from './transform';

describe('image preview transform', () => {
  test('starts fitted and centered', () => {
    expect(createImagePreviewTransform()).toEqual({
      scale: IMAGE_PREVIEW_MIN_SCALE,
      offsetX: 0,
      offsetY: 0,
    });
  });

  test('keeps the image point beneath the pointer fixed while zooming', () => {
    const current = { scale: 2, offsetX: 20, offsetY: -10 };
    const next = zoomImagePreviewTransform({
      transform: current,
      wheelDeltaY: -120,
      pointerX: 700,
      pointerY: 250,
      viewportCenterX: 500,
      viewportCenterY: 400,
    });

    const currentImagePointX = (700 - 500 - current.offsetX) / current.scale;
    const currentImagePointY = (250 - 400 - current.offsetY) / current.scale;
    const nextImagePointX = (700 - 500 - next.offsetX) / next.scale;
    const nextImagePointY = (250 - 400 - next.offsetY) / next.scale;

    expect(next.scale).toBeGreaterThan(current.scale);
    expect(nextImagePointX).toBeCloseTo(currentImagePointX);
    expect(nextImagePointY).toBeCloseTo(currentImagePointY);
  });

  test('resets panning when zooming back to the fitted scale', () => {
    expect(
      zoomImagePreviewTransform({
        transform: { scale: 1.05, offsetX: 120, offsetY: -80 },
        wheelDeltaY: 10_000,
        pointerX: 0,
        pointerY: 0,
        viewportCenterX: 500,
        viewportCenterY: 400,
      }),
    ).toEqual({ scale: IMAGE_PREVIEW_MIN_SCALE, offsetX: 0, offsetY: 0 });
  });

  test('caps zoom at the maximum scale', () => {
    const transform = { scale: IMAGE_PREVIEW_MAX_SCALE, offsetX: 10, offsetY: 20 };
    expect(
      zoomImagePreviewTransform({
        transform,
        wheelDeltaY: -10_000,
        pointerX: 0,
        pointerY: 0,
        viewportCenterX: 0,
        viewportCenterY: 0,
      }),
    ).toBe(transform);
  });
});
