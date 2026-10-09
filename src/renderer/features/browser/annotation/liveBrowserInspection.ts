import type { BrowserInspectedElement } from '@shared/browser/browser';

const text = (value: unknown, maxLength: number): string =>
  (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim().slice(0, maxLength);

const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export const normalizeLiveInspectedElement = (value: unknown): BrowserInspectedElement | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawRect =
    record.rect && typeof record.rect === 'object' && !Array.isArray(record.rect)
      ? (record.rect as Record<string, unknown>)
      : {};
  const rawStyle =
    record.computedStyle &&
    typeof record.computedStyle === 'object' &&
    !Array.isArray(record.computedStyle)
      ? (record.computedStyle as Record<string, unknown>)
      : null;
  const tag = text(record.tag, 40).replace(/[^\w-]/g, '');
  if (!tag) return null;
  return {
    tag,
    id: text(record.id, 80).replace(/[^\w-]/g, ''),
    classes: Array.isArray(record.classes)
      ? record.classes
          .filter((item): item is string => typeof item === 'string')
          .map(item => item.replace(/[^\w-]/g, '').slice(0, 60))
          .filter(Boolean)
          .slice(0, 6)
      : [],
    role: text(record.role, 40),
    name: text(record.name, 120),
    rect: {
      x: finite(rawRect.x),
      y: finite(rawRect.y),
      width: Math.max(0, finite(rawRect.width)),
      height: Math.max(0, finite(rawRect.height)),
    },
    focusable: record.focusable === true,
    cssPath: text(record.cssPath, 500),
    ...(rawStyle
      ? {
          computedStyle: {
            color: text(rawStyle.color, 80),
            backgroundColor: text(rawStyle.backgroundColor, 80),
            opacity: text(rawStyle.opacity, 20),
            fontFamily: text(rawStyle.fontFamily, 160),
            fontSize: text(rawStyle.fontSize, 40),
            fontWeight: text(rawStyle.fontWeight, 40),
            lineHeight: text(rawStyle.lineHeight, 40),
            display: text(rawStyle.display, 40),
            position: text(rawStyle.position, 40),
            zIndex: text(rawStyle.zIndex, 40),
            borderRadius: text(rawStyle.borderRadius, 80),
          },
        }
      : {}),
  };
};
