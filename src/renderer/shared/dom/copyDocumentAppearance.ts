/** Mirror host styles and theme without installing application state in the target. */
export function copyDocumentAppearance(
  source: Document,
  target: Document,
  afterSync?: () => void,
): () => void {
  const copies = new Map<Element, Element>();
  const sync = () => {
    const sources = new Set(source.head.querySelectorAll('style, link[rel="stylesheet"]'));
    for (const [style, copy] of copies) {
      if (sources.has(style)) continue;
      copy.remove();
      copies.delete(style);
    }
    for (const style of sources) {
      let copy = copies.get(style);
      if (!copy) {
        copy = target.importNode(style, true);
        if (style.tagName === 'LINK')
          (copy as HTMLLinkElement).href = (style as HTMLLinkElement).href;
        target.head.append(copy);
        copies.set(style, copy);
      }
      if (style.tagName === 'STYLE') {
        const sheet = (style as HTMLStyleElement).sheet;
        const content = sheet
          ? Array.from(sheet.cssRules, rule => rule.cssText).join('\n')
          : style.textContent;
        if (copy.textContent !== content) copy.textContent = content;
      }
    }
    target.documentElement.className = source.documentElement.className;
    target.documentElement.style.cssText = source.documentElement.style.cssText;
    target.documentElement.lang = source.documentElement.lang;
    target.documentElement.dir = source.documentElement.dir;
    for (const attribute of Array.from(target.documentElement.attributes)) {
      if (
        attribute.name.startsWith('data-') &&
        !source.documentElement.hasAttribute(attribute.name)
      )
        target.documentElement.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(source.documentElement.attributes)) {
      if (attribute.name.startsWith('data-'))
        target.documentElement.setAttribute(attribute.name, attribute.value);
    }
    afterSync?.();
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(source.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  observer.observe(source.documentElement, { attributes: true });
  return () => {
    observer.disconnect();
    copies.forEach(copy => copy.remove());
  };
}
