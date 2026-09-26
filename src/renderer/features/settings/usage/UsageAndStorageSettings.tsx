import { useState } from 'react';

import { i18nService } from '@/services/i18n';

import SessionStorageCard from './SessionStorageCard';
import UsageStatsTab from './UsageStatsTab';

const views = [
  { id: 'usage', label: 'usageStats' },
  { id: 'storage', label: 'storageTitle' },
] as const;

export default function UsageAndStorageSettings() {
  const [activeView, setActiveView] = useState<(typeof views)[number]['id']>('usage');

  return (
    <div className="space-y-5">
      <div
        className="overflow-x-auto border-b border-border"
        role="tablist"
        aria-label={i18nService.t('usageAndStorage')}
      >
        <div className="flex w-max min-w-full justify-center gap-1">
          {views.map((view, index) => (
            <button
              key={view.id}
              type="button"
              role="tab"
              id={`usage-storage-tab-${view.id}`}
              aria-controls={`usage-storage-panel-${view.id}`}
              aria-selected={activeView === view.id}
              tabIndex={activeView === view.id ? 0 : -1}
              onClick={() => setActiveView(view.id)}
              onKeyDown={event => {
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? views.length - 1
                      : event.key === 'ArrowRight'
                        ? (index + 1) % views.length
                        : event.key === 'ArrowLeft'
                          ? (index + views.length - 1) % views.length
                          : null;
                if (next === null) return;
                event.preventDefault();
                setActiveView(views[next].id);
                document.getElementById(`usage-storage-tab-${views[next].id}`)?.focus();
              }}
              className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeView === view.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-secondary hover:text-foreground'
              }`}
            >
              {i18nService.t(view.label)}
            </button>
          ))}
        </div>
      </div>
      <div
        id={`usage-storage-panel-${activeView}`}
        role="tabpanel"
        aria-labelledby={`usage-storage-tab-${activeView}`}
      >
        {activeView === 'usage' ? <UsageStatsTab /> : <SessionStorageCard />}
      </div>
    </div>
  );
}
