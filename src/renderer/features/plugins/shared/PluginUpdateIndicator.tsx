import { ArrowUpCircleIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '@/services/i18n';
import Tooltip from '@/shared/components/ui/Tooltip';

const PluginUpdateIndicator: React.FC = () => {
  const label = i18nService.t('marketplaceUpdateAvailable');

  return (
    <Tooltip content={label} position="bottom" className="flex h-6 w-6 shrink-0">
      <span
        role="img"
        aria-label={label}
        className="flex h-6 w-6 items-center justify-center text-amber-600 dark:text-amber-400"
      >
        <ArrowUpCircleIcon className="h-4 w-4" />
      </span>
    </Tooltip>
  );
};

export default PluginUpdateIndicator;
