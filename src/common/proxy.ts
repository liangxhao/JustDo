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
