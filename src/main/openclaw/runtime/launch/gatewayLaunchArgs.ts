import path from 'node:path';

export type GatewayLaunchArgsOptions = {
  port: number;
  token: string;
  isPackaged: boolean;
};

export const APP_STARTED_AT_ENV = 'JUSTDO_APP_STARTED_AT_MS';

export const buildGatewayLaunchEnvironment = (
  env: NodeJS.ProcessEnv,
  options: { appStartedAtMs: number; stateDir: string; platform?: NodeJS.Platform },
): NodeJS.ProcessEnv => {
  const inherited = { ...env };
  const useWindowsPolling = (options.platform ?? process.platform) === 'win32';
  for (const key of Object.keys(inherited)) {
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey === 'JUSTDO_APIKEY_BUILTIN_MODELS' ||
      normalizedKey === 'OPENCLAW_TTS_PREFS' ||
      (useWindowsPolling &&
        (normalizedKey === 'CHOKIDAR_USEPOLLING' || normalizedKey === 'CHOKIDAR_INTERVAL'))
    ) {
      delete inherited[key];
    }
  }
  return {
    ...inherited,
    // Polling avoids Windows directory handles that block skill changes. Let
    // native owners choose their intervals: skills scan trees every 30 seconds,
    // while configuration files need faster observation. A shared short interval
    // keeps all skill roots scanning and starves interactive Gateway requests.
    ...(useWindowsPolling ? { CHOKIDAR_USEPOLLING: 'true' } : {}),
    // JustDo owns discovery, process supervision, and the WebChat-only channel
    // lifecycle for its embedded Gateway.
    OPENCLAW_DISABLE_BONJOUR: '1',
    OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_SKIP_CHANNELS: '1',
    // The persistent top-level tts schema has no prefsPath field. This native
    // override keeps tool preferences inside this Gateway's managed state.
    OPENCLAW_TTS_PREFS: path.join(options.stateDir, 'speech-tools', 'preferences.json'),
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
