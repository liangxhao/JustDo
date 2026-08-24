import React from 'react';

import Tooltip from '@/shared/components/ui/Tooltip';

interface ContextUsageIndicatorProps {
  label: string;
  detail: string;
  percentage: number;
}

const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = ({
  label,
  detail,
  percentage,
}) => {
  const normalizedPercentage = Number.isFinite(percentage)
    ? Math.min(100, Math.max(0, percentage))
    : 0;

  return (
    <Tooltip content={detail} className="flex-shrink-0 leading-none" position="top" renderInPortal>
      <span
        role="img"
        tabIndex={0}
        aria-label={`${label}: ${detail}`}
        className="inline-flex h-7 w-7 items-center justify-center text-secondary outline-none select-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <svg aria-hidden="true" className="h-4 w-4 -rotate-90" viewBox="0 0 20 20">
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="opacity-20"
          />
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            pathLength="100"
            stroke="currentColor"
            strokeDasharray={`${normalizedPercentage} 100`}
            strokeLinecap="round"
            strokeWidth="2.5"
            className="text-primary"
          />
        </svg>
      </span>
    </Tooltip>
  );
};

export default ContextUsageIndicator;
