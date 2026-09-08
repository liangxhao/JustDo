import { ArrowPathIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

interface QueryingIndicatorProps {
  size?: 'sm' | 'md';
}

const QUERY_STAGE_KEYS = [
  'sessionDetailsQueryStageSession',
  'sessionDetailsQueryStageRequests',
  'sessionDetailsQueryStageTokens',
] as const;

const QUERY_STAGE_DELAYS_MS = [1_400, 1_800] as const;

const QueryingIndicator: React.FC<QueryingIndicatorProps> = ({ size = 'sm' }) => {
  const label = i18nService.t('sessionDetailsLoading');
  const [stageIndex, setStageIndex] = useState(0);
  const stageLabel = i18nService.t(QUERY_STAGE_KEYS[stageIndex]);

  useEffect(() => {
    if (stageIndex >= QUERY_STAGE_KEYS.length - 1) return;
    const timer = window.setTimeout(
      () => setStageIndex(current => current + 1),
      QUERY_STAGE_DELAYS_MS[stageIndex],
    );
    return () => window.clearTimeout(timer);
  }, [stageIndex]);

  return (
    <span
      className="inline-flex flex-col items-center justify-center text-secondary"
      role="status"
      aria-label={`${label}... ${stageLabel}`}
      aria-live="polite"
    >
      <span
        className={`inline-flex items-center font-semibold ${
          size === 'md' ? 'text-xl' : 'text-base'
        }`}
        aria-hidden="true"
      >
        <ArrowPathIcon
          className={`${
            size === 'md' ? 'mr-2.5 h-6 w-6' : 'mr-1.5 h-5 w-5'
          } querying-spinner shrink-0 text-primary`}
        />
        <span className="querying-indicator-text tracking-wider">{label}</span>
        <span className="ml-0.5 inline-flex">
          {[0, 1, 2].map(index => (
            <span
              key={index}
              className="querying-indicator-dot"
              style={{ animationDelay: `${index * 160}ms` }}
            >
              .
            </span>
          ))}
        </span>
      </span>
      <span
        key={stageIndex}
        className={`querying-indicator-stage ${
          size === 'md' ? 'mt-2 text-xs' : 'mt-1 text-[10px]'
        }`}
        aria-hidden="true"
      >
        {stageLabel}
      </span>
    </span>
  );
};

export default QueryingIndicator;
