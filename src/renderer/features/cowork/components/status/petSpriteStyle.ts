import type { CSSProperties } from 'react';

import type { PetCatSelection } from '@/app/appearance';

import clips from '../../../../../../resources/pets/black-white-cats/sprite-clips.json';

export function petSpriteStyle(sheet: string, rows: number, frame: number, size: number, cat: PetCatSelection = 'both'): CSSProperties {
  const style: CSSProperties = {
    backgroundImage: `url(${sheet})`,
    backgroundSize: `${size * 6}px ${size * rows}px`,
    backgroundPosition: `${-((frame - 1) % 6) * size}px ${-Math.floor((frame - 1) / 6) * size}px`,
  };
  if (cat === 'both') return style;
  // Vite URLs can contain a build hash or a query. Match the stable asset stem.
  const filename = sheet.split(/[?#]/)[0].split('/').pop() ?? '';
  const name = Object.keys(clips).find(key => filename === key || filename.startsWith(`${key.replace(/\.(png|webp)$/, '')}-`));
  const seam = name ? clips[name as keyof typeof clips][frame - 1] : undefined;
  if (!seam) throw new Error(`Missing pet clipping boundary: ${sheet}, frame ${frame}`);
  const edge = cat === 'white' ? 0 : 100;
  const points = [[edge, 0], ...seam, [edge, 100]];
  style.clipPath = `polygon(${points.map(([x, y]) => `${x}% ${y}%`).join(', ')})`;
  return style;
}
