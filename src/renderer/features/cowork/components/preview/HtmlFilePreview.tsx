import { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

import NativeFilePreview from './NativeFilePreview';

export default function HtmlFilePreview({
  filePath,
  isVisible,
}: {
  filePath: string;
  isVisible: boolean;
}) {
  const [document, setDocument] = useState<{ filePath: string; url: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setFailed(false);
    void window.electron.browser
      .createLocalHtmlPreview(filePath)
      .then(result => {
        if (cancelled) return;
        if (!result.success) {
          setFailed(true);
          return;
        }
        setDocument({ filePath: result.filePath, url: result.url });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const loading = <div className="p-4 text-sm text-secondary">{i18nService.t('loading')}</div>;
  return (
    <div
      className="relative h-full min-h-0 flex-1"
      aria-label={i18nService.t('coworkFilePreviewModePreview')}
    >
      {failed ? (
        <div role="alert" className="p-4 text-sm text-secondary">
          {i18nService.t('coworkFilePreviewFailed')}
        </div>
      ) : document ? (
        <NativeFilePreview
          key={document.url}
          filePath={document.filePath}
          url={document.url}
          isVisible={isVisible}
          navigationBarVisible
        />
      ) : (
        loading
      )}
    </div>
  );
}
