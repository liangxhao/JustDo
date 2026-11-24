function parseUrl(value: string): URL | undefined {
  try { return new URL(value); } catch { return undefined; }
}

export function unwrapAssistantDeliverableSource(source: string): string {
  if (/^(?:"[^"]+"|'[^']+'|<[^<>]+>)$/u.test(source)) return source.slice(1, -1);
  return source;
}

export function isLocalAssistantDeliverableSource(raw: string): boolean {
  const source = unwrapAssistantDeliverableSource(raw);
  if (!source || /^[\\/]{2}/u.test(source) || /[\x00-\x1f\x7f]/u.test(source) ||
    source.startsWith('/api/chat/media/')) return false;
  if (/^(?:file|localfile):/iu.test(source)) {
    const url = parseUrl(source);
    return !!url && (!url.hostname || url.hostname === 'localhost');
  }
  return /^[a-z]:[\\/]/iu.test(source) || !/^[a-z][\w+.-]*:/iu.test(source);
}
