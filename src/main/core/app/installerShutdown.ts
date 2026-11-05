import { createServer, type Socket } from 'node:net';

const QUIT_REQUEST = 'quit-for-update\n';
const QUIT_ACCEPTED = 'accepted\n';
const REQUEST_TIMEOUT_MS = 1_000;

// The PID identifies an existing Main, independently of profile and elevation.
// Keep the default pipe ACL: never grant other users write access.
export const installerShutdownPipe = (pid: number): string =>
  `\\\\.\\pipe\\desktop-installer-shutdown-${pid}`;

export const createInstallerShutdownListener = (
  onQuit: () => void,
  pipePath = installerShutdownPipe(process.pid),
): { ready: Promise<void>; markQuitting: () => void; stop: () => void } => {
  const sockets = new Set<Socket>();
  let stopped = false;
  let requested = false;
  let quitDispatched = false;
  const server = createServer(socket => {
    if (stopped) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const timeout = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
    socket.on('close', () => {
      clearTimeout(timeout);
      sockets.delete(socket);
    });
    socket.on('error', () => socket.destroy());
    let request = '';
    let accepted = false;
    socket.on('data', chunk => {
      if (accepted || chunk.length + request.length > QUIT_REQUEST.length) {
        socket.destroy();
        return;
      }
      request += chunk.toString('utf8');
      if (!QUIT_REQUEST.startsWith(request)) {
        socket.destroy();
        return;
      }
      if (request !== QUIT_REQUEST) return;
      accepted = true;
      const shouldQuit = !requested;
      requested = true;
      const dispatchQuit = (): void => {
        if (!shouldQuit || stopped || quitDispatched) return;
        quitDispatched = true;
        onQuit();
      };
      // Flush the ACK first; a disconnected requester cannot cancel an admitted
      // quit. Keep acknowledging retries throughout Main's resource cleanup.
      socket.once('close', dispatchQuit);
      socket.end(QUIT_ACCEPTED, dispatchQuit);
    });
  });
  server.maxConnections = 8;
  server.unref();
  const stop = (): void => {
    stopped = true;
    if (server.listening) server.close();
    for (const socket of sockets) socket.destroy();
  };
  const ready = new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(pipePath, () => {
      if (stopped) server.close();
      resolve();
    });
  });
  return {
    ready,
    markQuitting: () => { requested = true; quitDispatched = true; },
    stop,
  };
};
