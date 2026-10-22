export const STARTUP_ENTRY_DURATION_MS = 1280;
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

/** Soft light gathers around the centered mark, which settles into the final header.
 * One Main clock survives HTML, React, reload and the transient window handoff.
 * Animations never advance a startup/data milestone.
 */
export function prepareStartupEntry(frame: HTMLElement, failed = false): () => void {
  if (failed) {
    frame.dataset.entry = StartupEntryPhase.Open;
    return () => {};
  }
  if (!document.documentElement.hasAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE)) {
    document.documentElement.setAttribute(
      STARTUP_ENTRY_STARTED_ATTRIBUTE,
      String(window.electron?.initialization?.entryStartedAt ?? Date.now()),
    );
  }
  const remaining = startupEntryRemaining();
  frame.dataset.entry = StartupEntryPhase.Measuring;
  const logo = frame.querySelector<HTMLImageElement>('[data-startup-logo], .startup-emblem img');
  if (!remaining || !logo || typeof logo.animate !== 'function') {
    frame.dataset.entry = StartupEntryPhase.Open;
    return () => {};
  }
  const target = logo.getBoundingClientRect();
  const seed = document.createElement('div');
  seed.className = 'startup-soft-seed';
  seed.setAttribute('aria-hidden', 'true');
  const mark = logo.cloneNode(true) as HTMLImageElement;
  mark.removeAttribute('data-startup-logo');
  mark.style.width = `${target.width}px`;
  mark.style.height = `${target.height}px`;
  seed.appendChild(mark);
  const halo = document.createElement('div');
  halo.className = 'startup-soft-halo';
  halo.setAttribute('aria-hidden', 'true');
  // Stay inside the owning presentation's stacking context. The Gate cover is
  // above body siblings, so a global seed would disappear behind the cover.
  frame.append(halo, seed);
  const centerX = (window.innerWidth - target.width) / 2;
  const centerY = (window.innerHeight - target.height) / 2;
  const elapsed = STARTUP_ENTRY_DURATION_MS - remaining;
  const animations: Animation[] = [];
  const animate = (element: HTMLElement, frames: Keyframe[]) => {
    const animation = element.animate(frames, {
      duration: STARTUP_ENTRY_DURATION_MS,
      fill: 'both',
      easing: 'linear',
    });
    animation.currentTime = elapsed;
    animations.push(animation);
  };
  const previousVisibility = logo.style.visibility;
  logo.style.visibility = 'hidden';
  frame.dataset.entry = StartupEntryPhase.Opening;
  animate(seed, [
    { transform: `translate(${centerX}px,${centerY}px) scale(.9)`, opacity: 1, offset: 0 },
    { transform: `translate(${centerX}px,${centerY}px) scale(1.22)`, offset: 0.22 },
    {
      transform: `translate(${centerX}px,${centerY}px) scale(1.22)`,
      offset: 0.38,
      easing: 'cubic-bezier(.45,0,.2,1)',
    },
    { transform: `translate(${target.left}px,${target.top}px) scale(1)`, offset: 1 },
  ]);
  animate(halo, [
    { opacity: 0, transform: 'translate(-50%,-50%) scale(.6)', offset: 0 },
    { opacity: 0.7, transform: 'translate(-50%,-50%) scale(1.2)', offset: 0.3 },
    { opacity: 0, transform: 'translate(-50%,-50%) scale(1.6)', offset: 1 },
  ]);
  for (const element of frame.querySelectorAll<HTMLElement>(
    '[data-startup-panel], .startup-brand-copy, .startup-details, [data-startup-heading], [data-startup-emblem], .startup-emblem',
  )) {
    animate(element, [
      { opacity: 0, transform: 'translateY(15px)', offset: 0 },
      {
        opacity: 0,
        transform: 'translateY(15px)',
        offset: 0.45,
        easing: 'cubic-bezier(.2,0,.2,1)',
      },
      { opacity: 1, transform: 'translateY(0)', offset: 1 },
    ]);
  }
  frame.querySelectorAll<HTMLElement>('[data-startup-panel] nav li').forEach((step, index) => {
    const begin = 0.55 + Math.min(0.03 * index, 0.15);
    animate(step, [
      { opacity: 0, transform: 'translateX(-8px)', offset: 0 },
      { opacity: 0, transform: 'translateX(-8px)', offset: begin, easing: 'ease-out' },
      { opacity: 1, transform: 'translateX(0)', offset: Math.min(1, begin + 0.25) },
      { opacity: 1, transform: 'translateX(0)', offset: 1 },
    ]);
  });
  let disposed = false;
  const finish = () => {
    if (disposed) return;
    disposed = true;
    logo.style.visibility = previousVisibility;
    seed.remove();
    halo.remove();
    animations.forEach(animation => animation.cancel());
    frame.dataset.entry = StartupEntryPhase.Open;
  };
  const timer = window.setTimeout(finish, remaining);
  // Resize cannot leave the mark stranded at an obsolete coordinate.
  window.addEventListener('resize', finish, { once: true });
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('resize', finish);
    finish();
  };
}
