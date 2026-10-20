export const IMAGE_PREVIEW_EVENT = 'cowork:preview-image';

export interface ImageFilePreview {
  kind: 'image';
  filePath: string;
  src: string;
  label: string;
}

export const isImageFilePath = (filePath: string): boolean =>
  /\.(?:png|apng|jpe?g|jpe|jfif|pjpeg|pjp|gif|webp|svg|bmp|ico|avif)$/i.test(filePath);

export function createImageFilePreview(
  source: string,
  label: string,
  workingDirectory?: string,
): ImageFilePreview | null {
  let src = source.trim();
  if (!src) return null;
  if (!/^(?:https?|data|blob|localfile):/i.test(src)) {
    const absolute = /^[A-Za-z]:[\\/]/.test(src) || /^[\\/]/.test(src);
    if (!absolute && !workingDirectory) return null;
    const path = (absolute ? src : `${workingDirectory}/${src}`).replace(/\\/g, '/');
    src = `localfile://${path.startsWith('//') ? '' : '/'}${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')
      .replace(/^\/+/, '')}`;
  }
  try {
    const url = new URL(src);
    if (url.protocol === 'data:' && !/^data:image\/[a-z0-9.+-]+[;,]/i.test(src)) return null;
    if (!['http:', 'https:', 'data:', 'blob:', 'localfile:'].includes(url.protocol)) return null;
    const localPath =
      url.protocol === 'localfile:'
        ? decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, '$1')
        : null;
    const filePath =
      localPath === null
        ? url.protocol === 'data:' || url.protocol === 'blob:'
          ? `image:${crypto.randomUUID()}`
          : url.href
        : `${url.host ? `//${url.host}` : ''}${localPath}`;
    return {
      kind: 'image',
      filePath,
      src: url.href,
      label: (
        localPath?.split('/').pop() ||
        label ||
        (url.protocol === 'http:' || url.protocol === 'https:'
          ? decodeURIComponent(url.pathname.split('/').pop() || '')
          : '')
      ).slice(0, 512),
    };
  } catch {
    return null;
  }
}
