/** Forward only the native sandbox's unconsumed pixel delta to its own chat. */
export function forwardWidgetScroll(widget: HTMLElement, deltaY: number): void {
  const ownerWindow = widget.ownerDocument.defaultView;
  if (!ownerWindow || widget.ownerDocument.visibilityState === 'hidden') return;
  let node: Element | null = widget;
  while (node && node.localName !== 'justdo-chat') {
    node = node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
  }
  const transcript = node as HTMLElement | null;
  if (!transcript?.isConnected || transcript.ownerDocument !== widget.ownerDocument) return;
  // Intent must reach history paging and reader takeover before moving the viewport.
  const event = new (ownerWindow as Window & typeof globalThis).WheelEvent('wheel', {
    deltaY,
    cancelable: true,
  });
  if (transcript.dispatchEvent(event)) transcript.scrollBy({ top: deltaY, behavior: 'instant' });
}
