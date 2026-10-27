const DOCUMENTS_PATH = '/__openclaw__/canvas/documents/';
const MAX_RESOURCE_PATH_LENGTH = 8192;

export function hostedCanvasDocumentPrefix(documentId: string): string | null {
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(documentId) || documentId === '.' || documentId === '..')
    return null;
  return `${DOCUMENTS_PATH}${documentId}/`;
}

/** Validate before URL parsing, which would otherwise erase encoded dot segments. */
export function canonicalHostedCanvasResource(rawPath: string, documentId: string): string | null {
  const prefix = hostedCanvasDocumentPrefix(documentId);
  if (
    !prefix ||
    !rawPath.startsWith(prefix) ||
    rawPath.length > MAX_RESOURCE_PATH_LENGTH ||
    /[\\\u0000-\u0020\u007f#]/.test(rawPath)
  )
    return null;
  const queryAt = rawPath.indexOf('?');
  const pathname = queryAt < 0 ? rawPath : rawPath.slice(0, queryAt);
  const query = queryAt < 0 ? '' : rawPath.slice(queryAt);
  const rawSegments = pathname.slice(prefix.length).split('/');
  if (!rawSegments.length || rawSegments.some(segment => !segment)) return null;
  const segments: string[] = [];
  for (const segment of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      !decoded ||
      decoded === '.' ||
      decoded === '..' ||
      /[\\/:%\u0000-\u001f\u007f]/.test(decoded)
    )
      return null;
    segments.push(encodeURIComponent(decoded));
  }
  const parameters = new URLSearchParams(query);
  // Gateway recognizes this as an authorization credential. A model or document
  // cannot supply it, even though all other static resource queries are harmless.
  if ([...parameters.keys()].some(key => key.toLowerCase() === 'oc_cap')) return null;
  return `${prefix}${segments.join('/')}${query}`;
}

export function hostedCanvasEntryResource(documentId: string, entryPath: string): string | null {
  const prefix = hostedCanvasDocumentPrefix(documentId);
  if (!prefix || !entryPath || entryPath.startsWith('/') || /[?#]/.test(entryPath)) return null;
  return canonicalHostedCanvasResource(`${prefix}${entryPath}`, documentId);
}
