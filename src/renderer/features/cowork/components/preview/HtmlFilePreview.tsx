import type { BrowserPanelTab } from '@shared/browser/browser';
import { lazy, Suspense, useEffect, useState } from 'react';

import { removeRetainedBrowserPanelTabs } from '@/features/browser/browserPanelRetention';
import { i18nService } from '@/services/i18n';

const BrowserPanel = lazy(() => import('@/features/browser/BrowserPanel'));
const ignore = () => undefined;

export default function HtmlFilePreview({
  filePath,
  isVisible,
}: {
  filePath: string;
  isVisible: boolean;
}) {
  const [draftKey] = useState(() => `file-preview-${crypto.randomUUID()}`);
  const [tabs, setTabs] = useState<BrowserPanelTab[] | null>(null);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTabs(null);
    setFailed(false);
    void window.electron.browser
      .createLocalHtmlPreview(filePath)
      .then(result => {
        if (cancelled) return;
        if (!result.success) {
          setFailed(true);
          return;
        }
        const targetId = `file-preview-${crypto.randomUUID()}`;
        setActiveTargetId(targetId);
        setTabs([
          {
            id: targetId,
            targetId,
            title: '',
            url: result.url,
            sourceFilePath: result.filePath,
            sourcePreviewUrl: result.url,
            sourceRootPath: result.rootPath,
            sourcePreviewRootUrl: result.previewRootUrl,
          },
        ]);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      removeRetainedBrowserPanelTabs(draftKey);
    };
  }, [draftKey, filePath]);

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
      ) : tabs ? (
        <Suspense fallback={loading}>
          <BrowserPanel
            draftKey={draftKey}
            initialTabs={tabs}
            activeTargetId={activeTargetId}
            onActiveTargetChange={setActiveTargetId}
            isOpen={isVisible}
            embedded
            pageToolsVisible={false}
            width={0}
            onWidthChange={ignore}
            onClose={ignore}
            onAddAnnotation={() => false}
          />
        </Suspense>
      ) : (
        loading
      )}
    </div>
  );
}
