export const OFFLINE_HTML_KIND = 'offline-html';
export const OFFLINE_HTML_MAX_SOURCE_CHARS = 262_144;
export const OFFLINE_LIBRARY_IDS = [
  'three',
  'echarts',
  'katex',
  'mermaid',
  'd3',
  'matter',
] as const;

export type OfflineLibraryId = (typeof OFFLINE_LIBRARY_IDS)[number];
export type OfflineHtmlDocument = {
  version: 1;
  libraries: OfflineLibraryId[];
  html: string;
};

export class OfflineHtmlSourceError extends Error {
  constructor(path: string, rule: string) {
    super(`${path}: ${rule}`);
    this.name = 'OfflineHtmlSourceError';
  }
}

function reject(path: string, rule: string): never {
  throw new OfflineHtmlSourceError(path, rule);
}

function startsWithDocumentShell(html: string): boolean {
  let remaining = html.replace(/^\uFEFF/, '').trimStart();
  while (remaining.startsWith('<!--')) {
    const end = remaining.indexOf('-->');
    if (end < 0) return false;
    remaining = remaining.slice(end + 3).trimStart();
  }
  return /^<(?:!doctype\b|html(?=[\s/>])|head(?=[\s/>])|body(?=[\s/>]))/i.test(remaining);
}

/** Validate the envelope without evaluating or rewriting the authored HTML. */
export function parseOfflineHtmlDocument(source: string): OfflineHtmlDocument {
  if (typeof source !== 'string' || source.length > OFFLINE_HTML_MAX_SOURCE_CHARS)
    reject('source', `expected JSON of at most ${OFFLINE_HTML_MAX_SOURCE_CHARS} characters`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    reject('source', 'expected valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    reject('source', 'expected an object');
  const data = parsed as Record<string, unknown>;
  const fields = ['version', 'libraries', 'html'];
  if (Object.keys(data).some(key => !fields.includes(key)))
    reject('source', 'unexpected field; allowed fields: version, libraries, html');
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) reject(field, 'required');
  }
  if (data.version !== 1) reject('version', 'expected 1');
  if (
    !Array.isArray(data.libraries) ||
    data.libraries.length < 1 ||
    data.libraries.length > OFFLINE_LIBRARY_IDS.length
  )
    reject('libraries', 'expected an array with 1-6 library IDs');
  const libraries: OfflineLibraryId[] = [];
  for (const [index, library] of data.libraries.entries()) {
    if (typeof library !== 'string' || !OFFLINE_LIBRARY_IDS.includes(library as OfflineLibraryId))
      reject(`libraries[${index}]`, `expected one of: ${OFFLINE_LIBRARY_IDS.join(', ')}`);
    if (libraries.includes(library as OfflineLibraryId))
      reject(`libraries[${index}]`, 'library IDs must be unique');
    libraries.push(library as OfflineLibraryId);
  }
  if (typeof data.html !== 'string' || !data.html.trim())
    reject('html', 'expected a non-empty HTML fragment');
  if (startsWithDocumentShell(data.html))
    reject('html', 'expected an HTML fragment without a document shell');
  return { version: 1, libraries, html: data.html };
}
