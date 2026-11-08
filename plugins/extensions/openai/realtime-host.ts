// Full registration composes the same host operations supplied to a cold capability catalog.
import type { PluginCapabilityCatalogHostContext } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveProviderRequestHeaders } from 'openclaw/plugin-sdk/provider-http';
import { createDebugProxyWebSocketAgent, resolveDebugProxySettings } from 'openclaw/plugin-sdk/proxy-capture';
import { createRealtimeTranscriptionWebSocketSession } from 'openclaw/plugin-sdk/realtime-transcription-session';
import { warn } from 'openclaw/plugin-sdk/runtime-env';

export const openAIRealtimeHost = {
  resolveProviderRequestHeaders,
  createRealtimeTranscriptionWebSocketSession,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
  warn,
} satisfies Pick<
  PluginCapabilityCatalogHostContext,
  | 'resolveProviderRequestHeaders'
  | 'createRealtimeTranscriptionWebSocketSession'
  | 'createDebugProxyWebSocketAgent'
  | 'resolveDebugProxySettings'
  | 'warn'
>;

export type OpenAIRealtimeHost = typeof openAIRealtimeHost;
