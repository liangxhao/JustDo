import React from 'react';

import {
  type AppearanceConfig,
  type AppearanceFontFamily,
  defaultAppearanceConfig,
  type MessageDensity,
} from '@/app/appearance';
import { i18nService } from '@/services/i18n';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';

interface AppearanceSettingsTabProps {
  value: AppearanceConfig;
  onChange: (value: AppearanceConfig) => void;
}

interface SettingRowProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

const SettingRow: React.FC<SettingRowProps> = ({ title, description, children }) => (
  <div className="flex flex-col gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
    <div className="min-w-0 pr-4">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <p className="mt-1 text-xs leading-5 text-secondary">{description}</p>
    </div>
    <div className="w-full shrink-0 sm:w-[280px]">{children}</div>
  </div>
);

const Toggle: React.FC<{
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}> = ({ checked, label, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className={`ml-auto flex h-6 w-11 items-center rounded-full p-0.5 shadow-inner transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
      checked ? 'bg-primary' : 'bg-border'
    }`}
  >
    <span
      className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
        checked ? 'translate-x-5' : 'translate-x-0'
      }`}
    />
  </button>
);

const AppearanceSettingsTab: React.FC<AppearanceSettingsTabProps> = ({ value, onChange }) => {
  const update = <K extends keyof AppearanceConfig>(key: K, next: AppearanceConfig[K]) => {
    onChange({ ...value, [key]: next });
  };

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-4 bg-surface-raised px-4 py-2.5">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-foreground">
            {i18nService.t('readingExperience')}
          </h4>
          <p className="mt-0.5 truncate text-[11px] leading-4 text-secondary">
            {i18nService.t('readingExperienceDescription')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange(defaultAppearanceConfig)}
          className="shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-surface-inset hover:text-primary"
        >
          {i18nService.t('restoreDefaults')}
        </button>
      </div>

      <div className="border-t border-border">
        <SettingRow
          title={i18nService.t('chatContentWidth')}
          description={i18nService.t('chatContentWidthDescription')}
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="60"
              max="100"
              step="2"
              value={value.chatContentWidth}
              aria-label={i18nService.t('chatContentWidth')}
              onChange={event => update('chatContentWidth', Number(event.target.value))}
              className="h-1.5 flex-1 cursor-pointer accent-primary"
            />
            <output className="w-12 text-right text-sm tabular-nums text-foreground">
              {value.chatContentWidth}%
            </output>
          </div>
        </SettingRow>

        <SettingRow
          title={i18nService.t('interfaceFontSize')}
          description={i18nService.t('interfaceFontSizeDescription')}
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="13"
              max="20"
              step="1"
              value={value.fontSize}
              aria-label={i18nService.t('interfaceFontSize')}
              onChange={event => update('fontSize', Number(event.target.value))}
              className="h-1.5 flex-1 cursor-pointer accent-primary"
            />
            <output className="w-12 text-right text-sm tabular-nums text-foreground">
              {value.fontSize}px
            </output>
          </div>
        </SettingRow>

        <SettingRow
          title={i18nService.t('interfaceFont')}
          description={i18nService.t('interfaceFontDescription')}
        >
          <ThemedSelect
            id="appearance-font-family"
            value={value.fontFamily}
            ariaLabel={i18nService.t('interfaceFont')}
            onChange={next => update('fontFamily', next as AppearanceFontFamily)}
            options={[
              { value: 'system', label: i18nService.t('fontSystem') },
              { value: 'sans', label: i18nService.t('fontSans') },
              { value: 'serif', label: i18nService.t('fontSerif') },
              { value: 'monospace', label: i18nService.t('fontMonospace') },
            ]}
          />
        </SettingRow>

        <SettingRow
          title={i18nService.t('messageDensity')}
          description={i18nService.t('messageDensityDescription')}
        >
          <div
            className="grid grid-cols-3 gap-2"
            role="group"
            aria-label={i18nService.t('messageDensity')}
          >
            {(['compact', 'comfortable', 'spacious'] as const).map(density => (
              <button
                key={density}
                type="button"
                aria-pressed={value.messageDensity === density}
                onClick={() => update('messageDensity', density as MessageDensity)}
                className={`rounded-lg border px-2 py-2 text-xs transition-colors ${
                  value.messageDensity === density
                    ? 'border-primary bg-primary-muted text-primary'
                    : 'border-border bg-surface text-secondary hover:bg-surface-raised'
                }`}
              >
                {i18nService.t(`density${density[0].toUpperCase()}${density.slice(1)}`)}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow
          title={i18nService.t('wrapCodeBlocks')}
          description={i18nService.t('wrapCodeBlocksDescription')}
        >
          <Toggle
            checked={value.wrapCodeBlocks}
            label={i18nService.t('wrapCodeBlocks')}
            onChange={checked => update('wrapCodeBlocks', checked)}
          />
        </SettingRow>
      </div>
    </section>
  );
};

export default AppearanceSettingsTab;
