export const surfaceKeyboardDocument = new WeakMap<Event, Document>();

export function forwardSurfaceKeyboard(
  event: KeyboardEvent,
  source: Document,
  destination: Document,
): void {
  if (event.defaultPrevented || event.isComposing) return;
  const forwarded = new KeyboardEvent('keydown', {
    key: event.key,
    code: event.code,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
    bubbles: true,
    cancelable: true,
  });
  surfaceKeyboardDocument.set(forwarded, source);
  destination.dispatchEvent(forwarded);
  if (forwarded.defaultPrevented) event.preventDefault();
}
