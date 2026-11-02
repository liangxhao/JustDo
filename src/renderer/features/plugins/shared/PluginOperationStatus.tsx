import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { type Ref, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';

import { getPluginOperationOwner } from './pluginOperationService';
import { pluginOperationStatusContainerClassName } from './PluginOperationStatusSlot';

const PluginOperationStatus = ({ feedbackSlotRef }: { feedbackSlotRef?: Ref<HTMLDivElement> }) => {
  const owner = getPluginOperationOwner();
  const operations = useSyncExternalStore(owner.subscribe, owner.snapshot);
  const [now, setNow] = useState(Date.now);
  const active = operations.length > 0;
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  return createPortal(
    <div className={pluginOperationStatusContainerClassName}>
      {active && (
        <div className="space-y-2" role="status" aria-live="polite" aria-atomic="false">
          {operations.map(operation => (
            <div
              key={operation.requestId}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-lg animate-fade-in-up"
            >
              <ArrowPathIcon className="h-4 w-4 shrink-0 animate-spin text-primary" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {operation.label}
                  <span className="ml-2 text-xs font-normal text-secondary">
                    {i18nService.t(`pluginOperationAction.${operation.action}`)}
                  </span>
                </div>
                <p key={operation.stage} className="mt-0.5 text-xs text-secondary animate-fade-in">
                  {i18nService.t(`pluginOperationStage.${operation.stage}`)}
                </p>
              </div>
              <span className="shrink-0 text-xs tabular-nums text-secondary" aria-live="off">
                {i18nService
                  .t('pluginOperationElapsed')
                  .replace(
                    '{seconds}',
                    String(Math.max(0, Math.floor((now - operation.startedAt) / 1000))),
                  )}
              </span>
            </div>
          ))}
        </div>
      )}
      <div ref={feedbackSlotRef} className="pointer-events-auto space-y-2" />
    </div>,
    document.body,
  );
};

export default PluginOperationStatus;
