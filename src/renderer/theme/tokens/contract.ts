/**
 * Token Contract — defines all semantic variables a theme must provide.
 *
 * Naming: --gucciai-{category}-{name}
 * Convention: shadcn/ui background/foreground pairing + Radix 12-step gray scale
 *
 * Every theme (ThemeDefinition.tokens) must supply a value for each key.
 */
export const TOKEN_CONTRACT = {
  // ── Brand ──
  primary: '--gucciai-primary',
  'primary-foreground': '--gucciai-primary-foreground',
  'primary-hover': '--gucciai-primary-hover',
  'primary-muted': '--gucciai-primary-muted',

  // ── Accent ──
  accent: '--gucciai-accent',
  'accent-foreground': '--gucciai-accent-foreground',

  // ── Surface / Background ──
  background: '--gucciai-background',
  foreground: '--gucciai-foreground',
  surface: '--gucciai-surface',
  'surface-foreground': '--gucciai-surface-foreground',
  'surface-raised': '--gucciai-surface-raised',
  'surface-overlay': '--gucciai-surface-overlay',

  // ── Chat bubbles ──
  'chat-user': '--gucciai-chat-user',
  'chat-user-foreground': '--gucciai-chat-user-foreground',
  'chat-bot': '--gucciai-chat-bot',
  'chat-bot-foreground': '--gucciai-chat-bot-foreground',

  // ── Text hierarchy ──
  'text-primary': '--gucciai-text-primary',
  'text-secondary': '--gucciai-text-secondary',
  'text-muted': '--gucciai-text-muted',

  // ── Borders ──
  border: '--gucciai-border',
  'border-subtle': '--gucciai-border-subtle',
  'input-border': '--gucciai-input-border',

  // ── Scrollbar ──
  'scroll-thumb': '--gucciai-scroll-thumb',
  'scroll-thumb-hover': '--gucciai-scroll-thumb-hover',

  // ── Decorative gradients ──
  'gradient-1': '--gucciai-gradient-1',
  'gradient-2': '--gucciai-gradient-2',

  // ── Status ──
  destructive: '--gucciai-destructive',
  'destructive-foreground': '--gucciai-destructive-foreground',
  success: '--gucciai-success',
  warning: '--gucciai-warning',

  // ── Gray scale 11 steps (gray-1=lightest → gray-11=darkest, all themes) ──
  'gray-1': '--gucciai-gray-1',
  'gray-2': '--gucciai-gray-2',
  'gray-3': '--gucciai-gray-3',
  'gray-4': '--gucciai-gray-4',
  'gray-5': '--gucciai-gray-5',
  'gray-6': '--gucciai-gray-6',
  'gray-7': '--gucciai-gray-7',
  'gray-8': '--gucciai-gray-8',
  'gray-9': '--gucciai-gray-9',
  'gray-10': '--gucciai-gray-10',
  'gray-11': '--gucciai-gray-11',

  // ── Radius ──
  radius: '--gucciai-radius',
} as const;

export type TokenName = keyof typeof TOKEN_CONTRACT;
export type CSSVarName = (typeof TOKEN_CONTRACT)[TokenName];

/** All token keys as an array */
export const TOKEN_NAMES = Object.keys(TOKEN_CONTRACT) as TokenName[];
