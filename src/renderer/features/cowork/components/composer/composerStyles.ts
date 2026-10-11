/** Shared visual shell and sizing for conversation composers. */
export const COMPOSER_FRAME_CLASS = 'rounded-2xl shadow-glow-accent';

export const COMPOSER_SURFACE_CLASS =
  'relative rounded-2xl border border-border bg-surface shadow-card focus-within:shadow-elevated focus-within:ring-1 focus-within:ring-primary/40 focus-within:border-primary';

export const COMPOSER_TEXTAREA_CLASS =
  'w-full resize-none bg-transparent px-4 pt-2.5 pb-2 text-foreground placeholder:dark:text-foregroundSecondary/60 placeholder:text-secondary/60 focus:outline-none text-[15px] leading-6';

export const COMPOSER_TEXTAREA_MIN_HEIGHT = 60;
export const COMPOSER_TEXTAREA_MAX_HEIGHT = 200;

export function resizeComposerTextarea(
  textarea: HTMLTextAreaElement,
  minHeight = COMPOSER_TEXTAREA_MIN_HEIGHT,
) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), COMPOSER_TEXTAREA_MAX_HEIGHT)}px`;
}
