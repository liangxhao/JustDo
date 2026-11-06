import net from 'node:net';
import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
const require = createRequire(import.meta.url);
const { findFreePort } = require('../../scripts/electron/find-free-port.cjs');

test('avoids a port occupied on IPv6 and returns a real ephemeral port', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '::1', port: 0 }, resolve);
  });
  try {
    const occupied = (server.address() as net.AddressInfo).port;
    expect(await findFreePort(occupied)).not.toBe(occupied);
    expect(await findFreePort(0)).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
});
