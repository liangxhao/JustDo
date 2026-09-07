import React from 'react';

import {
  type AppearanceConfig,
  type AppearanceFontFamily,
  defaultAppearanceConfig,
  type MessageDensity,
  type MessageLayout,
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

const MessageLayoutPreview: React.FC<{ layout: MessageLayout }> = ({ layout }) => {
  const isBubble = layout === 'bubble';

  return (
    <svg
      viewBox="0 0 180 96"
      aria-hidden="true"
      data-message-layout-preview={layout}
      className="mb-2.5 h-auto w-full overflow-hidden rounded-lg border border-border bg-surface-raised"
    >
      <rect width="180" height="96" fill="var(--justdo-surface-raised)" />
      <circle cx="15" cy="19" r="7" fill="var(--justdo-primary-muted)" />
      <path d="M15 14.5v9M10.5 19h9" stroke="var(--justdo-primary)" strokeWidth="1.5" />
      {isBubble && (
        <>
          <rect
            x="29"
            y="9"
            width="139"
            height="39"
            rx="10"
            fill="var(--justdo-primary-muted)"
            stroke="var(--justdo-border)"
            strokeWidth="1.5"
          />
          <path
            d="M29 19l-5 4.5 5-.8"
            fill="var(--justdo-primary-muted)"
            stroke="var(--justdo-border)"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </>
      )}
      <rect
        x={isBubble ? 40 : 29}
        y={isBubble ? 20 : 11}
        width="72"
        height="4"
        rx="2"
        fill="var(--justdo-text-primary)"
        opacity="0.75"
      />
      <rect
        x={isBubble ? 40 : 29}
        y={isBubble ? 30 : 22}
        width="111"
        height="3"
        rx="1.5"
        fill="var(--justdo-text-secondary)"
        opacity="0.52"
      />
      <rect
        x={isBubble ? 40 : 29}
        y={isBubble ? 39 : 31}
        width="91"
        height="3"
        rx="1.5"
        fill="var(--justdo-text-secondary)"
        opacity="0.52"
      />
      <path
        d={isBubble ? 'M41 59h4M43 57v4' : 'M30 45h4M32 43v4'}
        stroke="var(--justdo-primary)"
        strokeWidth="1.25"
        opacity="0.8"
      />
      <rect
        x={isBubble ? 49 : 38}
        y={isBubble ? 57.5 : 43.5}
        width="70"
        height="3"
        rx="1.5"
        fill="var(--justdo-text-secondary)"
        opacity="0.62"
      />
      <rect
        x={isBubble ? 40 : 29}
        y={isBubble ? 73 : 67}
        width="42"
        height="2.5"
        rx="1.25"
        fill="var(--justdo-text-secondary)"
        opacity="0.42"
      />
      <circle
        cx={isBubble ? 88 : 77}
        cy={isBubble ? 74.25 : 68.25}
        r="1.25"
        fill="var(--justdo-text-secondary)"
        opacity="0.42"
      />
      <rect
        x={isBubble ? 94 : 83}
        y={isBubble ? 73 : 67}
        width="34"
        height="2.5"
        rx="1.25"
        fill="var(--justdo-text-secondary)"
        opacity="0.42"
      />
    </svg>
  );
};

const AppearanceSettingsTab: React.FC<AppearanceSettingsTabProps> = ({ value, onChange }) => {
  const update = <K extends keyof AppearanceConfig>(key: K, next: AppearanceConfig[K]) => {
    onChange({ ...value, [key]: next });
  };

  return (
    <div className="space-y-8">
      <section>
        <h4 className="mb-3 text-sm font-medium text-foreground">
          {i18nService.t('messageLayout')}
        </h4>
        <div
          className="mx-auto grid max-w-[480px] grid-cols-2 gap-2.5"
          role="group"
          aria-label={i18nService.t('messageLayout')}
        >
          {(['bubble', 'document'] as const).map(layout => (
            <button
              key={layout}
              type="button"
              aria-pressed={value.messageLayout === layout}
              onClick={() => update('messageLayout', layout)}
              className={`min-w-0 rounded-xl border-2 p-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                value.messageLayout === layout
                  ? 'border-primary bg-primary-muted text-primary'
                  : 'border-border bg-surface text-secondary hover:border-primary/40 hover:bg-surface-raised'
              }`}
            >
              <MessageLayoutPreview layout={layout} />
              <span className="block w-full truncate text-center font-medium">
                {i18nService.t(
                  layout === 'bubble' ? 'messageLayoutBubble' : 'messageLayoutDocument',
                )}
              </span>
            </button>
          ))}
        </div>
      </section>

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
            onClick={() =>
              onChange({ ...defaultAppearanceConfig, messageLayout: value.messageLayout })
            }
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
    </div>
  );
};

export default AppearanceSettingsTab;
