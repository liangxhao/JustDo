/**
 * Canvas Shortcode Parser for GucciAI
 *
 * Extracts [embed ...] shortcodes and MEDIA: paths from assistant text
 * and converts them to CanvasPreview objects for rendering.
 *
 * This follows the chatweb approach from OpenClaw:
 * - [embed ...] for web-only rich rendering
 * - MEDIA: for attachment delivery (images, audio)
 *
 * Reference: openclaw/docs/reference/rich-output-protocol.md
 */

export type CanvasPreview = {
  url: string;
  title?: string;
  height?: number;
  isImage?: boolean;
};

/**
 * Parse [embed ...] shortcode attributes
 */
function parseEmbedAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const key = match[1]?.trim().toLowerCase();
    const value = (match[2] ?? match[3] ?? '').trim();
    if (key && value) {
      attrs[key] = value;
    }
  }
  return attrs;
}

/**
 * Default canvas entry URL from ref
 */
function defaultCanvasEntryUrl(ref: string, gatewayPort: number): string {
  const encoded = encodeURIComponent(ref.trim());
  return `http://127.0.0.1:${gatewayPort}/__openclaw__/canvas/documents/${encoded}/index.html`;
}

/**
 * Parse fenced code block spans to avoid parsing shortcodes inside code blocks
 */
function parseFenceSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const fenceRe = /^(`{3,}|~{3,})\s*$/gm;
  let inFence = false;
  let fenceStart = 0;
  let fenceLen = 0;

  const lines = text.split('\n');
  let pos = 0;

  for (const line of lines) {
    const lineStart = pos;
    const match = line.match(fenceRe);

    if (match && match[1]) {
      if (!inFence) {
        inFence = true;
        fenceStart = lineStart;
        fenceLen = match[1].length;
      } else if (match[1].length >= fenceLen) {
        spans.push({ start: fenceStart, end: pos + line.length });
        inFence = false;
      }
    }

    pos += line.length + 1; // +1 for newline
  }

  return spans;
}

/**
 * Check if a position is inside a fenced code block
 */
function isInFence(pos: number, fenceSpans: Array<{ start: number; end: number }>): boolean {
  return fenceSpans.some(span => pos >= span.start && pos < span.end);
}

/**
 * Resolve URL to absolute URL with gateway host
 * Handles both relative URLs (/__openclaw__/...) and absolute URLs
 */
function resolveCanvasUrl(rawUrl: string, gatewayPort: number): string {
  const trimmed = rawUrl.trim();
  // If already absolute URL, return as-is
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('localfile://')
  ) {
    return trimmed;
  }
  // Relative URL: prepend gateway host
  if (trimmed.startsWith('/')) {
    return `http://127.0.0.1:${gatewayPort}${trimmed}`;
  }
  // Unknown format, return as-is
  return trimmed;
}

/**
 * Resolve MEDIA: path to a renderable URL
 * Handles local file paths and converts them to localfile:// URLs
 * which are handled by Electron's custom protocol handler
 */
