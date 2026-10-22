import { PlusIcon } from '@heroicons/react/24/outline';
import { type Ref, useEffect, useState } from 'react';

import { defaultConfig } from '@/app/config';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

interface NewDisplayTabButtonProps {
  disabled?: boolean;
  onCreateTab: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  boxedIcon?: boolean;
  detached?: boolean;
}

const NewDisplayTabButton = ({
  disabled = false,
  onCreateTab,
  buttonRef,
  boxedIcon = false,
  detached = false,
}: NewDisplayTabButtonProps) => {
  const [shortcut, setShortcut] = useState(
    () => configService.getConfig().shortcuts?.browser ?? defaultConfig.shortcuts!.browser,
  );
  useEffect(() => {
    const update = () =>
      setShortcut(configService.getConfig().shortcuts?.browser ?? defaultConfig.shortcuts!.browser);
    window.addEventListener('config-updated', update);
    return () => window.removeEventListener('config-updated', update);
  }, []);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="inline-flex h-7 w-8 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      disabled={disabled}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        onCreateTab();
      }}
      aria-label={i18nService.t(detached ? 'coworkDisplayWindowFocus' : 'coworkNewDisplayTab')}
      title={
        detached
          ? i18nService.t('coworkDisplayWindowFocus')
          : shortcut
            ? `${i18nService.t('coworkNewDisplayTab')} (${shortcut})`
            : i18nService.t('coworkNewDisplayTab')
      }
    >
      {boxedIcon ? (
        <svg
          className="h-4 w-4"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="2.5" width="12" height="11" rx="2" />
          <path d="M8 5.5v5M5.5 8h5" />
        </svg>
      ) : (
        <PlusIcon className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
};

export default NewDisplayTabButton;
