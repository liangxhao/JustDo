import { PRODUCT_NAME } from '@shared/productMetadata';
import { type ReactNode, useLayoutEffect, useRef } from 'react';

import { i18nService } from '@/services/i18n';

import appLogoUrl from '../../../../../resources/logo.png';
import { prepareStartupEntry, StartupEntryPhase } from './startupMotion';

export function startupDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export default function StartupFrame({
  children,
  failed = false,
}: {
  children: ReactNode;
  failed?: boolean;
}) {
  const frame = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (frame.current) return prepareStartupEntry(frame.current, failed);
  }, [failed]);
  return (
    <main ref={frame} className="startup-main startup-main--launch" data-entry={StartupEntryPhase.Seed}>
      <div className="startup-content">
        <div className="startup-brand">
          <div className="startup-emblem" aria-hidden="true">
            <img src={appLogoUrl} alt="" width={58} height={58} draggable={false} />
          </div>
          <div className="startup-brand-copy">
            <p className="startup-brand-name">{PRODUCT_NAME}</p>
            <h1 className="startup-title">
              {i18nService.t(failed ? 'startupFailed' : 'startupHeading')}
            </h1>
          </div>
        </div>
        <div className="startup-details">{children}</div>
      </div>
    </main>
  );
}
