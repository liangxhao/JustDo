import { describe, expect, test } from 'vitest';

import {
  applyAppearanceConfig,
  defaultAppearanceConfig,
  normalizeAppearanceConfig,
} from '@/app/appearance';

describe('appearance configuration', () => {
  test('migrates a legacy config with no appearance section to current defaults', () => {
    expect(normalizeAppearanceConfig(undefined)).toEqual(defaultAppearanceConfig);
    expect(defaultAppearanceConfig.chatContentWidth).toBe(80);
    expect(defaultAppearanceConfig.messageLayout).toBe('bubble');
    expect(defaultAppearanceConfig.petEnabled).toBe(true);
    expect(defaultAppearanceConfig.petAnimationEnabled).toBe(true);
  });

  test('fills missing and invalid values with safe defaults', () => {
    expect(
      normalizeAppearanceConfig({
        chatContentWidth: Number.NaN,
        fontFamily: 'unknown' as never,
        fontSize: 99,
        messageLayout: 'cards' as never,
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

  test('normalizes pet visibility and motion independently', () => {
    expect(normalizeAppearanceConfig({ petEnabled: false, petAnimationEnabled: false })).toMatchObject({
      petEnabled: false,
      petAnimationEnabled: false,
    });
    expect(normalizeAppearanceConfig({ petEnabled: 'no' as never })).toMatchObject({
      petEnabled: true,
      petAnimationEnabled: true,
    });
  });

  test('normalizes expanded pet preferences and rejects invalid choices', () => {
    expect(normalizeAppearanceConfig({
      petVariety: 'classic',
      petSpeed: 'calm',
      petRestAfter: 'never',
      petFloatingEnabled: true,
      petCatSelection: 'black',
    })).toMatchObject({
      petVariety: 'classic',
      petSpeed: 'calm',
      petRestAfter: 'never',
      petFloatingEnabled: true,
      petCatSelection: 'black',
    });
    expect(normalizeAppearanceConfig({ petVariety: 'unknown' as never, petSpeed: 'fast' as never, petCatSelection: 'orange' as never })).toMatchObject({
      petVariety: defaultAppearanceConfig.petVariety,
      petSpeed: defaultAppearanceConfig.petSpeed,
      petCatSelection: 'both',
    });
  });

  test('applies pet preferences to the renderer root for both home and chat', () => {
    const root = {
      dataset: {} as Record<string, string>,
      style: { fontSize: '', setProperty: () => undefined },
    } as unknown as HTMLElement;

    applyAppearanceConfig({ petEnabled: false, petAnimationEnabled: false }, root);
    expect(root.dataset.coworkPet).toBe('off');
    expect(root.dataset.coworkPetMotion).toBe('off');

    applyAppearanceConfig(defaultAppearanceConfig, root);
    expect(root.dataset.coworkPet).toBe('on');
    expect(root.dataset.coworkPetMotion).toBe('on');
    expect(root.dataset.coworkPetVariety).toBe('playful');
    expect(root.dataset.coworkPetFloating).toBe('off');
    expect(root.dataset.coworkPetCats).toBe('both');
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
        messageLayout: 'document',
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
    expect(properties.get('--justdo-assistant-row-gap')).toBe('8px');
    expect(properties.get('--justdo-assistant-bubble-background-strength')).toBe('0%');
    expect(properties.get('--justdo-assistant-bubble-width')).toBe('100%');
    expect(properties.get('--justdo-assistant-bubble-min-width')).toBe('100%');
    expect(properties.get('--justdo-assistant-stream-border-width')).toBe('0px');
    expect(properties.get('--justdo-assistant-footer-margin-top')).toBe('6px');
    expect(properties.get('--justdo-assistant-footer-padding-left')).toBe('0px');
    expect(properties.get('--justdo-assistant-avatar-first-line-offset')).toBe(
      'calc(16px - 0.8em)',
    );
    expect(properties.get('--justdo-assistant-leading-avatar-position')).toBe('absolute');
    expect(properties.get('--justdo-assistant-leading-content-margin-left')).toBe('44px');
    expect(properties.get('--justdo-active-turn-footer-margin-top')).toBe('6px');
    expect(properties.get('--justdo-process-summary-padding')).toBe('0 9px 0 0');
    expect(properties.get('--justdo-code-white-space')).toBe('pre-wrap');
  });

  test('restores the assistant bubble presentation when switching back from document layout', () => {
    const properties = new Map<string, string>();
    const root = {
      style: {
        fontSize: '',
        setProperty: (name: string, value: string) => properties.set(name, value),
      },
    } as unknown as HTMLElement;

    applyAppearanceConfig({ ...defaultAppearanceConfig, messageLayout: 'document' }, root);
    applyAppearanceConfig(defaultAppearanceConfig, root);

    expect(properties.get('--justdo-assistant-bubble-background-strength')).toBe('100%');
    expect(properties.get('--justdo-assistant-row-gap')).toBe('6px');
    expect(properties.get('--justdo-assistant-bubble-width')).toBe('fit-content');
    expect(properties.get('--justdo-assistant-bubble-min-width')).toBe('0');
    expect(properties.get('--justdo-assistant-stream-border-width')).toBe('3px');
    expect(properties.get('--justdo-assistant-footer-margin-top')).toBe('2px');
    expect(properties.get('--justdo-assistant-footer-padding-left')).toBe('14px');
    expect(properties.get('--justdo-assistant-avatar-first-line-offset')).toBe('0px');
    expect(properties.get('--justdo-assistant-leading-avatar-position')).toBe('static');
    expect(properties.get('--justdo-assistant-leading-content-margin-left')).toBe('0px');
    expect(properties.get('--justdo-active-turn-footer-margin-top')).toBe('8px');
    expect(properties.get('--justdo-process-summary-padding')).toBe('6px 9px');
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

  test('keeps pets hidden when both retired page switches were disabled', () => {
    const stored = {
      ...defaultAppearanceConfig,
      petShowHome: false,
      petShowChat: false,
    };
    const normalized = normalizeAppearanceConfig(stored);
    expect(normalized).toEqual({ ...defaultAppearanceConfig, petEnabled: false });
    expect(normalized).not.toHaveProperty('petShowHome');
    expect(normalized).not.toHaveProperty('petShowChat');
    expect(normalizeAppearanceConfig(normalized)).toEqual(normalized);
    expect(normalizeAppearanceConfig({ ...stored, petEnabled: false }).petEnabled).toBe(false);
    expect(normalizeAppearanceConfig({ ...normalized, petEnabled: true }).petEnabled).toBe(true);
  });

  test.each([
    [true, true],
    [true, false],
    [false, true],
    [undefined, undefined],
    [false, undefined],
  ])('keeps global visibility when retired page switches are %s and %s', (petShowHome, petShowChat) => {
    const stored = { ...defaultAppearanceConfig, petShowHome, petShowChat };
    expect(normalizeAppearanceConfig(stored).petEnabled).toBe(true);
    expect(normalizeAppearanceConfig({ ...stored, petEnabled: false }).petEnabled).toBe(false);
  });
});
