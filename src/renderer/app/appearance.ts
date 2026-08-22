export type AppearanceFontFamily = 'system' | 'sans' | 'serif' | 'monospace';
export type MessageDensity = 'compact' | 'comfortable' | 'spacious';

export interface AppearanceConfig {
  chatContentWidth: number;
  fontFamily: AppearanceFontFamily;
  fontSize: number;
  messageDensity: MessageDensity;
  wrapCodeBlocks: boolean;
}

export const defaultAppearanceConfig: AppearanceConfig = {
  chatContentWidth: 70,
  fontFamily: 'system',
  fontSize: 16,
  messageDensity: 'comfortable',
  wrapCodeBlocks: false,
};

const FONT_STACKS: Record<AppearanceFontFamily, string> = {
  system:
    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Microsoft YaHei UI', 'PingFang SC', 'Segoe UI', sans-serif",
  sans: "Inter, 'Noto Sans SC', 'Microsoft YaHei UI', 'PingFang SC', Arial, sans-serif",
  serif: "'Noto Serif SC', 'Songti SC', SimSun, Georgia, serif",
  monospace: "'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
};

const MESSAGE_GAPS: Record<MessageDensity, number> = {
  compact: 4,
  comfortable: 8,
  spacious: 14,
};

const TIMELINE_GAPS: Record<MessageDensity, number> = {
  compact: 2,
  comfortable: 4,
  spacious: 8,
};

const isFontFamily = (value: unknown): value is AppearanceFontFamily =>
  value === 'system' || value === 'sans' || value === 'serif' || value === 'monospace';

const isMessageDensity = (value: unknown): value is MessageDensity =>
  value === 'compact' || value === 'comfortable' || value === 'spacious';

const clampNumber = (
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
};

export const normalizeAppearanceConfig = (
  value?: Partial<AppearanceConfig> | null,
): AppearanceConfig => ({
  chatContentWidth: clampNumber(
    value?.chatContentWidth,
    60,
    100,
    defaultAppearanceConfig.chatContentWidth,
  ),
  fontFamily: isFontFamily(value?.fontFamily)
    ? value.fontFamily
    : defaultAppearanceConfig.fontFamily,
  fontSize: clampNumber(value?.fontSize, 13, 20, defaultAppearanceConfig.fontSize),
  messageDensity: isMessageDensity(value?.messageDensity)
    ? value.messageDensity
    : defaultAppearanceConfig.messageDensity,
  wrapCodeBlocks:
    typeof value?.wrapCodeBlocks === 'boolean'
      ? value.wrapCodeBlocks
      : defaultAppearanceConfig.wrapCodeBlocks,
});

export const applyAppearanceConfig = (
  value: Partial<AppearanceConfig> | null | undefined,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): AppearanceConfig => {
  const appearance = normalizeAppearanceConfig(value);
  if (!root) return appearance;

  root.style.fontSize = `${appearance.fontSize}px`;
  root.style.setProperty('--justdo-font-family', FONT_STACKS[appearance.fontFamily]);
  root.style.setProperty('--justdo-chat-font-size', `${Math.max(12, appearance.fontSize - 2)}px`);
  root.style.setProperty('--justdo-chat-content-width', `${appearance.chatContentWidth}%`);
  root.style.setProperty('--justdo-message-gap', `${MESSAGE_GAPS[appearance.messageDensity]}px`);
  root.style.setProperty('--justdo-timeline-gap', `${TIMELINE_GAPS[appearance.messageDensity]}px`);
  root.style.setProperty(
    '--justdo-code-white-space',
    appearance.wrapCodeBlocks ? 'pre-wrap' : 'pre',
  );
  root.style.setProperty(
    '--justdo-code-overflow-wrap',
    appearance.wrapCodeBlocks ? 'anywhere' : 'normal',
  );
  root.style.setProperty('--justdo-code-width', appearance.wrapCodeBlocks ? '100%' : 'max-content');

  return appearance;
};
