import type { EmbedShortcodeSegment } from './embed-shortcodes';

/** Untrusted presentation input; this type grants no document or network authority. */
export type WebpageEmbedPreview = {
  kind: 'canvas';
  surface: 'assistant_message';
  render: 'url';
  url?: string;
  ref?: string;
  viewId?: string;
  title?: string;
  preferredHeight?: number;
  fallbackText?: string;
  /** Preserve protocol identity so an MCP App can never become an ordinary web page. */
  mcpApp?: unknown;
};

export type EmbedPresentation =
  | { kind: 'webpage'; url: string }
  | { kind: 'hosted'; documentId: string; path: string }
  | { kind: 'unavailable'; reason: 'invalid-target' | 'unsupported-source' | 'mcp-app' };

const DOCUMENT_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,256}$/;
const DOCUMENT_ROOT = '/__openclaw__/canvas/documents/';

export function normalizeEmbedHeight(value: unknown): number | undefined {
  const height = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof height === 'number' && Number.isFinite(height)
    ? Math.min(1200, Math.max(160, Math.trunc(height)))
    : undefined;
}

export function previewFromEmbedShortcode(
  segment: Extract<EmbedShortcodeSegment, { type: 'embed' }>,
): WebpageEmbedPreview {
  const attributes = segment.attributes;
  const ref = attributes.ref ?? attributes.viewid;
  return {
    kind: 'canvas',
    surface: 'assistant_message',
    render: 'url',
    ...(attributes.url !== undefined
      ? { url: attributes.url }
      : ref && DOCUMENT_ID.test(ref)
        ? { url: `${DOCUMENT_ROOT}${ref}/index.html` }
        : {}),
    ...(ref !== undefined ? { ref, viewId: ref } : {}),
    ...(attributes.title ? { title: attributes.title.slice(0, 200) } : {}),
    ...(normalizeEmbedHeight(attributes.height) !== undefined
      ? { preferredHeight: normalizeEmbedHeight(attributes.height) }
      : {}),
    ...(segment.fallbackText !== undefined ? { fallbackText: segment.fallbackText } : {}),
  };
}

/** Classify all URL Canvas sources before the independent guest asks Main for admission. */
export function classifyEmbedPresentation(preview: WebpageEmbedPreview): EmbedPresentation {
  if (preview.mcpApp !== undefined) return { kind: 'unavailable', reason: 'mcp-app' };
  const ref = preview.ref ?? preview.viewId;
  const source =
    preview.url !== undefined
      ? preview.url
      : ref && DOCUMENT_ID.test(ref)
        ? `${DOCUMENT_ROOT}${ref}/index.html`
        : undefined;
  if (!source || source !== source.trim() || /[\u0000-\u0020\u007f\\]/.test(source))
    return { kind: 'unavailable', reason: 'invalid-target' };
  if (source.startsWith(DOCUMENT_ROOT)) {
    // Percent escapes could change route boundaries after native decoding. Fixed
    // hosted document identities/routes require no escaping in model input.
    if (source.includes('%') || source.includes('?') || source.includes('#'))
      return { kind: 'unavailable', reason: 'invalid-target' };
    const rest = source.slice(DOCUMENT_ROOT.length);
    const slash = rest.indexOf('/');
    const documentId = rest.slice(0, slash);
    const path = rest.slice(slash + 1);
    if (
      slash < 0 ||
      !DOCUMENT_ID.test(documentId) ||
      !path ||
      path.split('/').some(part => !part || part === '.' || part === '..')
    )
      return { kind: 'unavailable', reason: 'invalid-target' };
    return { kind: 'hosted', documentId, path };
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return { kind: 'unavailable', reason: 'invalid-target' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { kind: 'unavailable', reason: 'unsupported-source' };
  if (url.username || url.password) return { kind: 'unavailable', reason: 'invalid-target' };
  // Main owns the current Gateway origin and makes the final origin/path decision.
  return { kind: 'webpage', url: source };
}
