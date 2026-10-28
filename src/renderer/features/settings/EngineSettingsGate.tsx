import { type ReactNode, useEffect, useState } from 'react';

import EngineInteractionBoundary from '@/app/shell/startup/routing/EngineInteractionBoundary';
import { useEngineReadiness } from '@/app/shell/startup/routing/useEngineReadiness';
import { i18nService } from '@/services/i18n';

/** Delay native settings reads once; later restarts preserve the mounted form. */
export default function EngineSettingsGate({ children }: { children: ReactNode }) {
  const engine = useEngineReadiness();
  const [mounted, setMounted] = useState(engine.ready);
  useEffect(() => {
    if (engine.ready) setMounted(true);
  }, [engine.ready]);

  return (
    <div className="space-y-4">
      {!engine.ready && (
        <p role="status" className="rounded-xl bg-surface px-4 py-5 text-sm text-secondary">
          {i18nService.t(engine.failed ? 'engineUnavailableContent' : 'enginePreparingContent')}
        </p>
      )}
      {(engine.ready || mounted) && (
        <EngineInteractionBoundary disabled={!engine.ready}>{children}</EngineInteractionBoundary>
      )}
    </div>
  );
}
