import {
  type ArtifactDownloadResult,
  ArtifactRpcMethod,
  readArtifactImageMime,
  type TranscriptImageArtifact,
} from '@shared/openclaw/artifacts';

import type { GatewayClient } from '../client';

export interface LoadedToolImage {
  url: string;
  label?: string;
}

export type ToolImageArtifactReader = (
  image: TranscriptImageArtifact,
  signal: AbortSignal,
) => Promise<LoadedToolImage | null>;

export function createToolImageArtifactReader(
  client: Pick<GatewayClient, 'request'>,
  sessionKey: string,
  isCurrent: () => boolean,
): ToolImageArtifactReader {
  // A single expanded result can contain several full-size images.
  const lanes = [Promise.resolve(), Promise.resolve()];
  let nextLane = 0;
  return (image, signal) => {
    const lane = nextLane;
    nextLane = (nextLane + 1) % lanes.length;
    const pending = lanes[lane].then(async () => {
      if (signal.aborted || !isCurrent()) return null;
      const result = await client.request<ArtifactDownloadResult>(
        ArtifactRpcMethod.DOWNLOAD,
        { sessionKey, artifactId: image.id },
        { signal, timeoutMs: 30_000 },
      );
      if (signal.aborted || !isCurrent()) return null;
      const { artifact, encoding, data } = result ?? {};
      const mimeType = readArtifactImageMime(artifact?.mimeType);
      if (
        artifact?.id !== image.id ||
        artifact?.sessionKey !== sessionKey ||
        artifact?.type !== 'image' ||
        (image.messageSeq !== undefined && artifact.messageSeq !== image.messageSeq) ||
        !mimeType ||
        (image.mimeType && image.mimeType !== mimeType) ||
        encoding !== 'base64' ||
        typeof data !== 'string' ||
        data.length % 4 !== 0 ||
        !/^[a-zA-Z0-9+/]+={0,2}$/u.test(data)
      ) return null;
      return {
        url: `data:${mimeType};base64,${data}`,
        label: image.label,
      };
    });
    lanes[lane] = pending.then(() => {}, () => {});
    return pending;
  };
}
