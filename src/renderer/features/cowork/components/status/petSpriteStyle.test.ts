import { describe, expect, test } from 'vitest';

import { petSpriteStyle } from './petSpriteStyle';

function containsPoint(clip: string, x: number, y: number): boolean {
  const points = [...clip.matchAll(/([\d.]+)% ([\d.]+)%/g)].map(match => [Number(match[1]), Number(match[2])]);
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe('petSpriteStyle', () => {
  test('keeps the white cat outline beyond the cell midpoint out of the black cat', () => {
    const white = petSpriteStyle('/pets/spritesheet.png', 4, 1, 96, 'white');
    const black = petSpriteStyle('/pets/spritesheet.png', 4, 1, 96, 'black');
    // Source pixel (129, 134) is the white cat outline, past the old 128px cut.
    expect(containsPoint(String(white.clipPath), 129 / 256 * 100, 134 / 256 * 100)).toBe(true);
    expect(containsPoint(String(black.clipPath), 129 / 256 * 100, 134 / 256 * 100)).toBe(false);
    expect(containsPoint(String(black.clipPath), 60, 60)).toBe(true);
    expect(containsPoint(String(white.clipPath), 60, 60)).toBe(false);
  });

  test.each([
    ['spritesheet', 'png', 4], ['extra-spritesheet', 'webp', 2],
    ['reaction-spritesheet', 'webp', 1], ['interaction-spritesheet', 'webp', 4],
    ['asymmetric-spritesheet', 'webp', 4],
  ] as const)('uses the same %s boundaries in development and hashed production URLs', (name, extension, rows) => {
    for (let frame = 1; frame <= rows * 6; frame += 1) {
      for (const cat of ['white', 'black'] as const) {
        const development = petSpriteStyle(`/pets/${name}.${extension}?import`, rows, frame, 64, cat);
        const production = petSpriteStyle(`/assets/${name}-AbC123.${extension}`, rows, frame, 96, cat);
        expect(production.clipPath).toBe(development.clipPath);
        expect(production.clipPath).toMatch(/^polygon\(/);
      }
    }
  });

  test('retains the complete cell for coordinated paired gestures', () => {
    expect(petSpriteStyle('/pets/spritesheet.png', 4, 15, 64, 'both').clipPath).toBeUndefined();
  });

  test('preserves the stretching black paw that extends into the left half of the asymmetric atlas', () => {
    const black = petSpriteStyle('/assets/asymmetric-spritesheet-AbC123.webp', 4, 9, 64, 'black');
    const white = petSpriteStyle('/assets/asymmetric-spritesheet-AbC123.webp', 4, 9, 64, 'white');
    // Source pixel (120, 240) belongs to the black paw in this cell.
    expect(containsPoint(String(black.clipPath), 120 / 256 * 100, 240 / 256 * 100)).toBe(true);
    expect(containsPoint(String(white.clipPath), 120 / 256 * 100, 240 / 256 * 100)).toBe(false);
  });
});
