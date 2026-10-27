export const OpenClawAssistantMediaIpc = {
  ReadDataUrl: 'openclaw:assistantMedia:readDataUrl',
  PreparePlayback: 'openclaw:assistantMedia:preparePlayback',
  ReleasePlayback: 'openclaw:assistantMedia:releasePlayback',
} as const;

const MANAGED_OUTGOING_MEDIA_SOURCE =
  /^\/api\/chat\/media\/outgoing\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/full$/u;

/** Parse only the canonical session-bound route supplied by native chat history. */
export function parseManagedOutgoingMediaSource(
  source: unknown,
  expectedSessionKey?: string,
): string | null {
  if (typeof source !== 'string' || source.length > 2_048) return null;
  const match = MANAGED_OUTGOING_MEDIA_SOURCE.exec(source);
  if (!match) return null;
  try {
    const sessionKey = decodeURIComponent(match[1]);
    return sessionKey &&
      sessionKey.length <= 512 &&
      !/[\u0000-\u001f\u007f]/u.test(sessionKey) &&
      !/%[0-9a-f]{2}/iu.test(sessionKey) &&
      encodeURIComponent(sessionKey) === match[1] &&
      (expectedSessionKey === undefined || expectedSessionKey === sessionKey)
      ? sessionKey
      : null;
  } catch {
    return null;
  }
}

export interface OpenClawAssistantMediaPlaybackRequest {
  source: string;
  sessionKey: string;
  kind: 'audio' | 'video';
}

export type OpenClawAssistantMediaPlaybackResult =
  | { success: true; url: string }
  | { success: false; error: string };

export interface OpenClawAssistantMediaReleaseRequest {
  url: string;
}

export type OpenClawAssistantMediaReleaseResult = { success: boolean };

/** The fixed workspace document receives only these playback capabilities. */
export interface MediaPlaybackBridge {
  prepareAssistantMediaPlayback: (request: OpenClawAssistantMediaPlaybackRequest) => Promise<OpenClawAssistantMediaPlaybackResult>;
  releaseAssistantMediaPlayback: (request: OpenClawAssistantMediaReleaseRequest) => Promise<OpenClawAssistantMediaReleaseResult>;
}

export interface OpenClawAssistantMediaRequest {
  /** Canonical media://inbound URI or session-bound managed outgoing image route. */
  source: string;
  /** Session scope used by Gateway authorization and verified against outgoing routes. */
  sessionKey: string;
}

export type OpenClawAssistantMediaResult =
  | { success: true; dataUrl: string; mimeType: string }
  | { success: false; error: string };
