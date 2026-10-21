export const WindowAppearanceIpc = {
  Get: 'window:appearance:get',
} as const;
export const WindowAppearanceMode = {
  Light: 'light',
  Dark: 'dark',
  System: 'system',
} as const;

export type WindowAppearance = {
  readonly mode: (typeof WindowAppearanceMode)[keyof typeof WindowAppearanceMode];
  readonly themeId?: string;
};

/** Only approved display preferences may cross the first-paint bridge. */
export function normalizeWindowAppearance(mode: unknown, themeId?: unknown): WindowAppearance {
  return {
    mode:
      mode === WindowAppearanceMode.Dark || mode === WindowAppearanceMode.System
        ? mode
        : WindowAppearanceMode.Light,
    ...(typeof themeId === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(themeId) ? { themeId } : {}),
  };
}

/** A transient guide must never ask Main to open or read the product Store. */
export function readWindowAppearance(
  readSnapshot: () => unknown,
  transient: boolean,
): WindowAppearance {
  if (transient) return normalizeWindowAppearance(undefined);
  try {
    const value = readSnapshot() as Partial<WindowAppearance> | null | undefined;
    return normalizeWindowAppearance(value?.mode, value?.themeId);
  } catch {
    /* Unavailable display settings cannot block the error presentation. */
  }
  return normalizeWindowAppearance(undefined);
}
