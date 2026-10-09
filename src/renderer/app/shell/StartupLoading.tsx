import { PRODUCT_NAME } from '@shared/productMetadata';

import { i18nService } from '@/services/i18n';

import appLogoUrl from '../../../../resources/logo.png';

export default function StartupLoading() {
  return (
    <div className="cowork-home flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-12">
      <div
        className="flex w-full max-w-sm flex-col items-center text-center motion-safe:animate-fade-in-up"
        role="status"
        aria-live="polite"
      >
        <div className="relative mb-7 shrink-0">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-8 rounded-full bg-primary-muted opacity-60 blur-2xl"
          />
          <div className="relative flex h-28 w-28 items-center justify-center rounded-[28px] border border-border-subtle bg-surface shadow-glow-accent">
            <img
              src={appLogoUrl}
              alt=""
              width={76}
              height={76}
              draggable={false}
              className="h-[76px] w-[76px] select-none object-contain"
            />
          </div>
        </div>
        <h1 className="text-[32px] font-semibold leading-tight tracking-tight text-foreground">
          {PRODUCT_NAME}
        </h1>
        <p className="mt-2.5 text-sm tracking-wide text-secondary">
          {i18nService.t('startupTitle')}
        </p>
        <div className="mt-9 flex w-full flex-col items-center">
          <div className="inline-flex max-w-full items-center gap-2.5 rounded-full border border-border-subtle bg-surface px-4 py-2.5 text-[13px] text-secondary shadow-subtle">
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-border border-t-primary motion-safe:animate-spin"
            />
            <span>{i18nService.t('startupPreparing')}</span>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted">{i18nService.t('startupDescription')}</p>
        </div>
      </div>
    </div>
  );
}
