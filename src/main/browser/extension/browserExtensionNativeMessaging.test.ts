import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  browserExtensionRendezvousPath,
  clearBrowserExtensionAppServer,
  publishBrowserExtensionAppServer,
  registerBrowserExtensionNativeHost,
} from './browserExtensionNativeMessaging';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, '', ''),
  ),
}));

describe('browser extension native messaging rendezvous', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map(directory => fs.promises.rm(directory, { force: true, recursive: true })),
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'registers packaged discovery without an application launch target',
    async () => {
      const userDataPath = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'browser-native-host-'),
      );
      temporaryDirectories.push(userDataPath);
      const helperPath = path.join(userDataPath, 'native-host.exe');
      await fs.promises.writeFile(helperPath, 'fixture');

      await registerBrowserExtensionNativeHost(userDataPath, helperPath);

      const configPath = path.join(userDataPath, 'browser-extension', 'native-host.config.json');
      expect(JSON.parse(await fs.promises.readFile(configPath, 'utf8'))).toEqual({
        allowAppLaunch: false,
        rendezvousPath: browserExtensionRendezvousPath(userDataPath),
      });
      expect(execFile).toHaveBeenCalledWith(
        'reg.exe',
        expect.any(Array),
        { windowsHide: true },
        expect.any(Function),
      );
    },
  );

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
