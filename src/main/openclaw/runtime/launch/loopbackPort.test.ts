import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';

import { findAvailableLoopbackPort, isLoopbackPortAvailable } from './loopbackPort';

const servers: net.Server[] = [];

const listenOnRandomLoopbackPort = async (): Promise<net.Server> => {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, resolve);
  });
  return server;
};

const getServerPort = (server: net.Server): number => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an IP socket address');
  return address.port;
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('findAvailableLoopbackPort', () => {
  it('uses an available preferred port', async () => {
    const server = await listenOnRandomLoopbackPort();
    const preferredPort = getServerPort(server);
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    servers.splice(servers.indexOf(server), 1);

    expect(await findAvailableLoopbackPort([preferredPort])).toBe(preferredPort);
  });

  it('falls back to an OS-assigned port when preferred ports are unavailable', async () => {
    const server = await listenOnRandomLoopbackPort();
    const occupiedPort = getServerPort(server);

    const resolvedPort = await findAvailableLoopbackPort([occupiedPort, occupiedPort]);

    expect(resolvedPort).toBeTypeOf('number');
    expect(resolvedPort).not.toBe(occupiedPort);
    expect(resolvedPort).toBeGreaterThan(0);
  });

  it('reports an occupied loopback port as unavailable', async () => {
    const server = await listenOnRandomLoopbackPort();

    expect(await isLoopbackPortAvailable(getServerPort(server))).toBe(false);
  });
});
