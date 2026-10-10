/** Native Gateway artifact metadata. General lists intentionally omit image-only pagination. */
export const ArtifactRpcMethod = {
  LIST: 'artifacts.list',
} as const;

export interface ArtifactSummary {
  id: string;
  type: string;
  title: string;
  mimeType?: string;
  sizeBytes?: number;
  sessionKey?: string;
  runId?: string;
  messageSeq?: number;
  source?: string;
  image?: { url: string };
  download: { mode: 'bytes' | 'url' | 'unsupported' };
}

export interface ArtifactsListResult {
  artifacts: ArtifactSummary[];
  omittedOversized?: boolean;
}
