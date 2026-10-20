import type { BrowserPanelTab } from '@shared/browser/browser';
import { lazy, Suspense, useEffect, useState } from 'react';

import { removeRetainedBrowserPanelTabs } from '@/features/browser/browserPanelRetention';
import { i18nService } from '@/services/i18n';

const BrowserPanel = lazy(() => import('@/features/browser/BrowserPanel'));
const ignore = () => undefined;

export default function NativeFilePreview({
  filePath,
  url,
  isVisible,
  navigationBarVisible = false,
}: {
  filePath: string;
  url: string;
  isVisible: boolean;
  navigationBarVisible?: boolean;
}) {
  const [draftKey] = useState(() => `file-preview-${crypto.randomUUID()}`);
  const [initialTabs] = useState<BrowserPanelTab[]>(() => {
    const targetId = `file-preview-${crypto.randomUUID()}`;
    return [
      { id: targetId, targetId, title: '', url, sourceFilePath: filePath, sourcePreviewUrl: url },
    ];
  });
  const [activeTargetId, setActiveTargetId] = useState<string | null>(initialTabs[0].targetId);
  useEffect(() => () => removeRetainedBrowserPanelTabs(draftKey), [draftKey]);
  return (
    <div
      className="relative h-full min-h-0 flex-1"
      aria-label={i18nService.t('coworkFilePreviewModePreview')}
    >
      <Suspense
        fallback={<div className="p-4 text-sm text-secondary">{i18nService.t('loading')}</div>}
      >
        <BrowserPanel
          draftKey={draftKey}
          initialTabs={initialTabs}
          activeTargetId={activeTargetId}
          onActiveTargetChange={setActiveTargetId}
          isOpen={isVisible}
          embedded
          pageToolsVisible={false}
          navigationBarVisible={navigationBarVisible}
          width={0}
          onWidthChange={ignore}
          onClose={ignore}
          onAddAnnotation={() => false}
        />
      </Suspense>
    </div>
  );
}
