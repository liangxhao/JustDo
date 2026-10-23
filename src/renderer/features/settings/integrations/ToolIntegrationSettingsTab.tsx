import React, { useState } from 'react';

import { i18nService } from '@/services/i18n';

import AgentCliIntegrationCard from './AgentCliIntegrationCard';
import AgentProtocolConnectionCard, { AgentConnectionProtocol } from './AgentProtocolConnectionCard';
import ApplicationConnectionExamples from './ApplicationConnectionExamples';

const ToolIntegrationSettingsTab: React.FC = () => {
  const [command, setCommand] = useState('');
  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-lg font-semibold text-foreground">
          {i18nService.t('toolIntegrationInboundTitle')}
        </h4>
        <p className="mt-1 text-sm leading-6 text-secondary">
          {i18nService.t('toolIntegrationInboundDescription')}
        </p>
      </div>
      <AgentCliIntegrationCard onCommandChange={setCommand} />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <AgentProtocolConnectionCard protocol={AgentConnectionProtocol.Acp} command={command} />
        <AgentProtocolConnectionCard protocol={AgentConnectionProtocol.CodexAppServer} command={command}>
          <ApplicationConnectionExamples command={command} />
        </AgentProtocolConnectionCard>
      </div>
    </div>
  );
};

export default ToolIntegrationSettingsTab;
