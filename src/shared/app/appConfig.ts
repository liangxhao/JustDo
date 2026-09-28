export const AppConfigIpc = {
  Patch: 'appConfig:patch',
} as const;

export type AppConfigPatch = Record<string, unknown>;
