interface SettingsPersistenceSteps {
  saveCoworkConfig: () => Promise<void>;
  saveRuntimeSettings: () => Promise<void>;
  saveAppConfig: () => Promise<void>;
  onAppConfigCommitted: () => void;
}

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
