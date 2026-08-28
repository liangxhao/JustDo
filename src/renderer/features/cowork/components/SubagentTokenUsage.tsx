import type { SessionDetailStats } from '@shared/cowork/sessionDetails';
import React from 'react';

import { i18nService } from '@/services/i18n';

import QueryingIndicator from './QueryingIndicator';

interface SubagentTokenUsageProps {
  stats?: SessionDetailStats;
  isLoading: boolean;
}

const SubagentTokenUsage: React.FC<SubagentTokenUsageProps> = ({ stats, isLoading }) => {
  if (isLoading)
    return (
      <span className="inline-flex justify-end">
        <QueryingIndicator />
      </span>
    );
  if (!stats) return <>{i18nService.t('subagentInfoUnavailable')}</>;
  if (!stats.hasTokenUsage) return <>{i18nService.t('sessionDetailsNoTokenUsage')}</>;

  return (
    <div>
      <p className="mb-1.5 whitespace-nowrap text-right text-[10px] leading-4 text-secondary">
        {i18nService.t('sessionDetailsTokenUsageScopeNote')}
      </p>
      <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-xs">
        <div className="col-span-2 flex items-center justify-between gap-2 border-b border-border pb-1.5">
          <span className="font-medium text-secondary">
            {i18nService.t('sessionDetailsTotalTokens')}
          </span>
          <span className="font-semibold tabular-nums text-foreground">
            {stats.totalTokens.toLocaleString()}
          </span>
        </div>
        {[
          [i18nService.t('sessionDetailsInputTokens'), stats.tokenUsage.input],
          [i18nService.t('sessionDetailsOutputTokens'), stats.tokenUsage.output],
          [i18nService.t('sessionDetailsCacheRead'), stats.tokenUsage.cacheRead],
          [i18nService.t('sessionDetailsCacheWrite'), stats.tokenUsage.cacheWrite],
        ].map(([label, value]) => (
          <div key={String(label)} className="flex items-center justify-between gap-2">
            <span className="text-secondary">{label}</span>
            <span className="font-medium tabular-nums text-foreground">
              {Number(value).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default SubagentTokenUsage;
