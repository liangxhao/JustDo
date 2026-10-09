import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  BROWSER_EXTENSION_ID,
  BROWSER_EXTENSION_NATIVE_HOST,
  type BrowserExtensionAppServerCapability,
} from './browserExtensionChatServer';

const execFileAsync = promisify(execFile);
const APP_SERVER_PROTOCOL_VERSION = 2;
export const BROWSER_EXTENSION_RESTART_SWITCH = '--justdo-browser-extension-restart-app-server';

type Rendezvous = BrowserExtensionAppServerCapability & {
  pid: number;
  protocolVersion: number;
};

const nativeMessagingDirectory = (userDataPath: string): string =>
  path.join(userDataPath, 'browser-extension');

export const browserExtensionRendezvousPath = (userDataPath: string): string =>
  path.join(nativeMessagingDirectory(userDataPath), 'app-server.json');

const nativeHostManifestPath = (userDataPath: string): string =>
  path.join(nativeMessagingDirectory(userDataPath), `${BROWSER_EXTENSION_NATIVE_HOST}.json`);

const nativeHostConfigPath = (userDataPath: string): string =>
  path.join(nativeMessagingDirectory(userDataPath), 'native-host.config.json');

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const parseRendezvous = (value: unknown): Rendezvous | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.localAppServerUrl !== 'string' ||
    typeof record.pid !== 'number' ||
    record.protocolVersion !== APP_SERVER_PROTOCOL_VERSION
  ) {
    return null;
  }
  try {
    const url = new URL(record.localAppServerUrl);
    if (
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/app-server' ||
      !/^[0-9a-f]{64}$/u.test(url.searchParams.get('token') ?? '')
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return record as unknown as Rendezvous;
};

const readRendezvous = async (userDataPath: string): Promise<Rendezvous | null> => {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(browserExtensionRendezvousPath(userDataPath), 'utf8'),
    ) as unknown;
    const rendezvous = parseRendezvous(parsed);
    return rendezvous && isProcessAlive(rendezvous.pid) ? rendezvous : null;
  } catch {
    return null;
  }
};

export const publishBrowserExtensionAppServer = async (
  userDataPath: string,
  capability: BrowserExtensionAppServerCapability,
): Promise<void> => {
  const directory = nativeMessagingDirectory(userDataPath);
  await fs.promises.mkdir(directory, { recursive: true });
  const target = browserExtensionRendezvousPath(userDataPath);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(
    temporary,
    JSON.stringify({
      ...capability,
      pid: process.pid,
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    } satisfies Rendezvous),
    { encoding: 'utf8', mode: 0o600 },
  );
  await fs.promises.rename(temporary, target);
};

export const clearBrowserExtensionAppServer = async (userDataPath: string): Promise<void> => {
  const current = await readRendezvous(userDataPath);
  if (current?.pid !== process.pid) return;
  await fs.promises.rm(browserExtensionRendezvousPath(userDataPath), { force: true });
};

export const registerBrowserExtensionNativeHost = async (
  userDataPath: string,
  executablePath: string,
  nativeHostExecutablePath: string,
): Promise<void> => {
  if (process.platform !== 'win32') return;
  await fs.promises.access(nativeHostExecutablePath, fs.constants.X_OK);
  const directory = nativeMessagingDirectory(userDataPath);
  await fs.promises.mkdir(directory, { recursive: true });
  const manifestPath = nativeHostManifestPath(userDataPath);
  await fs.promises.writeFile(
    nativeHostConfigPath(userDataPath),
    JSON.stringify(
      {
        executableArguments: [],
        executablePath,
        rendezvousPath: browserExtensionRendezvousPath(userDataPath),
        workingDirectory: path.dirname(executablePath),
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.promises.writeFile(
    manifestPath,
    JSON.stringify(
      {
        allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`],
        description: 'Browser native messaging host',
        name: BROWSER_EXTENSION_NATIVE_HOST,
        path: nativeHostExecutablePath,
        type: 'stdio',
      },
      null,
      2,
    ),
    'utf8',
  );
  const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BROWSER_EXTENSION_NATIVE_HOST}`;
  await execFileAsync(
    'reg.exe',
    ['ADD', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'],
    { windowsHide: true },
  );
};
