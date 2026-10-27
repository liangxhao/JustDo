export const WEBPAGE_EMBED_CONTEXT_REQUEST = 'webpage-embed-context-request';

/** Connection/presentation binding only; no Widget, tool or draft capabilities. */
export interface WebpageEmbedContext {
  sessionKey: string;
  sessionId?: string;
  presentationScope?: string;
  presentationOwner?: object;
  isCurrent: () => boolean;
  openLink?: (url: string) => void;
}
