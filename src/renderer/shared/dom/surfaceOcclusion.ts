/** Shared by native workspace surfaces and retained same-document App surfaces. */
export function readSurfaceOcclusion(rect: DOMRect, doc: Document = document) {
  const blocked = Array.from(doc.querySelectorAll('[data-workspace-overlay="true"]')).some(
    overlay => overlay.getClientRects().length > 0,
  );
  const occluded =
    blocked ||
    Array.from(
      doc.querySelectorAll(
        '[role="menu"], [role="listbox"], [role="tooltip"], [data-workspace-occlusion="true"]',
      ),
    ).some(element => {
      if (!element.getClientRects().length) return false;
      const popup = element.getBoundingClientRect();
      return (
        popup.right > rect.left &&
        popup.left < rect.right &&
        popup.bottom > rect.top &&
        popup.top < rect.bottom
      );
    });
  return { blocked, occluded };
}
