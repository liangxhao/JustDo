import net from 'net';

const tryBindLoopbackPort = (port: number): Promise<number | null> => {
  return new Promise(resolve => {
    const server = net.createServer();
    let settled = false;

    const done = (result: number | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    server.once('error', () => done(null));
    server.once('listening', () => {
      const address = server.address();
      const boundPort = address && typeof address !== 'string' ? address.port : null;
      server.close(error => done(error ? null : boundPort));
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
};

export const isLoopbackPortAvailable = async (port: number): Promise<boolean> => {
  return (await tryBindLoopbackPort(port)) !== null;
};

export const findAvailableLoopbackPort = async (
  preferredPorts: Iterable<number>,
): Promise<number | null> => {
  for (const port of new Set(preferredPorts)) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const availablePort = await tryBindLoopbackPort(port);
    if (availablePort !== null) return availablePort;
  }

  // Let the OS choose outside the preferred range. Windows can reserve large
  // contiguous port ranges that are not reported as listening sockets.
  return await tryBindLoopbackPort(0);
};
