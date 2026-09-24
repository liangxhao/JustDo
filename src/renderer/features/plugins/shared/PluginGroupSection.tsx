import { ChevronDownIcon } from '@heroicons/react/24/outline';
import React, { useState } from 'react';

import { i18nService } from '@/services/i18n';

interface PluginGroupSectionProps {
  title: string;
  count: number;
  description?: string;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  forceExpanded?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}

const PluginGroupSection: React.FC<PluginGroupSectionProps> = ({
  title,
  count,
  description,
  collapsible = false,
  defaultExpanded = true,
  forceExpanded = false,
  action,
  children,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const effectiveExpanded = forceExpanded || expanded;
  const canCollapse = collapsible && !forceExpanded;

  const contentId = React.useId();
  const header = (
    <>
      <h3 className="shrink-0 text-sm font-semibold text-foreground">{title}</h3>
      {canCollapse && (
        <span
          className={`inline-flex shrink-0 items-center gap-0.5 text-xs font-medium transition-colors ${
            effectiveExpanded ? 'text-secondary' : 'text-primary'
          } group-hover:text-foreground`}
        >
          {effectiveExpanded
            ? i18nService.t('pluginGroupCollapseShort')
            : i18nService.t('pluginGroupExpandShort')}
          <ChevronDownIcon
            className={`h-4 w-4 transition-transform ${effectiveExpanded ? '' : '-rotate-90'}`}
          />
        </span>
      )}
      <span className="shrink-0 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary">
        {count}
      </span>
      {description && <p className="min-w-0 truncate text-xs text-secondary">{description}</p>}
      {action && <div className="ml-auto max-w-full shrink-0">{action}</div>}
    </>
  );

  return (
    <section>
      {canCollapse ? (
        <button
          type="button"
          className="group mb-2.5 flex w-full min-w-0 flex-wrap items-center gap-2 text-left"
          aria-expanded={effectiveExpanded}
          aria-controls={contentId}
          aria-label={i18nService
            .t(effectiveExpanded ? 'pluginGroupCollapse' : 'pluginGroupExpand')
            .replace('{name}', title)}
          onClick={() => setExpanded(current => !current)}
        >
          {header}
        </button>
      ) : (
        <div className="mb-2.5 flex min-w-0 flex-wrap items-center gap-2">{header}</div>
      )}
      <div id={contentId} hidden={!effectiveExpanded}>
        {children}
      </div>
    </section>
  );
};

export default PluginGroupSection;
