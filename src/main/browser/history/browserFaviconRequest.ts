import { net, type Session } from 'electron';

import { getBrowserProxyCredentials } from '../../core/network/systemProxyPreference';

const MAX_FAVICON_BYTES = 256 * 1024;
const PROXY_AUTH_FETCH_ERRORS = /\bERR_(?:TUNNEL_CONNECTION_FAILED|PROXY_AUTH_UNSUPPORTED)\b/u;

const responseHeaders = (values: Record<string, string | string[]>): Headers => {
  const headers = new Headers();
  for (const [name, entries] of Object.entries(values)) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) headers.append(name, entry);
  }
  return headers;
};

// net.fetch cannot answer an uncached proxy authentication challenge. Keep the
// fallback restricted to an idempotent image GET in this same browser session.
const fetchWithProxyAuthentication = (
  browserSession: Session,
  url: string,
  signal: AbortSignal,
): Promise<Response> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const request = net.request({
      method: 'GET',
      url,
      session: browserSession,
      credentials: 'include',
      redirect: 'manual',
    });
    let settled = false;
    let providedCredentials = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const finish = (response: Response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      request.abort();
    };
    const abort = () => fail(signal.reason ?? new Error('Favicon request was aborted.'));
    signal.addEventListener('abort', abort, { once: true });
    request.on('login', (authInfo, callback) => {
      const credentials = getBrowserProxyCredentials();
      const host = authInfo.host.replace(/^\[|\]$/gu, '').toLowerCase();
      if (
        settled ||
        signal.aborted ||
        providedCredentials ||
        !authInfo.isProxy ||
        !credentials ||
        host !== credentials.host ||
        authInfo.port !== credentials.port
      ) {
        callback();
        return;
      }
      providedCredentials = true;
      callback(credentials.username, credentials.password);
    });
    request.on('redirect', (status, _method, _url, values) => {
      try {
        finish(new Response(null, { status, headers: responseHeaders(values) }));
        request.abort();
      } catch (error) {
        fail(error);
      }
    });
    request.on('response', response => {
      if (settled) return;
      let headers: Headers;
      try {
        headers = responseHeaders(response.headers);
      } catch (error) {
        fail(error);
        return;
      }
      if (Number(headers.get('content-length')) > MAX_FAVICON_BYTES) {
        fail(new Error('Favicon response exceeds the size limit.'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', chunk => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_FAVICON_BYTES) {
          fail(new Error('Favicon response exceeds the size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        try {
          const body = [204, 205, 304].includes(response.statusCode)
            ? null
            : new Uint8Array(Buffer.concat(chunks));
          finish(new Response(body, { status: response.statusCode, headers }));
        } catch (error) {
          fail(error);
        }
      });
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('Favicon response was interrupted.')));
    });
    request.on('error', fail);
    // Electron can emit request.close before the queued response/login callbacks.
    // Only an error, abort, or the original deadline establishes request failure.
    request.on('abort', () => fail(new Error('Favicon request was aborted.')));
    request.end();
  });

export async function fetchBrowserFavicon(
  browserSession: Session,
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await browserSession.fetch(url, {
      credentials: 'include',
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    if (
      signal.aborted ||
      !getBrowserProxyCredentials() ||
      !(error instanceof Error && PROXY_AUTH_FETCH_ERRORS.test(error.message))
    )
      throw error;
    return fetchWithProxyAuthentication(browserSession, url, signal);
  }
  if (response.status !== 407 || signal.aborted || !getBrowserProxyCredentials()) return response;
  await response.body?.cancel();
  return fetchWithProxyAuthentication(browserSession, url, signal);
}
