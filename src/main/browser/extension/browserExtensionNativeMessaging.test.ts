import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  browserExtensionRendezvousPath,
  clearBrowserExtensionAppServer,
  publishBrowserExtensionAppServer,
} from './browserExtensionNativeMessaging';

describe('browser extension native messaging rendezvous', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map(directory => fs.promises.rm(directory, { force: true, recursive: true })),
    );
  });

  it('publishes the dynamic app-server URL and removes only the current process entry', async () => {
    const userDataPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-native-host-'));
    temporaryDirectories.push(userDataPath);
    const localAppServerUrl = `ws://127.0.0.1:41234/app-server?token=${'a'.repeat(64)}`;

    await publishBrowserExtensionAppServer(userDataPath, { localAppServerUrl });

    const rendezvousPath = browserExtensionRendezvousPath(userDataPath);
    await expect(fs.promises.readFile(rendezvousPath, 'utf8')).resolves.toBe(
      JSON.stringify({ localAppServerUrl, pid: process.pid, protocolVersion: 2 }),
    );

    await clearBrowserExtensionAppServer(userDataPath);
    await expect(fs.promises.stat(rendezvousPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove a rendezvous owned by another process', async () => {
    const userDataPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-native-host-'));
    temporaryDirectories.push(userDataPath);
    const rendezvousPath = browserExtensionRendezvousPath(userDataPath);
    await fs.promises.mkdir(path.dirname(rendezvousPath), { recursive: true });
    await fs.promises.writeFile(
      rendezvousPath,
      JSON.stringify({
        localAppServerUrl: `ws://127.0.0.1:41234/app-server?token=${'b'.repeat(64)}`,
        pid: 2_147_483_647,
        protocolVersion: 2,
      }),
      'utf8',
    );

    await clearBrowserExtensionAppServer(userDataPath);

    await expect(fs.promises.stat(rendezvousPath)).resolves.toBeDefined();
  });
});
