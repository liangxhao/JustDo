export const browserToolbarGroupClassName =
  'flex shrink-0 items-center gap-0.5 rounded-lg border border-border/70 bg-surface-raised/60 p-0.5';

export const browserToolbarButtonClassName = (active: boolean): string =>
  `inline-flex h-8 w-8 items-center justify-center rounded-md bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
    active
      ? 'text-primary ring-1 ring-inset ring-primary/55 hover:text-primary'
      : 'text-secondary hover:bg-surface-raised hover:text-foreground'
  } disabled:pointer-events-none disabled:opacity-40`;
