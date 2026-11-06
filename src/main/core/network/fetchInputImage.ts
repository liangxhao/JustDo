import { isIP } from 'node:net';

import { mainProcessFetch } from './mainProcessFetch';

/** Explicit intranet literals avoid ambiguous DNS/proxy resolution and send no app credentials. */
export async function fetchInputImage(
  value: string,
  options: { signal?: AbortSignal; maxBytes: number },
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const parts = host.split('.').map(Number);
  const privateV4 = isIP(host) === 4 && (parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168));
  const privateV6 = isIP(host) === 6 && /^(?:fc|fd)[0-9a-f]{2}:/.test(host);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (!privateV4 && !privateV6))
    throw new Error('Only explicit private-network image URLs are supported.');
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]);
  const response = await mainProcessFetch(url.href, {
    method: 'GET', credentials: 'omit', redirect: 'error', signal,
    headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' },
  }, { maxResponseBytes: options.maxBytes });
  if (!response.ok || response.redirected) {
    await response.body?.cancel();
    throw new Error('Image retrieval failed.');
  }
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) {
    await response.body?.cancel();
    throw new Error('Image response has an unsupported content type.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Image response has no body.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > options.maxBytes) throw new Error('Image response exceeds the size limit.');
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), mimeType };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
