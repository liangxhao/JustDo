export const ProxyMode = {
  SYSTEM: 'system',
  CUSTOM: 'custom',
  DIRECT: 'direct',
} as const;

export type ProxyMode = (typeof ProxyMode)[keyof typeof ProxyMode];

export const ProxyProtocol = {
  HTTP: 'http',
  HTTPS: 'https',
} as const;

export type ProxyProtocol = (typeof ProxyProtocol)[keyof typeof ProxyProtocol];

export type CustomProxyConfig = {
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username?: string;
  password?: string;
};

export type ProxySettings = {
  mode: ProxyMode;
  custom: CustomProxyConfig;
};

export const defaultCustomProxyConfig: CustomProxyConfig = {
  protocol: ProxyProtocol.HTTP,
  host: '',
  port: '',
  username: '',
  password: '',
};

export const defaultProxySettings: ProxySettings = {
  mode: ProxyMode.DIRECT,
  custom: defaultCustomProxyConfig,
};

export const defaultBrowserProxySettings: ProxySettings = {
  mode: ProxyMode.SYSTEM,
  custom: defaultCustomProxyConfig,
};

export const normalizeProxySettings = (
  proxy?: Partial<ProxySettings>,
  defaultMode: ProxyMode = ProxyMode.DIRECT,
): ProxySettings => ({
  mode: Object.values(ProxyMode).includes(proxy?.mode as ProxyMode)
    ? (proxy?.mode as ProxyMode)
    : defaultMode,
  custom: {
    protocol: Object.values(ProxyProtocol).includes(proxy?.custom?.protocol as ProxyProtocol)
      ? (proxy?.custom?.protocol as ProxyProtocol)
      : defaultCustomProxyConfig.protocol,
    host: typeof proxy?.custom?.host === 'string' ? proxy.custom.host.trim() : '',
    port: typeof proxy?.custom?.port === 'string' ? proxy.custom.port.trim() : '',
    username: typeof proxy?.custom?.username === 'string' ? proxy.custom.username.trim() : '',
    password: typeof proxy?.custom?.password === 'string' ? proxy.custom.password : '',
  },
});

export const buildCustomProxyUrl = (custom: CustomProxyConfig): string | null => {
  const host = custom.host.trim();
  const port = custom.port.trim();
  if (!host || !port) return null;
  const username = custom.username?.trim();
  const password = custom.password ?? '';
  const credentials = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
    : '';
  try {
    const parsedPort = Number(port);
    const url = new URL(`${custom.protocol}://${credentials}${host}:${port}`);
    if (!url.hostname || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
      return null;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
};
