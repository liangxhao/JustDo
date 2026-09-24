import {
  BoltIcon,
  CircleStackIcon,
  PuzzlePieceIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import React, { useState } from 'react';

import WindowHeader from '@/app/shell/window/WindowHeader';
import ExtensionsManager from '@/features/plugins/extensions/ExtensionsManager';
import HookManager from '@/features/plugins/hooks/HookManager';
import McpManager from '@/features/plugins/mcp/McpManager';
import SkillsManager from '@/features/plugins/skills/SkillsManager';
import { i18nService } from '@/services/i18n';
import ComposeIcon from '@/shared/components/icons/ComposeIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import SidebarToggleIcon from '@/shared/components/icons/SidebarToggleIcon';

type PluginTab = 'extensions' | 'skills' | 'mcp' | 'hooks';

const PLUGIN_TABS: PluginTab[] = ['extensions', 'skills', 'mcp', 'hooks'];

const TAB_PRESENTATION: Record<
  PluginTab,
  { icon: React.ComponentType<{ className?: string }>; tone: string; activeTone: string }
> = {
  extensions: {
    icon: PuzzlePieceIcon,
    tone: 'bg-violet-500/10 text-violet-600 dark:text-violet-300',
    activeTone: 'border-violet-500/30 bg-violet-500/10',
  },
  skills: {
    icon: SparklesIcon,
    tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-300',
    activeTone: 'border-amber-500/30 bg-amber-500/10',
  },
  mcp: {
    icon: CircleStackIcon,
    tone: 'bg-sky-500/10 text-sky-600 dark:text-sky-300',
    activeTone: 'border-sky-500/30 bg-sky-500/10',
  },
  hooks: {
    icon: BoltIcon,
    tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    activeTone: 'border-emerald-500/30 bg-emerald-500/10',
  },
};

interface PluginsViewProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
}

const PluginsView: React.FC<PluginsViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
}) => {
  const [activeTab, setActiveTab] = useState<PluginTab>('extensions');
  const [searchQuery, setSearchQuery] = useState('');
  const [requestedExtensionId, setRequestedExtensionId] = useState<string>();
  const openExtensionDetail = (extensionId: string) => {
    setRequestedExtensionId(extensionId);
    setActiveTab('extensions');
  };

  const tabLabels: Record<PluginTab, string> = {
    extensions: i18nService.t('extensions'),
    skills: i18nService.t('skills'),
    mcp: i18nService.t('mcpServers'),
    hooks: i18nService.t('hooks'),
  };
  const tabDescriptions: Record<PluginTab, string> = {
    extensions: i18nService.t('pluginHubExtensionsDescription'),
    skills: i18nService.t('pluginHubSkillsDescription'),
    mcp: i18nService.t('pluginHubMcpDescription'),
    hooks: i18nService.t('pluginHubHooksDescription'),
  };

  return (
    <div className="h-full min-h-0 flex flex-col">
      <WindowHeader />
      {isSidebarCollapsed && (
        <div className="relative flex h-[2.1875rem] shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex h-8 items-center">
            <div className="non-draggable flex items-center gap-1">
              <button
                type="button"
                onClick={onToggleSidebar}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised"
                aria-label={i18nService.t('expand')}
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised"
                aria-label={i18nService.t('newChat')}
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <header className="pb-4 pt-7">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {i18nService.t('plugins')}
            </h1>
            <p className="mt-1 text-sm text-secondary">{i18nService.t('pluginHubDescription')}</p>
          </header>

          <div className="sticky top-0 z-20 -mx-2 border-b border-border bg-background/95 px-2 pb-3 pt-2 backdrop-blur-xl">
            <div className="relative">
              <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
              <input
                type="search"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder={i18nService.t('pluginHubSearchPlaceholder')}
                aria-label={i18nService.t('pluginHubSearchPlaceholder')}
                className="w-full rounded-xl border border-border bg-surface py-2.5 pl-9 pr-3 text-sm text-foreground shadow-sm placeholder-secondary focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <nav
              className="mt-3 flex flex-wrap items-center gap-1"
              aria-label={i18nService.t('pluginHubTypeFilter')}
            >
              {PLUGIN_TABS.map(tab => {
                const presentation = TAB_PRESENTATION[tab];
                const Icon = presentation.icon;
                const active = activeTab === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    aria-pressed={active}
                    title={tabDescriptions[tab]}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      active
                        ? presentation.activeTone
                        : 'border-transparent text-secondary hover:bg-surface-raised hover:text-foreground'
                    }`}
                  >
                    <Icon
                      className={`h-3.5 w-3.5 ${presentation.tone.split(' ').slice(1).join(' ')}`}
                    />
                    {tabLabels[tab]}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="mt-5">
            {activeTab === 'extensions' && (
              <ExtensionsManager
                searchQuery={searchQuery}
                visibility="all"
                requestedExtensionId={requestedExtensionId}
                onRequestedExtensionHandled={() => setRequestedExtensionId(undefined)}
              />
            )}
            {activeTab === 'skills' && <SkillsManager searchQuery={searchQuery} visibility="all" />}
            {activeTab === 'mcp' && (
              <McpManager
                searchQuery={searchQuery}
                visibility="all"
                onOpenExtension={openExtensionDetail}
              />
            )}
            {activeTab === 'hooks' && (
              <HookManager
                searchQuery={searchQuery}
                visibility="all"
                onOpenExtension={openExtensionDetail}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default PluginsView;
