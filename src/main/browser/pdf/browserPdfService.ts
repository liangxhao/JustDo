import { session } from 'electron';

import {
  browserPartitionForProfile,
  type BrowserPdfLoadRequest,
  type BrowserPdfLoadResult,
  isBrowserAgentProfile,
} from '../../../shared/browser/browser';
import { isAllowedBrowserPanelUrl } from '../../core/window/browserPanelSecurity';

export const MAX_BROWSER_PDF_BYTES = 64 * 1024 * 1024;
export const BROWSER_PDF_TIMEOUT_MS = 60_000;

export const isBrowserPdfLoadRequest = (value: unknown): value is BrowserPdfLoadRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.requestId === 'string' &&
    record.requestId.length > 0 &&
    record.requestId.length <= 128 &&
    typeof record.url === 'string' &&
    /^https?:\/\//iu.test(record.url) &&
    isAllowedBrowserPanelUrl(record.url) &&
    record.url !== 'about:blank' &&
    isBrowserAgentProfile(record.profile)
  );
};

const hasPdfSignature = (data: Uint8Array): boolean =>
  data.length >= 5 && new TextDecoder().decode(data.subarray(0, 5)) === '%PDF-';

const readBoundedBody = async (response: Response): Promise<Uint8Array | null> => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BROWSER_PDF_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    return data.byteLength <= MAX_BROWSER_PDF_BYTES ? data : null;
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BROWSER_PDF_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
};

export const loadBrowserPdf = async (
  request: BrowserPdfLoadRequest,
  cancellation?: AbortSignal,
): Promise<BrowserPdfLoadResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BROWSER_PDF_TIMEOUT_MS);
  const abort = () => controller.abort();
  cancellation?.addEventListener('abort', abort, { once: true });
  if (cancellation?.aborted) controller.abort();
  try {
    const browserSession = session.fromPartition(browserPartitionForProfile(request.profile));
    const response = await browserSession.fetch(request.url, {
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { success: false, errorCode: 'load_failed' };
    }
    const data = await readBoundedBody(response);
    if (!data) return { success: false, errorCode: 'too_large' };
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/pdf') && !hasPdfSignature(data)) {
      return { success: false, errorCode: 'not_pdf' };
    }
    return { success: true, data };
  } catch {
    return { success: false, errorCode: 'load_failed' };
  } finally {
    clearTimeout(timeout);
    cancellation?.removeEventListener('abort', abort);
  }
};
