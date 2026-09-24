import React from 'react';

import { type AppearanceConfig } from '@/app/appearance';
import AppearanceSettingsTab from '@/features/settings/preferences/AppearanceSettingsTab';
import { i18nService } from '@/services/i18n';
import { themeService } from '@/services/theme';

const APPEARANCE_PREVIEW_CARD_CLASS_NAME =
  'flex flex-col items-center rounded-xl border-2 p-2 transition-colors cursor-pointer';

const APPEARANCE_PREVIEW_CLASS_NAME = 'mb-1.5 h-auto w-full overflow-hidden rounded-md';

const APPEARANCE_PREVIEW_LABEL_CLASS_NAME = 'w-full truncate text-center text-xs font-medium';

interface AppearancePreferencesProps {
  appearance: AppearanceConfig;
  setAppearance: React.Dispatch<React.SetStateAction<AppearanceConfig>>;
  theme: 'system' | 'light' | 'dark';
  setTheme: React.Dispatch<React.SetStateAction<'system' | 'light' | 'dark'>>;
  setThemeId: React.Dispatch<React.SetStateAction<string>>;
  themeId: string;
}

export function AppearancePreferences({
  appearance,
  setAppearance,
  theme,
  setTheme,
  setThemeId,
  themeId,
}: AppearancePreferencesProps) {
  return (
    <div className="space-y-8">
      <AppearanceSettingsTab value={appearance} onChange={setAppearance} />

      {/* Appearance Section — mode selector + theme gallery */}
      <div>
        <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--justdo-text-primary)' }}>
          {i18nService.t('appearanceMode')}
        </h4>

        {/* Level 1: Mode selector */}
        <div className="mx-auto mb-4 grid max-w-[480px] grid-cols-3 gap-2.5">
          {(['light', 'dark', 'system'] as const).map(mode => {
            const isSelected = theme === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setTheme(mode);
                  themeService.setTheme(mode);
                  setThemeId(themeService.getThemeId());
                }}
                className={APPEARANCE_PREVIEW_CARD_CLASS_NAME}
                style={{
                  borderColor: isSelected ? 'var(--justdo-primary)' : 'var(--justdo-border)',
                  backgroundColor: isSelected ? 'var(--justdo-primary-muted)' : undefined,
                }}
              >
                <svg
                  viewBox="0 0 120 80"
                  className={APPEARANCE_PREVIEW_CLASS_NAME}
                  xmlns="http://www.w3.org/2000/svg"
                >
                  {mode === 'light' && (
                    <>
                      <rect width="120" height="80" fill="#F8F9FB" />
                      <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                      <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                      <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                      <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                      <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                      <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                      <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                      <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                      <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#E2E4E7" />
                    </>
                  )}
                  {mode === 'dark' && (
                    <>
                      <rect width="120" height="80" fill="#0F1117" />
                      <rect x="0" y="0" width="30" height="80" fill="#151820" />
                      <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                      <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                      <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                      <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                      <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                      <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                      <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                      <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#252930" />
                    </>
                  )}
                  {mode === 'system' && (
                    <>
                      <defs>
                        <clipPath id="left-half">
                          <rect x="0" y="0" width="60" height="80" />
                        </clipPath>
                        <clipPath id="right-half">
                          <rect x="60" y="0" width="60" height="80" />
                        </clipPath>
                      </defs>
                      <g clipPath="url(#left-half)">
                        <rect width="120" height="80" fill="#F8F9FB" />
                        <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                        <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                        <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                        <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                        <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                        <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                        <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                        <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                        <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                        <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                        <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                        <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                      </g>
                      <g clipPath="url(#right-half)">
                        <rect width="120" height="80" fill="#0F1117" />
                        <rect x="0" y="0" width="30" height="80" fill="#151820" />
                        <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                        <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                        <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                        <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                        <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                        <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                        <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                        <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                        <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                        <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                        <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                      </g>
                      <line x1="60" y1="0" x2="60" y2="80" stroke="#888" strokeWidth="0.5" />
                    </>
                  )}
                </svg>
                <span
                  className={APPEARANCE_PREVIEW_LABEL_CLASS_NAME}
                  style={{
                    color: isSelected ? 'var(--justdo-primary)' : 'var(--justdo-text-primary)',
                  }}
                >
                  {i18nService.t(mode)}
                </span>
              </button>
            );
          })}
        </div>

        {/* Theme color gallery — all themes */}
        <h4
          className="text-sm font-medium mb-3 mt-5"
          style={{ color: 'var(--justdo-text-primary)' }}
        >
          {i18nService.t('themeColor')}
        </h4>
        {(() => {
          const allThemes = themeService.getAllThemes();
          const renderTile = (t: import('@/theme').ThemeDefinition) => {
            const isSelected = themeId === t.meta.id;
            const [bg, c1, c2, c3] = t.meta.preview;
            return (
              <button
                key={t.meta.id}
                type="button"
                onClick={() => {
                  themeService.setThemeById(t.meta.id);
                  setThemeId(t.meta.id);
                  setTheme(t.meta.appearance as 'light' | 'dark');
                }}
                className={`${APPEARANCE_PREVIEW_CARD_CLASS_NAME} w-[calc(160px_-_0.416667rem)] max-w-[calc(33.333333%_-_0.416667rem)] min-w-0 shrink-0`}
                style={{
                  borderColor: isSelected ? 'var(--justdo-primary)' : 'var(--justdo-border)',
                  backgroundColor: isSelected ? 'var(--justdo-primary-muted)' : undefined,
                }}
              >
                <svg
                  viewBox="0 0 120 80"
                  className={APPEARANCE_PREVIEW_CLASS_NAME}
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <rect width="120" height="80" fill={bg} />
                  <rect x="6" y="10" width="30" height="60" rx="4" fill={c1} opacity="0.7" />
                  <rect x="42" y="10" width="72" height="60" rx="4" fill={c2} opacity="0.5" />
                  <circle cx="78" cy="40" r="12" fill={c3} opacity="0.8" />
                  <rect x="48" y="56" width="60" height="6" rx="3" fill={c1} opacity="0.6" />
                </svg>
                <span
                  className={APPEARANCE_PREVIEW_LABEL_CLASS_NAME}
                  style={{
                    color: isSelected ? 'var(--justdo-primary)' : 'var(--justdo-text-primary)',
                  }}
                >
                  {t.meta.name}
                </span>
              </button>
            );
          };
          return (
            <div className="flex flex-wrap justify-center gap-2.5">{allThemes.map(renderTile)}</div>
          );
        })()}
      </div>
    </div>
  );
}
