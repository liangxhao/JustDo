import type { ExternalAgentSettings } from '@shared/openclaw/externalAgents';
import React from 'react';

import { i18nService } from '@/services/i18n';

import ExternalAgentsSettingsSection from './ExternalAgentsSettingsSection';
import ToolIntegrationSettingsTab from './ToolIntegrationSettingsTab';

export const IntegrationSettingsView = {
  AgentDelegation: 'agent-delegation',
  AppAccess: 'app-access',
} as const;

export type IntegrationSettingsViewId =
  (typeof IntegrationSettingsView)[keyof typeof IntegrationSettingsView];

type Props = {
  activeView: IntegrationSettingsViewId;
  onViewChange: (view: IntegrationSettingsViewId) => void;
  externalAgentSettings: ExternalAgentSettings;
  onExternalAgentSettingsChange: (settings: ExternalAgentSettings) => void;
  externalAgentSettingsLoading: boolean;
  externalAgentSettingsLoadError: string | null;
  onExternalAgentSettingsRetry: () => void;
};

const IntegrationSettingsTab: React.FC<Props> = ({
  activeView,
  onViewChange,
  externalAgentSettings,
  onExternalAgentSettingsChange,
  externalAgentSettingsLoading,
  externalAgentSettingsLoadError,
  onExternalAgentSettingsRetry,
}) => {
  const views: Array<{ id: IntegrationSettingsViewId; label: string }> = [
    {
      id: IntegrationSettingsView.AgentDelegation,
      label: i18nService.t('integrationAgentDelegationTab'),
    },
    {
      id: IntegrationSettingsView.AppAccess,
      label: i18nService.t('integrationAppAccessTab'),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="overflow-x-auto border-b border-border" role="tablist">
        <div className="flex w-max min-w-full justify-center gap-1">
          {views.map(view => (
            <button
              key={view.id}
              type="button"
              role="tab"
              id={`integration-tab-${view.id}`}
              aria-controls={`integration-panel-${view.id}`}
              aria-selected={activeView === view.id}
              onClick={() => onViewChange(view.id)}
              className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeView === view.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-secondary hover:text-foreground'
              }`}
            >
              {view.label}
            </button>
          ))}
        </div>
      </div>

      <div
        id={`integration-panel-${activeView}`}
        role="tabpanel"
        aria-labelledby={`integration-tab-${activeView}`}
      >
        {activeView === IntegrationSettingsView.AgentDelegation ? (
          <ExternalAgentsSettingsSection
            settings={externalAgentSettings}
            onChange={onExternalAgentSettingsChange}
            isLoading={externalAgentSettingsLoading}
            loadError={externalAgentSettingsLoadError}
            onRetry={onExternalAgentSettingsRetry}
          />
        ) : (
          <ToolIntegrationSettingsTab />
        )}
      </div>
    </div>
  );
};

export default IntegrationSettingsTab;
