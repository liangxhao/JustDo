const timestampsByKey = new Map<string, number[]>();
const MAX_PROMPTS = 10;
const RATE_WINDOW_MS = 10 * 60_000;

export function widgetFrameInteractable(frame: HTMLElement): boolean {
  const doc = frame.ownerDocument;
  const ownerWindow = doc.defaultView;
  if (!ownerWindow || !frame.isConnected || doc.visibilityState === 'hidden' || !doc.hasFocus())
    return false;
  const rect = frame.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= ownerWindow.innerHeight ||
    rect.left >= ownerWindow.innerWidth
  )
    return false;
  if (
    typeof frame.checkVisibility === 'function' &&
    !frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  )
    return false;
  let active = doc.activeElement;
  // Electron's webview has its own internal shadow iframe. The visible guest
  // element is the focus boundary; do not descend past it into implementation DOM.
  while (active !== frame && active?.shadowRoot?.activeElement)
    active = active.shadowRoot.activeElement;
  return active === frame;
}

/** The canonical wrapper has already checked its captured userActivation getter. */
export function acceptWidgetDraft(
  frame: HTMLIFrameElement,
  raw: unknown,
  key: string,
  now = Date.now(),
): string | undefined {
  if (
    typeof raw !== 'string' ||
    raw.length > 4000 ||
    !raw.trim() ||
    /^\s*[!/]/.test(raw) ||
    !widgetFrameInteractable(frame) ||
    frame.ownerDocument.defaultView?.navigator.userActivation?.isActive !== true
  )
    return;
  return acceptWidgetDraftText(raw, key, now);
}

/** Used after the trusted guest has checked its own native activation and frame. */
export function acceptWidgetDraftText(
  raw: unknown,
  key: string,
  now = Date.now(),
): string | undefined {
  if (typeof raw !== 'string' || raw.length > 4000 || !raw.trim() || /^\s*[!/]/.test(raw)) return;
  const timestamps = (timestampsByKey.get(key) ?? []).filter(time => time > now - RATE_WINDOW_MS);
  if (timestamps.length >= MAX_PROMPTS) return;
  if (!timestampsByKey.has(key) && timestampsByKey.size >= 100)
    timestampsByKey.delete(timestampsByKey.keys().next().value!);
  timestampsByKey.set(key, [...timestamps, now]);
  return raw.trim();
}
