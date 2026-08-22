import { describe, expect, test } from 'vitest';

import {
  applyAppearanceConfig,
  defaultAppearanceConfig,
  normalizeAppearanceConfig,
} from '@/app/appearance';

describe('appearance configuration', () => {
  test('migrates a legacy config with no appearance section to current defaults', () => {
    expect(normalizeAppearanceConfig(undefined)).toEqual(defaultAppearanceConfig);
    expect(defaultAppearanceConfig.chatContentWidth).toBe(70);
  });

  test('fills missing and invalid values with safe defaults', () => {
    expect(
      normalizeAppearanceConfig({
        chatContentWidth: Number.NaN,
        fontFamily: 'unknown' as never,
        fontSize: 99,
        messageDensity: 'tiny' as never,
      }),
    ).toEqual({
      ...defaultAppearanceConfig,
      fontSize: 20,
    });
  });

  test('clamps numeric values to the supported range', () => {
    expect(normalizeAppearanceConfig({ chatContentWidth: 42, fontSize: 10 })).toMatchObject({
      chatContentWidth: 60,
      fontSize: 13,
    });
  });

  test('applies normalized values as inherited CSS properties', () => {
    const properties = new Map<string, string>();
    const root = {
      style: {
        fontSize: '',
        setProperty: (name: string, value: string) => properties.set(name, value),
      },
    } as unknown as HTMLElement;

    const applied = applyAppearanceConfig(
      {
        chatContentWidth: 80,
        fontFamily: 'serif',
        fontSize: 18,
        messageDensity: 'compact',
        wrapCodeBlocks: true,
      },
      root,
    );

    expect(applied.chatContentWidth).toBe(80);
    expect(root.style.fontSize).toBe('18px');
    expect(properties.get('--justdo-chat-content-width')).toBe('80%');
    expect(properties.get('--justdo-chat-font-size')).toBe('16px');
    expect(properties.get('--justdo-message-gap')).toBe('4px');
    expect(properties.get('--justdo-timeline-gap')).toBe('2px');
    expect(properties.get('--justdo-code-white-space')).toBe('pre-wrap');
  });

  test('drops retired maximum-width and avatar fields from stored appearance values', () => {
    const normalized = normalizeAppearanceConfig({
      ...defaultAppearanceConfig,
      chatMaxWidth: 'reading',
      showMessageAvatars: false,
    } as Partial<typeof defaultAppearanceConfig>);

    expect(normalized).not.toHaveProperty('chatMaxWidth');
    expect(normalized).not.toHaveProperty('showMessageAvatars');
  });
});
