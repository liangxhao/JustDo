import React, { useState } from 'react';

import { i18nService } from '../../services/i18n';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import ExtensionsManager from './extensions/ExtensionsManager';
import HookManager from './hooks/HookManager';
import McpManager from './mcp/McpManager';
import SkillsManager from './skills/SkillsManager';

type PluginTab = 'extensions' | 'skills' | 'mcp' | 'hooks';

const PLUGIN_TABS: PluginTab[] = ['extensions', 'skills', 'mcp', 'hooks'];

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
  const isMac = window.electron.platform === 'darwin';

  const tabLabels: Record<PluginTab, string> = {
    extensions: i18nService.t('extensions'),
    skills: i18nService.t('skills'),
    mcp: i18nService.t('mcpServers'),
    hooks: i18nService.t('hooks'),
  };

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="draggable relative flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex h-8 items-center">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
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
          )}
        </div>
        <WindowTitleBar inline />
      </div>
      <header className="shrink-0 border-b border-border px-8 pt-5">
        <nav className="flex justify-center gap-6" aria-label={i18nService.t('plugins')}>
          {PLUGIN_TABS.map(tab => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-base font-semibold border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-primary text-primary'
                  : 'border-transparent text-secondary hover:text-foreground'
              }`}
            >
              {tabLabels[tab]}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-8 py-6">
        {activeTab === 'extensions' && <ExtensionsManager />}
        {activeTab === 'skills' && <SkillsManager />}
        {activeTab === 'mcp' && <McpManager />}
        {activeTab === 'hooks' && <HookManager />}
      </main>
    </div>
  );
};

export default PluginsView;
