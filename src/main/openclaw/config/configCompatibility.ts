import { TEAM_DISCUSSION_CHANNEL } from '../../../shared/cowork/agent-team/teamDiscussion';
import { isRecord } from './configShape';

/** The discussion surface permits native ambient silence without relaxing direct replies. */
export const buildManagedOpenClawSurfaces = (existing: unknown): Record<string, unknown> => {
  const surfaces = isRecord(existing) ? existing : {};
  return {
    ...surfaces,
    [TEAM_DISCUSSION_CHANNEL]: {
      ...(isRecord(surfaces[TEAM_DISCUSSION_CHANNEL]) ? surfaces[TEAM_DISCUSSION_CHANNEL] : {}),
      silentReply: { group: 'allow' },
    },
  };
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
