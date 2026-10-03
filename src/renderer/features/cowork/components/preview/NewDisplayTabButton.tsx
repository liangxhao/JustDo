import { PlusIcon } from '@heroicons/react/24/outline';

import { i18nService } from '@/services/i18n';

interface NewDisplayTabButtonProps {
  disabled?: boolean;
  onCreateTab: () => void;
}

const NewDisplayTabButton = ({ disabled = false, onCreateTab }: NewDisplayTabButtonProps) => (
  <button
    type="button"
    className="inline-flex h-7 w-8 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    disabled={disabled}
    onClick={onCreateTab}
    aria-label={i18nService.t('coworkNewDisplayTab')}
    title={i18nService.t('coworkNewDisplayTab')}
  >
    <PlusIcon className="h-4 w-4" />
  </button>
);

export default NewDisplayTabButton;
