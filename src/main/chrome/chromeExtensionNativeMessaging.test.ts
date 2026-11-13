import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chromeExtensionRendezvousPath,
  clearChromeExtensionAppServer,
  publishChromeExtensionAppServer,
  registerChromeExtensionNativeHost,
} from './chromeExtensionNativeMessaging';

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

describe('Chrome extension native messaging rendezvous', () => {
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
    'registers the helper against discovery published in the active data directory',
    async () => {
      const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'browser-native-host-'),
      );
      temporaryDirectories.push(directory);
      const userDataPath = path.join(directory, 'moved profile');
      const helperPath = path.join(directory, 'native-host.exe');
      const localAppServerUrl = `ws://127.0.0.1:41234/app-server?token=${'a'.repeat(64)}`;
      await fs.promises.writeFile(helperPath, 'fixture');

      await registerChromeExtensionNativeHost({
        userDataPath,
        appDataPath: path.join(directory, 'app-data'),
        ownsDesktopProfile: true,
        developmentExecutablePath: helperPath,
      });
      await publishChromeExtensionAppServer(userDataPath, { localAppServerUrl });

      const registrationDirectory = path.join(userDataPath, 'chrome-extension');
      const manifestPath = path.join(registrationDirectory, 'app.chrome_extension.json');
      const configPath = path.join(registrationDirectory, 'native-host.config.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      expect(config).toEqual({
        allowAppLaunch: false,
        rendezvousPath: chromeExtensionRendezvousPath(userDataPath),
      });
      expect(JSON.parse(await fs.promises.readFile(config.rendezvousPath, 'utf8'))).toMatchObject({
        localAppServerUrl,
        pid: process.pid,
      });
      expect(JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'))).toMatchObject({
        path: helperPath,
        allowed_origins: ['chrome-extension://jboajogplelmaahjbomgflnfngpolgcb/'],
      });
      expect(execFile).toHaveBeenCalledWith(
        'reg.exe',
        expect.arrayContaining(['/d', manifestPath]),
        { windowsHide: true },
        expect.any(Function),
      );
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'preserves the current Chrome registration when an independent development profile starts',
    async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'browser-native-host-'));
      temporaryDirectories.push(directory);
      const helperPath = path.join(directory, 'native-host.exe');
      await fs.promises.writeFile(helperPath, 'fixture');

      await registerChromeExtensionNativeHost({
        userDataPath: path.join(directory, 'independent profile'),
        appDataPath: path.join(directory, 'app-data'),
        developmentExecutablePath: helperPath,
      });

      expect(execFile).not.toHaveBeenCalled();
    },
  );

  it('publishes the dynamic app-server URL and removes only the current process entry', async () => {
    const userDataPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-native-host-'));
    temporaryDirectories.push(userDataPath);
    const localAppServerUrl = `ws://127.0.0.1:41234/app-server?token=${'a'.repeat(64)}`;

    await publishChromeExtensionAppServer(userDataPath, { localAppServerUrl });

    const rendezvousPath = chromeExtensionRendezvousPath(userDataPath);
    await expect(fs.promises.readFile(rendezvousPath, 'utf8')).resolves.toBe(
      JSON.stringify({ localAppServerUrl, pid: process.pid, protocolVersion: 4 }),
    );

    await clearChromeExtensionAppServer(userDataPath);
    await expect(fs.promises.stat(rendezvousPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove a rendezvous owned by another process', async () => {
    const userDataPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'justdo-native-host-'));
    temporaryDirectories.push(userDataPath);
    const rendezvousPath = chromeExtensionRendezvousPath(userDataPath);
    await fs.promises.mkdir(path.dirname(rendezvousPath), { recursive: true });
    await fs.promises.writeFile(
      rendezvousPath,
      JSON.stringify({
        localAppServerUrl: `ws://127.0.0.1:41234/app-server?token=${'b'.repeat(64)}`,
        pid: 2_147_483_647,
        protocolVersion: 4,
      }),
      'utf8',
    );

    await clearChromeExtensionAppServer(userDataPath);

    await expect(fs.promises.stat(rendezvousPath)).resolves.toBeDefined();
  });
});
