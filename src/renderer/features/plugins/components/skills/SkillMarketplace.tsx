import { SparklesIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '@/services/i18n';

const SkillMarketplace: React.FC = () => (
  <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface px-6 text-center">
    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-background">
      <SparklesIcon className="h-6 w-6 text-secondary" />
    </div>
    <h2 className="mt-4 text-base font-semibold text-foreground">
      {i18nService.t('commonComingSoon')}
    </h2>
  </div>
);

export default SkillMarketplace;
