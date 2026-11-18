import { isRecord } from './configShape';

/** Native surfaces retain user settings and accept explicit plugin-owned contributions. */
export const buildManagedOpenClawSurfaces = (
  existing: unknown,
  contributions: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...(isRecord(existing) ? existing : {}),
  ...contributions,
});

/** Keep native profiles across settings sync, while the app selects the active driver. */
export const mergeManagedOpenClawBrowserConfig = (
  existing: unknown,
  managed: Record<string, unknown>,
): Record<string, unknown> => {
  if (!isRecord(existing) || !isRecord(existing.profiles)) return managed;
  const profiles = { ...existing.profiles };
  if (isRecord(managed.profiles)) {
    for (const [name, managedProfile] of Object.entries(managed.profiles)) {
      const previous = profiles[name];
      // A different driver may carry incompatible native fields, such as a CDP
      // endpoint for the extension relay. Only merge settings for the same driver.
      if (
        !isRecord(previous) ||
        !isRecord(managedProfile) ||
        previous.driver !== managedProfile.driver
      ) {
        profiles[name] = managedProfile;
        continue;
      }
      profiles[name] = {
        ...previous,
        ...managedProfile,
        ...(typeof previous.mcpCommand === 'string' && previous.mcpCommand.trim()
          ? { mcpCommand: previous.mcpCommand }
          : {}),
      };
    }
  }
  return { ...managed, profiles };
};

/** Bind native Windows browser profiles to the bundled session launcher. */
export const projectManagedOpenClawBrowserConfig = (
  config: Record<string, unknown>,
): Record<string, unknown> => {
  const next = { ...config };

  if (isRecord(config.browser) || (process.platform === 'win32' && config.browser === undefined)) {
    const browser = isRecord(config.browser) ? { ...config.browser } : {};
    const profiles = isRecord(browser.profiles) ? { ...browser.profiles } : {};
    // Native Browser also synthesizes user outside User mode. Materialize only
    // that missing profile so every Windows attach uses the managed launcher.
    if (process.platform === 'win32' && profiles.user === undefined) {
      profiles.user = { driver: 'existing-session', attachOnly: true };
    }
    if (isRecord(browser.profiles) || Object.keys(profiles).length > 0) {
      browser.profiles = Object.fromEntries(
        Object.entries(profiles).map(([profileId, rawProfile]) => {
          if (!isRecord(rawProfile)) return [profileId, rawProfile];
          const profile = { ...rawProfile };
          if (
            process.platform === 'win32' &&
            profile.driver === 'existing-session' &&
            (profile.mcpCommand === undefined || profile.mcpCommand === 'npx')
          ) {
            profile.mcpCommand = 'chrome-mcp.cmd';
          }
          return [profileId, profile];
        }),
      );
    }
    next.browser = browser;
  }

  return next;
};

export const buildOpenClawConfigMeta = (
  version: string | null | undefined,
  existingMeta?: unknown,
): Record<string, unknown> => {
  // Gateway owns migration receipts. Dropping them makes native startup and
  // auth operations repeat completed migrations and rewrite the config.
  const meta = isRecord(existingMeta) ? { ...existingMeta } : {};
  return { ...meta, lastTouchedVersion: version || 'unknown' };
};
