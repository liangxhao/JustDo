import { type DefaultTreeAdapterMap, parse, serializeOuter } from 'parse5';

import { WIDGET_IMAGE_SOURCE_ATTRIBUTE } from './image-loading';

type DocumentAttributes = {
  target: 'html' | 'body';
  attributes: { name: string; value: string }[];
};

function remoteImageSource(value: string): boolean {
  if (value.trimStart().startsWith('//')) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Native owns the shell; retain authored contents and their execution order. */
export function prepareHtmlSource(source: string): {
  html: string;
  documentAttributes: DocumentAttributes[];
} {
  const tree = parse(source, { sourceCodeLocationInfo: true });
  const edits: { start: number; end: number; text: string }[] = [];
  const documentAttributes: DocumentAttributes[] = [];
  const visit = (node: DefaultTreeAdapterMap['node']): void => {
    const location = node.sourceCodeLocation;
    if (node.nodeName === '#documentType' && location)
      edits.push({ start: location.startOffset, end: location.endOffset, text: '' });
    if ('tagName' in node) {
      if (
        node.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
        ['html', 'head', 'body'].includes(node.tagName) &&
        location
      ) {
        if ('startTag' in location && location.startTag)
          edits.push({
            start: location.startTag.startOffset,
            end: location.startTag.endOffset,
            text: '',
          });
        if ('endTag' in location && location.endTag)
          edits.push({
            start: location.endTag.startOffset,
            end: location.endTag.endOffset,
            text: '',
          });
        if ((node.tagName === 'html' || node.tagName === 'body') && node.attrs.length)
          documentAttributes.push({
            target: node.tagName,
            attributes: node.attrs.map(attribute => ({
              name: attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name,
              value: attribute.value,
            })),
          });
      }
      const imageSource =
        node.tagName === 'img' && node.attrs.find(attribute => attribute.name === 'src');
      if (imageSource && remoteImageSource(imageSource.value) && location) {
        // A parser-created src bypasses JavaScript setters. Hold it until the
        // document's image bootstrap can apply the same native fetch policy.
        const attributes = node.attrs
          .filter(attribute => attribute.name !== WIDGET_IMAGE_SOURCE_ATTRIBUTE)
          .map(attribute =>
            attribute === imageSource
              ? { ...attribute, name: WIDGET_IMAGE_SOURCE_ATTRIBUTE }
              : attribute,
          );
        edits.push({
          start: location.startOffset,
          end: location.endOffset,
          text: serializeOuter({ ...node, attrs: attributes }),
        });
      }
      if ('content' in node && node.tagName === 'template') visit(node.content);
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(tree);
  let html = source;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
  return { html, documentAttributes };
}

/** Self-contained because composition serializes it into the native document. */
export function applyDocumentAttributes(targets: DocumentAttributes[]): void {
  for (const target of targets) {
    const element = target.target === 'html' ? document.documentElement : document.body;
    for (const attribute of target.attributes)
      element.setAttribute(attribute.name, attribute.value);
  }
}
