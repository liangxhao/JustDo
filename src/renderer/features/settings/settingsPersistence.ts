interface SettingsPersistenceSteps {
  saveRuntimeSettings: () => Promise<void>;
  saveAppConfig: () => Promise<void>;
  onAppConfigCommitted: () => void;
}

/**
 * Runtime settings are synchronized against providers from the renderer app
 * config, so commit that config first. Mark the visual draft committed
 * immediately after persistence so a later runtime error cannot make Cancel
 * restore values that no longer match disk.
 */
export const persistSettingsInOrder = async ({
  saveRuntimeSettings,
  saveAppConfig,
  onAppConfigCommitted,
}: SettingsPersistenceSteps): Promise<void> => {
  await saveAppConfig();
  onAppConfigCommitted();
  await saveRuntimeSettings();
};
