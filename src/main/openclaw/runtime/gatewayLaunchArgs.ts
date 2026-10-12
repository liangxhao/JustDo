export type GatewayLaunchArgsOptions = {
  port: number;
  token: string;
  isPackaged: boolean;
};

export const APP_STARTED_AT_ENV = 'JUSTDO_APP_STARTED_AT_MS';

export const buildGatewayLaunchEnvironment = (
  env: NodeJS.ProcessEnv,
  options: { appStartedAtMs: number; platform?: NodeJS.Platform },
): NodeJS.ProcessEnv => {
  const inherited = { ...env };
  const useWindowsPolling = (options.platform ?? process.platform) === 'win32';
  for (const key of Object.keys(inherited)) {
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey === 'JUSTDO_APIKEY_BUILTIN_MODELS' ||
      (useWindowsPolling &&
        (normalizedKey === 'CHOKIDAR_USEPOLLING' || normalizedKey === 'CHOKIDAR_INTERVAL'))
    ) {
      delete inherited[key];
    }
  }
  return {
    ...inherited,
    // OpenClaw's native skill watcher honors these Chokidar settings. Polling
    // avoids Windows directory handles that block transactional skill changes.
    // Apply only to Gateway and its workers, preserving the host/CLI environment.
    ...(useWindowsPolling ? { CHOKIDAR_USEPOLLING: 'true', CHOKIDAR_INTERVAL: '500' } : {}),
    // JustDo owns discovery, process supervision, and the WebChat-only channel
    // lifecycle for its embedded Gateway.
    OPENCLAW_DISABLE_BONJOUR: '1',
    OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_SKIP_CHANNELS: '1',
    // This boundary remains stable for every Gateway process launched by the
    // current app process. OpenClaw can therefore distinguish prior-app work
    // from work interrupted by a Gateway-only restart without relying on a
    // racy "first healthy Gateway" acknowledgement.
    [APP_STARTED_AT_ENV]: String(options.appStartedAtMs),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
};

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
