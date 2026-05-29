/**
 * IM Settings Component
 * Placeholder UI for IM bots - Coming Soon
 */

import React from 'react';

import { i18nService } from '../../services/i18n';

const IMSettings: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center h-full py-12">
      <div className="text-center space-y-4">
        <div className="text-6xl mb-4">🤖</div>
        <h2 className="text-xl font-semibold text-foreground">{i18nService.t('imComingSoon')}</h2>
        <p className="text-sm text-secondary max-w-md">{i18nService.t('imComingSoonDesc')}</p>
      </div>
    </div>
  );
};

export default IMSettings;
