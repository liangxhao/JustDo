import { PRODUCT_NAME } from '@shared/productMetadata';

import { i18nService } from '@/services/i18n';

import appLogoUrl from '../../../../../resources/logo.png';

export default function StartupLoading() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background px-6 py-12">
      <div
        className="flex w-full max-w-sm flex-col items-center text-center"
        role="status"
        aria-live="polite"
      >
        <img
          src={appLogoUrl}
          alt=""
          width={88}
          height={88}
          draggable={false}
          className="mb-6 h-[88px] w-[88px] shrink-0 select-none object-contain"
        />
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{PRODUCT_NAME}</h1>
        <p className="mt-3 text-base font-medium tracking-wide text-secondary">
          {i18nService.t('startupTitle')}
        </p>
        <div className="mt-8 flex w-full max-w-[260px] flex-col items-center border-t border-border-subtle pt-6">
          <div className="flex items-center gap-2.5 text-sm text-secondary">
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-border border-t-primary motion-safe:animate-spin"
            />
            <span>{i18nService.t('startupPreparing')}</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted">{i18nService.t('startupDescription')}</p>
        </div>
      </div>
    </div>
  );
}
