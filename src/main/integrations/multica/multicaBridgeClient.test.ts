import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { runMulticaBridgeClient } from './multicaBridgeClient';
import {
  encodeBridgeMessage,
  getMulticaBridgeEndpoint,
  MULTICA_BRIDGE_METADATA_FILE,
  MULTICA_BRIDGE_PROTOCOL_VERSION,
} from './multicaBridgeProtocol';

describe('Multica bridge client', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  test('uses the timeout only while connecting and permits long-running requests', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-bridge-client-'));
    directories.push(userDataPath);
    const multicaDirectory = path.join(userDataPath, 'multica');
    fs.mkdirSync(multicaDirectory);
    const endpoint = getMulticaBridgeEndpoint(userDataPath);
    const server = net.createServer(socket => {
      socket.once('data', () => {
        setTimeout(() => {
          socket.end(encodeBridgeMessage({ type: 'exit', code: 0 }));
        }, 50);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    fs.writeFileSync(
      path.join(multicaDirectory, MULTICA_BRIDGE_METADATA_FILE),
      JSON.stringify({
        version: MULTICA_BRIDGE_PROTOCOL_VERSION,
        endpoint,
        token: 'test-token',
        pid: process.pid,
      }),
    );

    try {
      await expect(runMulticaBridgeClient(userDataPath, ['--version'], 10)).resolves.toBe(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
