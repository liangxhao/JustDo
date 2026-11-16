/** Native Gateway artifact metadata. General lists intentionally omit image-only pagination. */
export const ArtifactRpcMethod = {
  LIST: 'artifacts.list',
  DOWNLOAD: 'artifacts.download',
} as const;

const ARTIFACT_IMAGE_MIME = /^(?:image\/(?:apng|avif|bmp|gif|jpeg|jpg|png|svg\+xml|webp|x-icon|vnd\.microsoft\.icon))$/u;

export function readTranscriptImageArtifactId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 8192 &&
    /^artifact_transcript_image_[a-zA-Z0-9_-]+$/u.test(value)
    ? value
    : undefined;
}

export function readArtifactImageMime(value: unknown): string | undefined {
  const mime = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
  return ARTIFACT_IMAGE_MIME.test(mime) ? mime : undefined;
}

export interface TranscriptImageArtifact {
  readonly id: string;
  readonly messageSeq?: number;
  readonly mimeType?: string;
  readonly label?: string;
}

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

export interface ArtifactDownloadResult {
  artifact: ArtifactSummary;
  encoding?: 'base64';
  data?: string;
}
