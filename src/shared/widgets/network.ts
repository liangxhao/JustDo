/** Trusted application controller only. No HTML or board view tickets cross this API. */
export const WidgetNetworkIpc = {
  BeginCheck: 'widget-network:begin-check',
  Create: 'widget-network:create',
  Renew: 'widget-network:renew',
  Close: 'widget-network:close',
  Revoked: 'widget-network:revoked',
} as const;

export const WIDGET_NETWORK_PARTITION_PREFIX = 'widget-network-';
export const WIDGET_NETWORK_LEASE_MS = 60_000;
export const WIDGET_NETWORK_CHECK_MS = 15_000;

export type WidgetNetworkBinding = {
  connectionGeneration: number;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  name: string;
  revision: number;
  instanceId: string;
  viewGeneration: string;
  grantState: 'granted';
  netOrigins: string[];
};

export type WidgetNetworkCheckRequest = { mountId: string; instanceId?: string };
export type WidgetNetworkCheck = { nonce: string; validForMs: number };
export type WidgetNetworkCreate = {
  mountId: string;
  nonce: string;
  binding: WidgetNetworkBinding;
  gatewayOrigin: string;
  sandboxUrl: string;
  /** Exact plugin script URL below the current native smart-canvas-html surface. */
  resourceUrls: string[];
};
export type WidgetNetworkInstance = { instanceId: string; partition: string; mountId: string };
export type WidgetNetworkRenew = {
  mountId: string;
  instanceId: string;
  nonce: string;
  binding: WidgetNetworkBinding;
};
export type WidgetNetworkClose = { mountId: string; instanceId: string };
export type WidgetNetworkRevoked = WidgetNetworkClose & {
  reason: 'expired' | 'owner' | 'proxy' | 'closed' | 'guest';
};

export type WidgetNetworkBridge = {
  beginCheck: (request: WidgetNetworkCheckRequest) => Promise<WidgetNetworkCheck>;
  create: (request: WidgetNetworkCreate) => Promise<WidgetNetworkInstance>;
  renew: (request: WidgetNetworkRenew) => Promise<void>;
  close: (request: WidgetNetworkClose) => Promise<void>;
  onRevoked: (callback: (event: WidgetNetworkRevoked) => void) => () => void;
};
