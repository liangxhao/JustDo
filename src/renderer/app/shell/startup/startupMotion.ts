export const STARTUP_ENTRY_DURATION_MS = 1400;
export const STARTUP_REVEAL_DURATION_MS = 640;
export const STARTUP_ENTRY_STARTED_ATTRIBUTE = 'data-startup-entry-started-at';
export const StartupEntryPhase = {
  Seed: 'seed',
  Measuring: 'measuring',
  Opening: 'opening',
  Open: 'open',
} as const;

/** A document clock survives the static HTML → React and pending → snapshot handoffs. */
export function startupEntryRemaining(): number {
  const value = document.documentElement.getAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE);
  if (value === null) return 0;
  const startedAt = Number(value);
  return Number.isFinite(startedAt)
    ? Math.max(0, STARTUP_ENTRY_DURATION_MS - Math.max(0, Date.now() - startedAt))
    : 0;
}

/** Browser-only; also bundled into the first-paint script without React or services. */
export function prepareStartupEntry(frame: HTMLElement, failed = false): () => void {
  if (failed) {
    frame.dataset.entry = StartupEntryPhase.Open;
    return () => {};
  }
  if (!document.documentElement.hasAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE)) {
    document.documentElement.setAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE, String(Date.now()));
  }
  let disposed = false;
  frame.style.setProperty('--startup-entry-duration', `${STARTUP_ENTRY_DURATION_MS}ms`);
  const measure = () => {
    if (disposed) return;
    const remaining = startupEntryRemaining();
    // Measure final layout without a transform, then resume at the document's elapsed time.
    frame.dataset.entry = StartupEntryPhase.Measuring;
    const emblem = frame.querySelector<HTMLElement>('.startup-emblem');
    if (emblem) {
      const viewport = frame.getBoundingClientRect();
      const logo = emblem.getBoundingClientRect();
      frame.style.setProperty(
        '--startup-seed-offset',
        `${viewport.top + viewport.height / 2 - logo.top - logo.height / 2}px`,
      );
    }
    frame.style.setProperty('--startup-entry-delay', `${remaining - STARTUP_ENTRY_DURATION_MS}ms`);
    frame.dataset.entry = remaining > 0 ? StartupEntryPhase.Opening : StartupEntryPhase.Open;
  };
  measure();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
  if (startupEntryRemaining() > 0) observer?.observe(frame);
  const timer = window.setTimeout(() => {
    observer?.disconnect();
    if (!disposed) frame.dataset.entry = StartupEntryPhase.Open;
  }, startupEntryRemaining());
  return () => {
    disposed = true;
    window.clearTimeout(timer);
    observer?.disconnect();
  };
}
