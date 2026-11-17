export type ParsedMediaSegment =
  { type: 'text'; text: string } | { type: 'media'; url: string; listMarker?: string };

/** Visit explicit media lines outside Markdown fences. Return the kept text. */
export function filterMediaDirectiveLines(
  text: string,
  remove: (source: string) => boolean,
): string {
  let fence = '';
  return text.split(/\r?\n/u).filter(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = '';
      }
      return true;
    }
    if (fence) return true;
    const source = /^ {0,3}(?:(?:-|\d+\.)[\t ]+)?MEDIA[\t ]*:[\t ]*(.+)$/iu.exec(line)?.[1].trim();
    return !source || !remove(source);
  }).join('\n');
}

export function splitMediaFromOutput(text: string): {
  text: string;
  mediaUrls?: string[];
  segments?: ParsedMediaSegment[];
  audioAsVoice?: boolean;
} {
  if (!text) return { text: '' };
  let audioAsVoice = false;

  // Check for audio_as_voice directive
  let cleaned = text;
  if (cleaned.includes('[[audio_as_voice]]')) {
    audioAsVoice = true;
    cleaned = cleaned.replace(/\[\[audio_as_voice\]\]/g, '');
  }

  const segments: ParsedMediaSegment[] = [];
  const mediaUrls: string[] = [];

  // Split on bare MEDIA: lines and Markdown list items such as
  // "- MEDIA:" or "1. MEDIA:".
  const mediaLineRe = /^(?:(-|\d+\.)[\t ]+)?MEDIA\s*:\s*(.+?)\s*$/gim;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mediaLineRe.exec(cleaned)) !== null) {
    const before = cleaned.slice(lastIndex, match.index);
    if (before.trim()) {
      segments.push({ type: 'text', text: before.trim() });
    }
    const listMarker = match[1];
    const url = match[2];
    mediaUrls.push(url);
    segments.push({ type: 'media', url, ...(listMarker ? { listMarker } : {}) });
    lastIndex = match.index + match[0].length;
  }

  const remaining = cleaned.slice(lastIndex);
  if (remaining.trim()) {
    segments.push({ type: 'text', text: remaining.trim() });
  }

  return {
    text: cleaned.trim(),
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    segments: segments.length > 0 ? segments : undefined,
    audioAsVoice: audioAsVoice || undefined,
  };
}
