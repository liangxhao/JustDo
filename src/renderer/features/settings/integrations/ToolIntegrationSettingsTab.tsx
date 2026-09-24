import React from 'react';

import { i18nService } from '@/services/i18n';

import MulticaIntegrationCard from './MulticaIntegrationCard';

const ToolIntegrationSettingsTab: React.FC = () => (
  <div className="space-y-6">
    <div>
      <h4 className="text-lg font-semibold text-foreground">
        {i18nService.t('toolIntegrationInboundTitle')}
      </h4>
      <p className="mt-1 text-sm leading-6 text-secondary">
        {i18nService.t('toolIntegrationInboundDescription')}
      </p>
    </div>
    <MulticaIntegrationCard />
  </div>
);

export default ToolIntegrationSettingsTab;
