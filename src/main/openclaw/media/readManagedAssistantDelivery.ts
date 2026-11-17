import { parseManagedOutgoingMediaSource } from '../../../shared/openclaw/assistantMedia';
import type { OpenClawEngineManager } from '../runtime/openclawEngineManager';

const MAX_DELIVERY_BYTES = 64 * 1024 * 1024;
const DELIVERY_TIMEOUT_MS = 30_000;

export interface ManagedAssistantDeliveryRequest {
  source: string;
  sessionKey: string;
  acceptedMimeTypes: readonly string[];
}

export interface ManagedAssistantDelivery {
  mimeType: string;
  filename?: string;
  bytes: Buffer;
  assertCurrent: () => void;
}

function readFilename(response: Response): string | undefined {
  // The native route emits filename* as RFC 6266 UTF-8, alongside an ASCII fallback.
  const filename = /;\s*filename\*=UTF-8''([^;\s]+)/iu.exec(
    response.headers.get('content-disposition') ?? '',
  )?.[1];
  try {
    return filename ? decodeURIComponent(filename) : undefined;
  } catch {
    return undefined;
  }
}

/** Fetch one native outgoing delivery. Only Main can supply the owner credential. */
export async function readManagedAssistantDelivery(
  manager: OpenClawEngineManager,
  request: ManagedAssistantDeliveryRequest,
): Promise<ManagedAssistantDelivery> {
  const { source, sessionKey, acceptedMimeTypes } = request;
  if (!parseManagedOutgoingMediaSource(source, sessionKey)) {
    throw new Error('Delivery does not match the native conversation.');
  }
  const generation = manager.getGatewayLifecycleGeneration();
  const assertCurrent = () => {
    if (manager.getStatus().phase !== 'running' ||
        manager.getGatewayLifecycleGeneration() !== generation) {
      throw new Error('Gateway changed during the delivery read.');
    }
  };
  assertCurrent();
  const { port, token } = manager.getGatewayConnectionInfo();
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !token) {
    throw new Error('Gateway connection is unavailable.');
  }
  const response = await fetch(new URL(source, 'http://127.0.0.1:' + port), {
    headers: {
      Accept: acceptedMimeTypes.join(', '),
      Authorization: 'Bearer ' + token,
      'x-openclaw-requester-session-key': sessionKey,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  const mimeType =
    response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  const contentLength = Number(response.headers.get('content-length'));
  if (!response.ok || !response.body || !acceptedMimeTypes.includes(mimeType) ||
      contentLength > MAX_DELIVERY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Unsupported or unavailable Gateway delivery.');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    assertCurrent();
    for (;;) {
      const { done, value } = await reader.read();
      assertCurrent();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DELIVERY_BYTES) throw new Error('Gateway delivery is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const filename = readFilename(response);
  return {
    mimeType,
    ...(filename ? { filename } : {}),
    bytes: Buffer.concat(chunks, total),
    assertCurrent,
  };
}
