import React, { useState } from 'react';

import { i18nService } from '@/services/i18n';
import PlusCircleIcon from '@/shared/components/icons/PlusCircleIcon';
import PuzzleIcon from '@/shared/components/icons/PuzzleIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import Tooltip from '@/shared/components/ui/Tooltip';

type ExtensionTab = 'installed' | 'marketplace';

const ExtensionsManager: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ExtensionTab>('installed');
  const [searchQuery, setSearchQuery] = useState('');

  const tabClass = (tab: ExtensionTab) =>
    `px-4 py-2 text-sm font-medium transition-colors relative ${
      activeTab === tab ? 'text-foreground' : 'text-secondary hover:hover:text-foreground'
    }`;

  const tabIndicatorClass = (tab: ExtensionTab) =>
    `absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
      activeTab === tab ? 'bg-primary' : 'bg-transparent'
    }`;

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 bg-background pb-4 shadow-sm">
        <div className="flex items-center justify-between gap-4 border-b border-border">
          <div className="flex min-w-0 items-center">
            <button
              type="button"
              onClick={() => setActiveTab('installed')}
              className={tabClass('installed')}
            >
              {i18nService.t('extensionInstalled')}
              <div className={tabIndicatorClass('installed')} />
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('marketplace')}
              className={tabClass('marketplace')}
            >
              {i18nService.t('extensionMarketplace')}
              <div className={tabIndicatorClass('marketplace')} />
            </button>
          </div>
          <p className="min-w-0 truncate pb-2 text-right text-sm text-secondary">
            {i18nService.t('extensionsDescription')}
          </p>
        </div>
      </div>

      {activeTab === 'installed' && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
              <input
                type="text"
                placeholder={i18nService.t('searchExtensions')}
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                className="w-full rounded-xl border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground placeholder-secondary focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="w-full sm:ml-auto sm:w-auto">
              <Tooltip
                className="w-full sm:w-auto"
                content={i18nService.t('commonComingSoon')}
                position="bottom"
              >
                <button
                  type="button"
                  disabled
                  className="flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-secondary opacity-60 sm:w-auto"
                >
                  <PlusCircleIcon className="h-4 w-4" />
                  <span>{i18nService.t('customExtension')}</span>
                </button>
              </Tooltip>
            </div>
          </div>

          <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-border bg-surface/40 px-4 py-10 text-center">
            <div className="max-w-md space-y-3">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-surface-raised text-secondary">
                <PuzzleIcon className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-semibold text-foreground">
                  {searchQuery
                    ? i18nService.t('noExtensionsMatched')
                    : i18nService.t('commonComingSoon')}
                </h3>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'marketplace' && (
        <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-border bg-surface/40 px-4 py-10 text-center">
          <div className="max-w-md space-y-3">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-surface-raised text-secondary">
              <PuzzleIcon className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-foreground">
                {i18nService.t('commonComingSoon')}
              </h3>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExtensionsManager;
