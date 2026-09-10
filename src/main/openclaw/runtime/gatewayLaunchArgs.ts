export type GatewayLaunchArgsOptions = {
  port: number;
  token: string;
  isPackaged: boolean;
};

export const APP_STARTED_AT_ENV = 'JUSTDO_APP_STARTED_AT_MS';

export const buildGatewayLaunchEnvironment = (
  env: NodeJS.ProcessEnv,
  options: { appStartedAtMs: number },
): NodeJS.ProcessEnv => {
  const inherited = { ...env };
  for (const key of Object.keys(inherited)) {
    if (key.toUpperCase() === 'JUSTDO_APIKEY_BUILTIN_MODELS') delete inherited[key];
  }
  return ({
  ...inherited,
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
  });
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
