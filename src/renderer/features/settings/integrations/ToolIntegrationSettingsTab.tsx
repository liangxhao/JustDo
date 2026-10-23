import React, { useState } from 'react';

import { i18nService } from '@/services/i18n';

import AgentCliIntegrationCard from './AgentCliIntegrationCard';
import AgentProtocolConnectionCard from './AgentProtocolConnectionCard';
import ApplicationConnectionExamples from './ApplicationConnectionExamples';
import AppServerWebSocketConnectionCard from './AppServerWebSocketConnectionCard';

const ToolIntegrationSettingsTab: React.FC = () => {
  const [command, setCommand] = useState('');
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-lg font-semibold text-foreground">
          {i18nService.t('toolIntegrationInboundTitle')}
        </h4>
        <p className="mt-1 text-sm leading-6 text-secondary">
          {i18nService.t('toolIntegrationInboundDescription')}
        </p>
      </div>
      <AgentCliIntegrationCard onCommandChange={setCommand} />
      <AgentProtocolConnectionCard
        command={command}
        webSocket={<AppServerWebSocketConnectionCard />}
      >
        <ApplicationConnectionExamples command={command} />
      </AgentProtocolConnectionCard>
    </div>
  );
};

export default ToolIntegrationSettingsTab;
