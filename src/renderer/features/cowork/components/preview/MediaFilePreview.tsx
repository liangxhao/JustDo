import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

export const localMediaPreviewUrl = (fileUrl: string): string | null => {
  try {
    const url = new URL(fileUrl);
    if (url.protocol !== 'file:') return null;
    return `localmedia://local${url.hostname ? `//${url.hostname}` : ''}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
};

export default function MediaFilePreview({
  url,
  kind,
  isVisible,
}: {
  url: string;
  kind: 'audio' | 'video';
  isVisible: boolean;
}) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const source = localMediaPreviewUrl(url);
  useEffect(() => {
    if (!isVisible) mediaRef.current?.pause();
  }, [isVisible, retry, failed]);
  useEffect(() => {
    const media = mediaRef.current;
    return () => {
      // StrictMode and workspace moves can retain the same connected media node.
      queueMicrotask(() => {
        if (!media || media.isConnected) return;
        media.pause();
        media.removeAttribute('src');
        media.load();
      });
    };
  }, [url, failed, retry]);
  const mediaProps = {
    ref: (element: HTMLMediaElement | null) => {
      mediaRef.current = element;
    },
    src: source ?? undefined,
    controls: true,
    preload: 'metadata' as const,
    onError: () => setFailed(true),
    className: 'max-h-full w-full max-w-3xl',
    'aria-label': i18nService.t(
      kind === 'audio' ? 'coworkFilePreviewAudio' : 'coworkFilePreviewVideo',
    ),
  };
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-neutral-950 p-4">
      {failed || !source ? (
        <div role="alert" className="max-w-sm text-center text-sm text-neutral-300">
          <p>{i18nService.t('coworkFilePreviewMediaFailed')}</p>
          {source && (
            <button
              type="button"
              className="mt-3 rounded bg-neutral-800 px-3 py-2 hover:bg-neutral-700"
              onClick={() => {
                setRetry(value => value + 1);
                setFailed(false);
              }}
            >
              {i18nService.t('messageMediaRetry')}
            </button>
          )}
        </div>
      ) : kind === 'video' ? (
        <video key={retry} {...mediaProps} playsInline />
      ) : (
        <audio key={retry} {...mediaProps} />
      )}
    </div>
  );
}
