import { ensureAppServer } from './app-server-background.js';

// Transport only. The upstream controller owns coalescing, opt-out, custody
// checks and applying the validated native pairing result.
export async function requestLocalBootstrap(_chromeApi, request) {
  const { localAppServerUrl } = await ensureAppServer(false, 'browser-bootstrap');
  return new Promise(resolve => {
    const socket = new WebSocket(localAppServerUrl);
    const initId = `relay:init:${request.nonce}`;
    const pairId = `relay:pair:${request.nonce}`;
    let settled = false;
    const finish = response => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(response);
    };
    const unavailable = () => finish({ v: 1, ok: false, code: 'pairing_unavailable' });
    const timer = setTimeout(unavailable, 30_000);
    socket.addEventListener('error', unavailable);
    socket.addEventListener('close', unavailable);
    socket.addEventListener('open', () => {
      if (settled) return;
      try {
        socket.send(
          JSON.stringify({
            id: initId,
            method: 'initialize',
            params: {
              clientInfo: {
                name: 'justdo-browser-bootstrap',
                version: chrome.runtime.getManifest().version,
              },
            },
          }),
        );
      } catch {
        unavailable();
      }
    });
    socket.addEventListener('message', event => {
      if (settled) return;
      let response;
      try {
        response = JSON.parse(String(event.data));
      } catch {
        unavailable();
        return;
      }
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        unavailable();
        return;
      }
      if (response.id !== initId && response.id !== pairId) return;
      if (response.error) {
        unavailable();
      } else if (response.id === initId) {
        try {
          socket.send(JSON.stringify({ method: 'initialized' }));
          socket.send(JSON.stringify({ id: pairId, method: 'browser/extension/pair', params: {} }));
        } catch {
          unavailable();
        }
      } else if (typeof response.result?.pairingString === 'string') {
        finish({
          v: 1,
          ok: true,
          nonce: request.nonce,
          pairingString: response.result.pairingString,
        });
      } else {
        unavailable();
      }
    });
  });
}
