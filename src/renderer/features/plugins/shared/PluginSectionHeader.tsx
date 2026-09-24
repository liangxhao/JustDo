import React from 'react';

interface PluginSectionHeaderProps {
  title: string;
  description?: string;
  count?: number;
  action?: React.ReactNode;
}

const PluginSectionHeader: React.FC<PluginSectionHeaderProps> = ({
  title,
  description,
  count,
  action,
}) => (
  <div className="flex items-start justify-between gap-3">
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {count !== undefined && (
          <span className="rounded-full border border-border bg-surface-raised px-2 py-0.5 text-[11px] font-medium tabular-nums text-secondary">
            {count}
          </span>
        )}
      </div>
      {description && <p className="mt-1 text-sm leading-5 text-secondary">{description}</p>}
    </div>
    {action && <div className="shrink-0 whitespace-nowrap">{action}</div>}
  </div>
);

export default PluginSectionHeader;
