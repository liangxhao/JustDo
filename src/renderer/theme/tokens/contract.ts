/**
 * Token Contract — defines all semantic variables a theme must provide.
 *
 * Naming: --justdo-{category}-{name}
 * Convention: shadcn/ui background/foreground pairing + Radix 12-step gray scale
 *
 * Every theme (ThemeDefinition.tokens) must supply a value for each key.
 */
export const TOKEN_CONTRACT = {
  // ── Brand ──
  primary: '--justdo-primary',
  'primary-foreground': '--justdo-primary-foreground',
  'primary-hover': '--justdo-primary-hover',
  'primary-muted': '--justdo-primary-muted',

  // ── Accent ──
  accent: '--justdo-accent',
  'accent-foreground': '--justdo-accent-foreground',

  // ── Surface / Background ──
  background: '--justdo-background',
  foreground: '--justdo-foreground',
  surface: '--justdo-surface',
  'surface-foreground': '--justdo-surface-foreground',
  'surface-raised': '--justdo-surface-raised',
  'surface-overlay': '--justdo-surface-overlay',

  // ── Chat bubbles ──
  'chat-user': '--justdo-chat-user',
  'chat-user-foreground': '--justdo-chat-user-foreground',
  'chat-bot': '--justdo-chat-bot',
  'chat-bot-foreground': '--justdo-chat-bot-foreground',

  // ── Text hierarchy ──
  'text-primary': '--justdo-text-primary',
  'text-secondary': '--justdo-text-secondary',
  'text-muted': '--justdo-text-muted',

  // ── Borders ──
  border: '--justdo-border',
  'border-subtle': '--justdo-border-subtle',
  'input-border': '--justdo-input-border',

  // ── Scrollbar ──
  'scroll-thumb': '--justdo-scroll-thumb',
  'scroll-thumb-hover': '--justdo-scroll-thumb-hover',

  // ── Decorative gradients ──
  'gradient-1': '--justdo-gradient-1',
  'gradient-2': '--justdo-gradient-2',

  // ── Status ──
  destructive: '--justdo-destructive',
  'destructive-foreground': '--justdo-destructive-foreground',
  success: '--justdo-success',
  warning: '--justdo-warning',

  // ── Gray scale 11 steps (gray-1=lightest → gray-11=darkest, all themes) ──
  'gray-1': '--justdo-gray-1',
  'gray-2': '--justdo-gray-2',
  'gray-3': '--justdo-gray-3',
  'gray-4': '--justdo-gray-4',
  'gray-5': '--justdo-gray-5',
  'gray-6': '--justdo-gray-6',
  'gray-7': '--justdo-gray-7',
  'gray-8': '--justdo-gray-8',
  'gray-9': '--justdo-gray-9',
  'gray-10': '--justdo-gray-10',
  'gray-11': '--justdo-gray-11',

  // ── Radius ──
  radius: '--justdo-radius',
} as const;

export type TokenName = keyof typeof TOKEN_CONTRACT;
export type CSSVarName = (typeof TOKEN_CONTRACT)[TokenName];

/** All token keys as an array */
export const TOKEN_NAMES = Object.keys(TOKEN_CONTRACT) as TokenName[];
