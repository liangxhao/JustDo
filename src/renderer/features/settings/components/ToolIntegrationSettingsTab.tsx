import { ArrowRightIcon, BoltIcon, ClockIcon } from '@heroicons/react/24/outline';
import React, { useState } from 'react';

import { i18nService } from '@/services/i18n';

import MulticaIntegrationCard from './MulticaIntegrationCard';

type IntegrationDirection = 'outbound' | 'inbound';

const ToolIntegrationSettingsTab: React.FC = () => {
  const [direction, setDirection] = useState<IntegrationDirection>('inbound');

  const tabs: Array<{ key: IntegrationDirection; label: string; description: string }> = [
    {
      key: 'outbound',
      label: i18nService.t('toolIntegrationOutboundTab'),
      description: i18nService.t('toolIntegrationOutboundTabDescription'),
    },
    {
      key: 'inbound',
      label: i18nService.t('toolIntegrationInboundTab'),
      description: i18nService.t('toolIntegrationInboundTabDescription'),
    },
  ];

  return (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label={i18nService.t('toolIntegrationDirectionLabel')}
        className="grid gap-2 rounded-2xl border border-border bg-surface-raised/60 p-1.5 md:grid-cols-2"
      >
        {tabs.map(tab => {
          const active = direction === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`tool-integration-panel-${tab.key}`}
              id={`tool-integration-tab-${tab.key}`}
              onClick={() => setDirection(tab.key)}
              className={`rounded-xl px-4 py-3 text-left transition-all ${
                active
                  ? 'bg-surface text-foreground shadow-card ring-1 ring-border/70'
                  : 'text-secondary hover:bg-surface/60 hover:text-foreground'
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                {tab.key === 'outbound' ? (
                  <ArrowRightIcon className="h-4 w-4 text-primary" />
                ) : (
                  <BoltIcon className="h-4 w-4 text-primary" />
                )}
                {tab.label}
              </span>
              <span className="mt-1 block text-[11px] leading-4 text-secondary">
                {tab.description}
              </span>
            </button>
          );
        })}
      </div>

      {direction === 'outbound' ? (
        <section
          id="tool-integration-panel-outbound"
          role="tabpanel"
          aria-labelledby="tool-integration-tab-outbound"
          className="relative overflow-hidden rounded-2xl border border-border bg-surface px-6 py-12 text-center"
        >
          <div
            className="pointer-events-none absolute inset-x-1/4 top-0 h-28 rounded-full bg-primary/10 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative mx-auto flex max-w-xl flex-col items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-muted text-primary">
              <ClockIcon className="h-6 w-6" />
            </div>
            <span className="mt-4 rounded-full border border-primary/20 bg-primary-muted px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
              {i18nService.t('toolIntegrationComingSoon')}
            </span>
            <h4 className="mt-3 text-base font-semibold text-foreground">
              {i18nService.t('toolIntegrationOutboundTitle')}
            </h4>
            <p className="mt-2 text-sm leading-6 text-secondary">
              {i18nService.t('toolIntegrationOutboundDescription')}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2" aria-hidden="true">
              {[
                i18nService.t('toolIntegrationClaudeCode'),
                i18nService.t('toolIntegrationCodex'),
              ].map(tool => (
                <span
                  key={tool}
                  className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium text-secondary"
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>
        </section>
      ) : (
        <div
          id="tool-integration-panel-inbound"
          role="tabpanel"
          aria-labelledby="tool-integration-tab-inbound"
          className="space-y-3"
        >
          <div className="rounded-xl border border-border/70 bg-surface-raised/40 px-4 py-3">
            <h4 className="text-sm font-semibold text-foreground">
              {i18nService.t('toolIntegrationInboundTitle')}
            </h4>
            <p className="mt-1 text-xs leading-5 text-secondary">
              {i18nService.t('toolIntegrationInboundDescription')}
            </p>
          </div>
          <MulticaIntegrationCard />
        </div>
      )}
    </div>
  );
};

export default ToolIntegrationSettingsTab;
