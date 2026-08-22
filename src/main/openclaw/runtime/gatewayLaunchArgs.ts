export type GatewayLaunchArgsOptions = {
  port: number;
  token: string;
  isPackaged: boolean;
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
