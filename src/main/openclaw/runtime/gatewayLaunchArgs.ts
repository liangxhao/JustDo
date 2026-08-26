export type GatewayLaunchArgsOptions = {
  port: number;
  token: string;
  isPackaged: boolean;
};

export const APP_STARTED_AT_ENV = 'JUSTDO_APP_STARTED_AT_MS';

export const hasExtensionBrowserProfile = (config: unknown): boolean => {
  if (!config || typeof config !== 'object') return false;
  const browser = (config as { browser?: unknown }).browser;
  if (!browser || typeof browser !== 'object') return false;
  const profiles = (browser as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== 'object') return false;
  return Object.values(profiles).some(
    profile =>
      !!profile &&
      typeof profile === 'object' &&
      (profile as { driver?: unknown }).driver === 'extension',
  );
};

export const buildGatewayLaunchEnvironment = (
  env: NodeJS.ProcessEnv,
  options: { eagerBrowserControl: boolean; appStartedAtMs: number },
): NodeJS.ProcessEnv => ({
  ...env,
  // The browser service normally starts on the first browser.request. Starting
  // it with the Gateway gives a paired Chrome extension time to reconnect to
  // the relay before the settings page performs its initial readiness probe.
  ...(options.eagerBrowserControl ? { OPENCLAW_EAGER_BROWSER_CONTROL_SERVER: '1' } : {}),
  // This boundary remains stable for every Gateway process launched by the
  // current app process. OpenClaw can therefore distinguish prior-app work
  // from work interrupted by a Gateway-only restart without relying on a
  // racy "first healthy Gateway" acknowledgement.
  [APP_STARTED_AT_ENV]: String(options.appStartedAtMs),
  NO_COLOR: '1',
  FORCE_COLOR: '0',
});

export const buildGatewayLaunchArgs = ({
  port,
  token,
  isPackaged,
}: GatewayLaunchArgsOptions): string[] => [
  'gateway',
  '--bind',
  'loopback',
  '--port',
  String(port),
  '--token',
  token,
  ...(isPackaged ? [] : ['--verbose']),
];
