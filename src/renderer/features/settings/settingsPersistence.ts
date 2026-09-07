import type { AppConfig } from '@/app/config';

interface SettingsPersistenceSteps {
  saveCoworkConfig: () => Promise<void>;
  saveRuntimeSettings: () => Promise<void>;
  saveAppConfig: () => Promise<void>;
  onAppConfigCommitted: () => void;
}

interface SettingsAppConfigDraft {
  api: AppConfig['api'];
  providers: NonNullable<AppConfig['providers']>;
  currentProviders: NonNullable<AppConfig['providers']>;
  theme: AppConfig['theme'];
  appearance: AppConfig['appearance'];
  language: AppConfig['language'];
  useSystemProxy: AppConfig['useSystemProxy'];
  proxy: AppConfig['proxy'];
  developerMode: AppConfig['developerMode'];
  shortcuts: NonNullable<AppConfig['shortcuts']>;
}

const hasConfigValueChanged = (current: unknown, next: unknown): boolean =>
  JSON.stringify(current) !== JSON.stringify(next);

/** Persist only changed settings so visual-only saves do not rewrite runtime-facing config. */
export const buildSettingsAppConfigUpdate = (
  current: AppConfig,
  draft: SettingsAppConfigDraft,
): Partial<AppConfig> => {
  const update: Partial<AppConfig> = {};
  if (hasConfigValueChanged(draft.currentProviders, draft.providers)) {
    update.api = draft.api;
    update.providers = draft.providers;
  }
  if (current.theme !== draft.theme) update.theme = draft.theme;
  if (hasConfigValueChanged(current.appearance, draft.appearance)) {
    update.appearance = draft.appearance;
  }
  if (current.language !== draft.language) update.language = draft.language;
  if (
    current.useSystemProxy !== draft.useSystemProxy ||
    hasConfigValueChanged(current.proxy, draft.proxy)
  ) {
    update.useSystemProxy = draft.useSystemProxy;
    update.proxy = draft.proxy;
  }
  if (current.developerMode !== draft.developerMode) {
    update.developerMode = draft.developerMode;
  }
  if (hasConfigValueChanged(current.shortcuts, draft.shortcuts)) {
    update.shortcuts = draft.shortcuts;
  }
  return update;
};

export const resolveSubagentModelAfterProviderChange = (
  draftModel: string | null,
  persistedModel: string | null | undefined,
  availableModelRefs: ReadonlySet<string>,
): string | null => {
  if (draftModel === null) return null;
  if (draftModel && availableModelRefs.has(draftModel)) return draftModel;
  if (persistedModel && availableModelRefs.has(persistedModel)) return persistedModel;
  return null;
};

/**
 * Runtime settings are synchronized against providers from the renderer app
 * config, so commit that config first. Mark the visual draft committed
 * immediately after persistence so a later runtime error cannot make Cancel
 * restore values that no longer match disk.
 */
export const persistSettingsInOrder = async ({
  saveCoworkConfig,
  saveRuntimeSettings,
  saveAppConfig,
  onAppConfigCommitted,
}: SettingsPersistenceSteps): Promise<void> => {
  await saveAppConfig();
  onAppConfigCommitted();
  await saveCoworkConfig();
  await saveRuntimeSettings();
};
