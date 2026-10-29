import React from 'react';

import { i18nService } from '@/services/i18n';

export interface SessionListPageFooterProps {
  isLoading?: boolean;
  loadFailed?: boolean;
  hasMore?: boolean;
  onShowMore?: () => void;
  onRetry?: () => void;
}

const SessionListPageFooter: React.FC<SessionListPageFooterProps> = ({
  isLoading,
  loadFailed,
  hasMore,
  onShowMore,
  onRetry,
}) => (
  <>
    {isLoading && (
      <p role="status" className="px-3 py-2 text-xs text-secondary">
        {i18nService.t('startupSessionsLoading')}
      </p>
    )}
    {loadFailed && (
      <div className="px-3 py-2 text-xs text-secondary">
        <span>{i18nService.t('sessionListPageLoadFailed')}</span>{' '}
        <button type="button" onClick={onRetry} className="text-primary hover:underline">
          {i18nService.t('sessionListRetry')}
        </button>
      </div>
    )}
    {hasMore && !isLoading && !loadFailed && (
      <button
        type="button"
        onClick={onShowMore}
        className="w-full pl-7 pr-3 py-2 text-left text-xs text-primary hover:underline"
      >
        {i18nService.t('sessionListShowMore')}
      </button>
    )}
  </>
);

export default SessionListPageFooter;