function resolveMediaPath(rawPath: string): string | null {
  // Strip MEDIA: prefix (lenient whitespace)
  const path = rawPath.replace(/^\s*MEDIA\s*:\s*/i, '').trim();
  if (!path) return null;

  // HTTP/HTTPS URLs: return as-is
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  // file:// URLs: convert to localfile:/// for Electron protocol handler
  // Three slashes needed so URL pathname includes the drive letter (e.g., /C:/Users/...)
  if (path.startsWith('file://')) {
    return path.replace(/^file:\/\//, 'localfile:///');
  }

  // Absolute local path (Windows or Unix): convert to localfile:/// URL
  // Electron handles localfile:// via custom protocol
  // Three slashes needed: localfile:///C:/Users/... gives pathname /C:/Users/...
  if (path.match(/^[A-Za-z]:[\/\\]/) || path.startsWith('/')) {
    // Normalize path separators for URL
    const normalizedPath = path.replace(/\\/g, '/');
    return `localfile:///${normalizedPath}`;
  }

  // Unknown format, return null
  return null;
}

/**
 * Check if a file path looks like an image
 */
function isImagePath(path: string): boolean {
  const ext = path.toLowerCase().split(/[?#]/)[0].split('.').pop() ?? '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext);
}

/**
 * Extract [embed ...] shortcodes and MEDIA: paths from text
 * Returns stripped text + previews
 *
 * Supports:
 * - Self-closing embed: [embed url="..." title="..." height="320" /]
 * - Block embed: [embed url="..."]content[/embed]
 * - MEDIA: paths for attachment delivery
 */
export function extractCanvasShortcodes(
  text: string,
  gatewayPort: number,
): { text: string; previews: CanvasPreview[] } {
  if (!text?.trim()) {
    return { text: text ?? '', previews: [] };
  }

  const fenceSpans = parseFenceSpans(text);
  const matches: Array<{ start: number; end: number; preview: CanvasPreview }> = [];

  // Extract MEDIA: lines first (they appear on their own lines per spec)
  const lines = text.split('\n');
  let linePos = 0;
  for (const line of lines) {
    const lineStart = linePos;
    const trimmedLine = line.trim();
    // Match MEDIA: prefix (lenient whitespace)
    const mediaMatch = trimmedLine.match(/^MEDIA\s*:\s*(.+)$/i);
    if (mediaMatch && !isInFence(lineStart, fenceSpans)) {
      const rawPath = mediaMatch[1]?.trim();
      if (rawPath) {
        const resolvedUrl = resolveMediaPath(rawPath);
        if (resolvedUrl) {
          matches.push({
            start: lineStart,
            end: lineStart + line.length + 1, // +1 for newline
            preview: {
              url: resolvedUrl,
              isImage: isImagePath(rawPath),
            },
          });
        }
      }
    }
    linePos += line.length + 1;
  }

  // Self-closing pattern: [embed url="..." /]
  const selfClosingRe = /\[embed\s+([^\]]*?)\/\]/gi;

  // Block pattern: [embed ...]...[/embed]
  const blockRe = /\[embed\s+([^\]]*?)\]([\s\S]*?)\[\/embed\]/gi;

  for (const re of [blockRe, selfClosingRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const start = match.index ?? 0;
      if (isInFence(start, fenceSpans)) {
        continue;
      }
      const attrs = parseEmbedAttributes(match[1] ?? '');
      const url = attrs.url?.trim();
      const ref = attrs.ref?.trim();
      const title = attrs.title?.trim();
      const height = attrs.height ? parseInt(attrs.height, 10) : undefined;

      if (url || ref) {
        const rawUrl = url || defaultCanvasEntryUrl(ref!, gatewayPort);
        const finalUrl = resolveCanvasUrl(rawUrl, gatewayPort);
        if (finalUrl) {
          matches.push({
            start,
            end: start + match[0].length,
            preview: {
              url: finalUrl,
              ...(title ? { title } : {}),
              ...(height && Number.isFinite(height) && height >= 160
                ? { height: Math.min(height, 1200) }
                : {}),
            },
          });
        }
      }
    }
  }

  if (matches.length === 0) {
    return { text, previews: [] };
  }

  // Sort by start position
  matches.sort((a, b) => a.start - b.start);

  const previews: CanvasPreview[] = [];
  let cursor = 0;
  let stripped = '';

  for (const match of matches) {
    if (match.start < cursor) {
      continue; // Skip overlapping matches
    }

    // Add text before this match
    stripped += text.slice(cursor, match.start);

    // Add the preview
    previews.push(match.preview);

    cursor = match.end;
  }

  // Add remaining text
  stripped += text.slice(cursor);

  // Clean up excessive newlines
  return {
    text: stripped.replace(/\n{3,}/g, '\n\n').trim(),
    previews,
  };
}
