// Serialized into the opaque document with the geometry bridge. Keep all
// dependencies inside the factory, and restore only styles this adapter owns.
export function createWidgetViewportFit(): (expanded: boolean) => void {
  type Style = { property: string; value: string; priority: string; applied: string };
  type Managed = { element: HTMLElement; styles: Style[] };
  let clipping: Managed | undefined;
  let expandedStyles: Managed | undefined;
  const restore = (managed: Managed | undefined) => {
    if (!managed) return;
    for (const entry of managed.styles) {
      if (
        managed.element.style.getPropertyValue(entry.property) !== entry.applied ||
        managed.element.style.getPropertyPriority(entry.property) !== 'important'
      )
        continue;
      if (entry.value)
        managed.element.style.setProperty(entry.property, entry.value, entry.priority);
      else managed.element.style.removeProperty(entry.property);
    }
  };
  const apply = (element: HTMLElement, values: string[][]): Managed => ({
    element,
    styles: values.map(([property, value]) => {
      const entry = {
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
        applied: '',
      };
      element.style.setProperty(property, value, 'important');
      entry.applied = element.style.getPropertyValue(property);
      return entry;
    }),
  });
  const release = () => {
    restore(expandedStyles);
    restore(clipping);
    expandedStyles = clipping = undefined;
  };
  return expanded => {
    if (!expanded) {
      restore(expandedStyles);
      expandedStyles = undefined;
    }
    const body = document.body;
    if (!body?.children) return;
    const page = body.getBoundingClientRect();
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).display !== 'none';
    };
    const roots = Array.from(body.children).filter(visible);
    // Only a standalone full-page canvas is adapted. Flow documents, multiple
    // panels and charts with normal-flow captions retain their own layout.
    if (
      roots.length !== 1 ||
      !(roots[0] instanceof HTMLElement) ||
      getComputedStyle(body).overflowY !== 'hidden' ||
      Math.abs(page.width - innerWidth) > 1 ||
      Math.abs(page.height - innerHeight) > 1
    ) {
      release();
      return;
    }
    const element = roots[0];
    const canvases = Array.from(element.querySelectorAll('canvas')).filter(visible);
    if (element.localName === 'canvas' || canvases.length !== 1) {
      release();
      return;
    }
    const surface = canvases[0];
    const hasFlowSibling = Array.from(element.children).some(
      child =>
        child !== surface &&
        visible(child) &&
        !['absolute', 'fixed'].includes(getComputedStyle(child).position),
    );
    if (surface.parentElement !== element || hasFlowSibling) {
      release();
      return;
    }
    if (clipping?.element !== element) {
      release();
      const root = element.getBoundingClientRect();
      const canvas = surface.getBoundingClientRect();
      if (
        Math.abs(root.width - page.width) > 1 ||
        Math.abs(root.left - page.left) > 1 ||
        Math.abs(root.top - page.top) > 1 ||
        Math.abs(canvas.width - root.width) > 1 ||
        Math.abs(canvas.height - root.height) > 1 ||
        Math.abs(canvas.top - root.top) > 1 ||
        Math.abs(canvas.left - root.left) > 1
      )
        return;
      // A previous canvas backing-store size must not become page overflow while
      // the document's own ResizeObserver is redrawing the restored container.
      clipping = apply(element, [
        ['overflow-x', 'clip'],
        ['overflow-y', 'clip'],
      ]);
    }
    if (expanded && !expandedStyles)
      expandedStyles = apply(element, [
        ['height', '100%'],
        ['min-height', '0'],
        ['max-height', 'none'],
      ]);
  };
}
