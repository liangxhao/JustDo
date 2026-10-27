import type { WebpageEmbedSettingsApi } from './webpageEmbedSettings';

/** Independent webpage viewers carry no tool, application or draft bridge. */
export const WEBPAGE_EMBED_PAGE = '/embed-viewer.html';
export const WebpageEmbedIpc = {
  Prepare: 'webpage-embed:prepare',
  Release: 'webpage-embed:release',
  Ready: 'webpage-embed:ready',
  RetryProxy: 'webpage-embed:retry-proxy',
  ProxyState: 'webpage-embed:proxy-state',
  Event: 'webpage-embed:event',
  NativeFailure: 'webpage-embed:native-failure',
} as const;

export interface WebpageEmbedProxyState {
  generation: number;
  status: 'pending' | 'ready' | 'failed';
}
export interface WebpageEmbedRequest {
  mountId: string;
  sessionKey: string;
  sessionId?: string;
  url?: string;
  ref?: string;
}
export interface WebpageEmbedMount {
  mountId: string;
  partition: string;
  viewerUrl: string;
}
export interface WebpageEmbedInitialization {
  mountId: string;
  targetUrl: string;
  proxy: WebpageEmbedProxyState;
}
export const WEBPAGE_EMBED_OPEN_LINK_EVENT = 'open-link';
export interface WebpageEmbedStateEvent {
  mountId: string;
  type: 'initialized' | 'failure' | 'proxy-pending' | 'proxy-ready' | 'proxy-failed';
}
export type WebpageEmbedEvent = WebpageEmbedStateEvent | {
  mountId: string;
  type: typeof WEBPAGE_EMBED_OPEN_LINK_EVENT;
  url: string;
};
export interface WebpageEmbedViewerBridge {
  initialize: () => Promise<WebpageEmbedInitialization>;
  onProxyState: (listener: (value: WebpageEmbedProxyState) => void) => () => void;
  onNativeFailure: (listener: () => void) => () => void;
  emit: (event: WebpageEmbedStateEvent) => void;
}
export interface WebpageEmbedApi extends WebpageEmbedSettingsApi {
  prepare: (input: WebpageEmbedRequest) => Promise<WebpageEmbedMount>;
  release: (mountId: string) => Promise<void>;
  retryProxy: (mountId: string) => Promise<void>;
  onEvent: (listener: (event: WebpageEmbedEvent) => void) => () => void;
}

export const isWebpageEmbedMountId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(value);
