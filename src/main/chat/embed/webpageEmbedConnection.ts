import type { GatewayClientLike } from '../../engine/gateway/types';
import { captureHostedCanvasBinding } from './hostedCanvasSurface';
import type { WebpageEmbedConnection } from './webpageEmbedMounts';

type Runtime = {
  getGatewayClient(): GatewayClientLike | null;
  getGatewayClientGeneration(): number;
};
type Manager = {
  getStateDir(): string;
  getGatewayConnectionInfo(): { url: string | null };
};

export function captureWebpageEmbedConnection(
  getRuntime: () => Runtime | null | undefined,
  manager: Manager,
): WebpageEmbedConnection | null {
  const runtime = getRuntime();
  const client = runtime?.getGatewayClient();
  const rawUrl = manager.getGatewayConnectionInfo().url;
  if (!runtime || !client || !rawUrl) return null;
  const generation = runtime.getGatewayClientGeneration();
  const profileId = manager.getStateDir();
  const url = new URL(rawUrl);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return {
    client,
    gatewayOrigin: url.origin,
    canvas: captureHostedCanvasBinding(client, generation, profileId),
    isCurrent: () =>
      getRuntime() === runtime &&
      runtime.getGatewayClient() === client &&
      runtime.getGatewayClientGeneration() === generation &&
      manager.getStateDir() === profileId,
  };
}
