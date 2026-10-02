import {
  ArrowLeftIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  CubeIcon,
  FolderOpenIcon,
  GlobeAltIcon,
  InformationCircleIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  MicrophoneIcon,
  PaintBrushIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useState } from 'react';

import { i18nService } from '@/services/i18n';

import {
  matchesSettingsPage,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  type SettingsTab,
} from './settingsCatalog';

const ICONS = {
  general: Cog6ToothIcon,
  appearance: PaintBrushIcon,
  pet: SparklesIcon,
  voice: MicrophoneIcon,
  shortcuts: KeyIcon,
  model: CubeIcon,
  agents: CpuChipIcon,
  runtime: Cog6ToothIcon,
  worktrees: FolderOpenIcon,
  security: ShieldCheckIcon,
  browser: GlobeAltIcon,
  integrations: PuzzlePieceIcon,
  im: ChatBubbleLeftRightIcon,
  usage: ChartBarIcon,
  help: InformationCircleIcon,
};

interface SettingsNavigationProps {
  activeTab: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
  onClose: () => void;
}

export function SettingsNavigation({ activeTab, onSelect, onClose }: SettingsNavigationProps) {
  const [query, setQuery] = useState('');
  const translate = (key: string) => i18nService.t(key);
  const pages = SETTINGS_PAGES.filter(page => matchesSettingsPage(page, query, translate));

  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-border-subtle bg-surface-raised/60 lg:w-[260px]">
      <div className="flex items-center gap-2 px-4 pb-4 pt-6">
        <button
          type="button"
          onClick={onClose}
          aria-label={translate('back')}
          className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <h2 className="text-lg font-semibold text-foreground">{translate('settings')}</h2>
      </div>
      <div className="relative mx-3 mb-3">
        <MagnifyingGlassIcon
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-secondary"
        />
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape' && query) {
              event.stopPropagation();
              setQuery('');
            }
          }}
          aria-label={translate('settingsSearch')}
          placeholder={translate('settingsSearch')}
          className="h-9 w-full rounded-xl border border-transparent bg-surface-inset pl-9 pr-9 text-sm text-foreground placeholder:text-tertiary focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20 [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label={translate('settingsSearchClear')}
            className="absolute right-1 top-1 rounded-lg p-1.5 text-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      <nav
        aria-label={translate('settings')}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-6"
      >
        {SETTINGS_GROUPS.map(group => {
          const entries = pages.filter(page => page.group === group);
          if (!entries.length) return null;
          return (
            <section key={group} aria-labelledby={`settings-group-${group}`}>
              <h3
                id={`settings-group-${group}`}
                className="px-3 pb-1.5 pt-1 text-xs font-medium text-tertiary"
              >
                {translate(`settingsGroup_${group}`)}
              </h3>
              <div className="space-y-0.5">
                {entries.map(page => {
                  const Icon = ICONS[page.id];
                  return (
                    <button
                      key={page.id}
                      type="button"
                      onClick={() => onSelect(page.id)}
                      aria-current={activeTab === page.id ? 'page' : undefined}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${activeTab === page.id ? 'bg-surface font-medium text-foreground' : 'text-secondary hover:bg-surface/60 hover:text-foreground'}`}
                    >
                      <Icon aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
                      <span className="min-w-0">
                        {translate(page.label)}
                        {query.trim() && (
                          <span className="mt-1 block text-xs font-normal leading-5 text-secondary">
                            {translate(page.description)}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
        {!pages.length && (
          <div role="status" className="px-3 py-6 text-sm text-secondary">
            <p className="font-medium text-foreground">{translate('settingsSearchEmpty')}</p>
            <p className="mt-2 text-xs leading-5">{translate('settingsSearchHint')}</p>
          </div>
        )}
      </nav>
    </aside>
  );
}
