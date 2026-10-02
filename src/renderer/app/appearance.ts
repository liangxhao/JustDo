export type AppearanceFontFamily = 'system' | 'sans' | 'serif' | 'monospace';
export type MessageLayout = 'bubble' | 'document';
export type MessageDensity = 'compact' | 'comfortable' | 'spacious';
export type PetVariety = 'classic' | 'varied' | 'playful';
export type PetSpeed = 'calm' | 'normal' | 'lively';
export type PetRestAfter = 'never' | 'short' | 'standard' | 'long';
export type PetCatSelection = 'white' | 'black' | 'both';

export interface AppearanceConfig {
  chatContentWidth: number;
  fontFamily: AppearanceFontFamily;
  fontSize: number;
  messageLayout: MessageLayout;
  messageDensity: MessageDensity;
  wrapCodeBlocks: boolean;
  petEnabled: boolean;
  petAnimationEnabled: boolean;
  petVariety: PetVariety;
  petSpeed: PetSpeed;
  petRestAfter: PetRestAfter;
  petFloatingEnabled: boolean;
  petCatSelection: PetCatSelection;
}

export const defaultAppearanceConfig: AppearanceConfig = {
  chatContentWidth: 80,
  fontFamily: 'system',
  fontSize: 16,
  messageLayout: 'bubble',
  messageDensity: 'comfortable',
  wrapCodeBlocks: false,
  petEnabled: true,
  petAnimationEnabled: true,
  petVariety: 'playful',
  petSpeed: 'normal',
  petRestAfter: 'standard',
  petFloatingEnabled: false,
  petCatSelection: 'both',
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

const ASSISTANT_ROW_GAPS: Record<MessageDensity, number> = {
  compact: 8,
  comfortable: 12,
  spacious: 18,
};

const DOCUMENT_FOOTER_GAPS: Record<MessageDensity, number> = {
  compact: 6,
  comfortable: 8,
  spacious: 10,
};

const isFontFamily = (value: unknown): value is AppearanceFontFamily =>
  value === 'system' || value === 'sans' || value === 'serif' || value === 'monospace';

const isMessageDensity = (value: unknown): value is MessageDensity =>
  value === 'compact' || value === 'comfortable' || value === 'spacious';

const isMessageLayout = (value: unknown): value is MessageLayout =>
  value === 'bubble' || value === 'document';

const isPetVariety = (value: unknown): value is PetVariety =>
  value === 'classic' || value === 'varied' || value === 'playful';
const isPetSpeed = (value: unknown): value is PetSpeed =>
  value === 'calm' || value === 'normal' || value === 'lively';
const isPetRestAfter = (value: unknown): value is PetRestAfter =>
  value === 'never' || value === 'short' || value === 'standard' || value === 'long';
const isPetCatSelection = (value: unknown): value is PetCatSelection =>
  value === 'white' || value === 'black' || value === 'both';

const clampNumber = (
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
};

const normalizePetEnabled = (
  value?: (Partial<AppearanceConfig> & { petShowHome?: unknown; petShowChat?: unknown }) | null,
): boolean => {
  const enabled = typeof value?.petEnabled === 'boolean'
    ? value.petEnabled : defaultAppearanceConfig.petEnabled;
  // Preserve the hidden state when replacing the two retired page switches.
  return enabled && !(value?.petShowHome === false && value?.petShowChat === false);
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
  messageLayout: isMessageLayout(value?.messageLayout)
    ? value.messageLayout
    : defaultAppearanceConfig.messageLayout,
  messageDensity: isMessageDensity(value?.messageDensity)
    ? value.messageDensity
    : defaultAppearanceConfig.messageDensity,
  wrapCodeBlocks:
    typeof value?.wrapCodeBlocks === 'boolean'
      ? value.wrapCodeBlocks
      : defaultAppearanceConfig.wrapCodeBlocks,
  petEnabled: normalizePetEnabled(value),
  petAnimationEnabled:
    typeof value?.petAnimationEnabled === 'boolean'
      ? value.petAnimationEnabled
      : defaultAppearanceConfig.petAnimationEnabled,
  petVariety: isPetVariety(value?.petVariety) ? value.petVariety : defaultAppearanceConfig.petVariety,
  petSpeed: isPetSpeed(value?.petSpeed) ? value.petSpeed : defaultAppearanceConfig.petSpeed,
  petRestAfter: isPetRestAfter(value?.petRestAfter) ? value.petRestAfter : defaultAppearanceConfig.petRestAfter,
  petFloatingEnabled: typeof value?.petFloatingEnabled === 'boolean'
    ? value.petFloatingEnabled : defaultAppearanceConfig.petFloatingEnabled,
  petCatSelection: isPetCatSelection(value?.petCatSelection)
    ? value.petCatSelection : defaultAppearanceConfig.petCatSelection,
});

