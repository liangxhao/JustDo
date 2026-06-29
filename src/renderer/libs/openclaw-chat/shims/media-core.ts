/**
 * Simplified shim for @openclaw/media-core/constants.
 * Provides mediaKindFromMime() used by message-normalizer.
 */

export type MediaKind = 'image' | 'audio' | 'video' | 'document';

export function mediaKindFromMime(mime?: string): MediaKind | undefined {
  if (!mime || typeof mime !== 'string') return undefined;
  const lower = mime.toLowerCase();
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('audio/')) return 'audio';
  if (lower.startsWith('video/')) return 'video';
  return 'document';
}