export const applyAppearanceConfig = (
  value: Partial<AppearanceConfig> | null | undefined,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): AppearanceConfig => {
  const appearance = normalizeAppearanceConfig(value);
  if (!root) return appearance;

  if (root.dataset) {
    root.dataset.coworkPet = appearance.petEnabled ? 'on' : 'off';
    root.dataset.coworkPetMotion = appearance.petAnimationEnabled ? 'on' : 'off';
    root.dataset.coworkPetVariety = appearance.petVariety;
    root.dataset.coworkPetSpeed = appearance.petSpeed;
    root.dataset.coworkPetRestAfter = appearance.petRestAfter;
    root.dataset.coworkPetFloating = appearance.petFloatingEnabled ? 'on' : 'off';
    root.dataset.coworkPetCats = appearance.petCatSelection;
  }

  root.style.fontSize = `${appearance.fontSize}px`;
  root.style.setProperty('--justdo-font-family', FONT_STACKS[appearance.fontFamily]);
  root.style.setProperty('--justdo-chat-font-size', `${Math.max(12, appearance.fontSize - 2)}px`);
  root.style.setProperty('--justdo-chat-content-width', `${appearance.chatContentWidth}%`);
  root.style.setProperty('--justdo-message-gap', `${MESSAGE_GAPS[appearance.messageDensity]}px`);
  root.style.setProperty('--justdo-timeline-gap', `${TIMELINE_GAPS[appearance.messageDensity]}px`);
  const usesDocumentLayout = appearance.messageLayout === 'document';
  root.style.setProperty(
    '--justdo-assistant-row-gap',
    `${
      usesDocumentLayout
        ? ASSISTANT_ROW_GAPS[appearance.messageDensity]
        : ASSISTANT_ROW_GAPS[appearance.messageDensity] / 2
    }px`,
  );
  root.style.setProperty(
    '--justdo-assistant-bubble-background-strength',
    usesDocumentLayout ? '0%' : '100%',
  );
  root.style.setProperty(
    '--justdo-assistant-bubble-padding',
    usesDocumentLayout ? '0' : '10px 14px',
  );
  root.style.setProperty(
    '--justdo-assistant-bubble-copy-padding-right',
    usesDocumentLayout ? '34px' : '14px',
  );
  root.style.setProperty(
    '--justdo-assistant-bubble-radius',
    usesDocumentLayout ? '0' : '12px 12px 12px 4px',
  );
  root.style.setProperty(
    '--justdo-assistant-bubble-width',
    usesDocumentLayout ? '100%' : 'fit-content',
  );
  root.style.setProperty('--justdo-assistant-bubble-min-width', usesDocumentLayout ? '100%' : '0');
  root.style.setProperty(
    '--justdo-assistant-stream-border-width',
    usesDocumentLayout ? '0px' : '3px',
  );
  root.style.setProperty(
    '--justdo-assistant-footer-margin-top',
    usesDocumentLayout ? `${DOCUMENT_FOOTER_GAPS[appearance.messageDensity]}px` : '2px',
  );
  root.style.setProperty(
    '--justdo-assistant-footer-padding-left',
    usesDocumentLayout ? '0px' : '14px',
  );
  root.style.setProperty(
    '--justdo-assistant-avatar-first-line-offset',
    usesDocumentLayout ? 'calc(16px - 0.8em)' : '0px',
  );
  root.style.setProperty(
    '--justdo-assistant-leading-avatar-position',
    usesDocumentLayout ? 'absolute' : 'static',
  );
  root.style.setProperty(
    '--justdo-assistant-leading-content-margin-left',
    usesDocumentLayout ? '44px' : '0px',
  );
  root.style.setProperty(
    '--justdo-active-turn-footer-margin-top',
    usesDocumentLayout ? `${DOCUMENT_FOOTER_GAPS[appearance.messageDensity]}px` : '8px',
  );
  root.style.setProperty(
    '--justdo-process-summary-padding',
    usesDocumentLayout ? '0 9px 0 0' : '6px 9px',
  );
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
