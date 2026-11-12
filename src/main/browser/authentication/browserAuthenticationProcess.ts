import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { app, WebContentsView } from 'electron';

import { BROWSER_AUTHENTICATION_SWITCH } from '../../../shared/browser/browserAuthentication';
import {
  normalizeProxySettings,
  ProxyMode,
  type ProxySettings,
} from '../../../shared/network/proxy';
import { isSameBrowserSession } from '../browserSessionIdentity';
import {
  BROWSER_AUTHENTICATION_EXECUTABLE,
  normalizeBrowserAuthenticationEntry,
} from './browserAuthenticationConfig';
import {
  type BrowserAuthenticationCookie,
  browserAuthenticationCookieKey,
  browserAuthenticationCookieUrls,
  matchesBrowserAuthenticationCookie,
  readExistingBrowserAuthenticationCookies,
  validateBrowserAuthenticationCookies,
} from './browserAuthenticationCookies';
import {
  BROWSER_AUTHENTICATION_PROFILE_ENV,
  BROWSER_AUTHENTICATION_PROFILE_PREFIX,
  BROWSER_AUTHENTICATION_TIMEOUT_MS,
  BrowserAuthenticationMessage,
  isBrowserAuthenticationMessage,
} from './browserAuthenticationProtocol';

export type { BrowserAuthenticationCookie } from './browserAuthenticationCookies';

const processes = new Map<AbortController, Promise<BrowserAuthenticationCookie[]>>();
const cookieCommits = new Set<Promise<void>>();
let stopping = false;
let verifiedExecutable: { signature: string; result: Promise<boolean> } | undefined;

function authenticationExecutable(): string | null {
  if (
    stopping ||
    !BROWSER_AUTHENTICATION_EXECUTABLE ||
    process.platform !== 'win32' ||
    !app.isPackaged ||
    basename(process.execPath).toLowerCase() === BROWSER_AUTHENTICATION_EXECUTABLE
  )
    return null;
  const executable = join(dirname(process.execPath), BROWSER_AUTHENTICATION_EXECUTABLE);
  try {
    const alias = lstatSync(executable);
    if (alias.isFile() && alias.size === lstatSync(process.execPath).size) return executable;
  } catch {
    /* This build does not contain the authentication helper. */
  }
  return null;
}

export function isBrowserAuthenticationAvailable(): boolean {
  return authenticationExecutable() !== null;
}

async function executableDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function verifyAuthenticationExecutable(executable: string): Promise<boolean> {
  const original = lstatSync(process.execPath);
  const alias = lstatSync(executable);
  const signature = [original, alias]
    .map(file => `${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`)
    .join('|');
  if (verifiedExecutable?.signature !== signature) {
    verifiedExecutable = {
      signature,
      result: Promise.all([executableDigest(process.execPath), executableDigest(executable)]).then(
        ([left, right]) => left === right,
        () => false,
      ),
    };
  }
  return verifiedExecutable.result;
}

function stopChild(child: ChildProcess): void {
  if (child.connected) child.disconnect();
}

async function runAuthenticationChild(
  executable: string,
  profile: string,
  entry: URL,
  browserProxy: Partial<ProxySettings> | undefined,
  signal: AbortSignal,
): Promise<BrowserAuthenticationCookie[]> {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_FORCE_IS_PACKAGED: '1',
    [BROWSER_AUTHENTICATION_PROFILE_ENV]: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(executable, [BROWSER_AUTHENTICATION_SWITCH], {
    cwd: dirname(executable),
    env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });

  let ready = false;
  let failed = false;
  let cookies: BrowserAuthenticationCookie[] | undefined;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const retire = (): void => {
    if (failed) return;
    failed = true;
    stopChild(child);
    forceStop = setTimeout(() => child.kill(), 2_000);
  };
  const deadline = setTimeout(retire, BROWSER_AUTHENTICATION_TIMEOUT_MS);
  signal.addEventListener('abort', retire, { once: true });
  child.on('error', retire);
  child.on('message', message => {
    if (failed) return;
    if (!isBrowserAuthenticationMessage(message)) return retire();
    if (!ready && message.type === BrowserAuthenticationMessage.Ready) {
      ready = true;
      child.send(
        {
          type: BrowserAuthenticationMessage.Authenticate,
          entryUrl: entry.href,
          browserProxy: normalizeProxySettings(browserProxy, ProxyMode.SYSTEM),
        },
        error => {
          if (error) retire();
        },
      );
    } else if (ready && !cookies && message.type === BrowserAuthenticationMessage.Authenticated) {
      try {
        cookies = validateBrowserAuthenticationCookies(message.cookies, entry);
      } catch {
        retire();
      }
    } else retire();
  });
  try {
    if (signal.aborted) retire();
    const code = await new Promise<number | null>(resolve => child.once('close', resolve));
    signal.throwIfAborted();
    if (failed || code !== 0 || !cookies)
      throw new Error('Browser authentication was not completed.');
    return cookies;
  } finally {
    clearTimeout(deadline);
    clearTimeout(forceStop);
    signal.removeEventListener('abort', retire);
  }
}

export async function authenticateBrowserEntry(
  entryUrl: string,
  browserProxy: Partial<ProxySettings> | undefined,
  signal: AbortSignal,
): Promise<BrowserAuthenticationCookie[]> {
  const normalizedEntry = normalizeBrowserAuthenticationEntry(entryUrl);
  const executable = authenticationExecutable();
  if (!normalizedEntry || !executable) throw new Error('Browser authentication is unavailable.');
  signal.throwIfAborted();

  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  const operation = (async () => {
    if (!(await verifyAuthenticationExecutable(executable)))
      throw new Error('Browser authentication executable mismatch.');
    active.throwIfAborted();
    const profile = mkdtempSync(join(app.getPath('temp'), BROWSER_AUTHENTICATION_PROFILE_PREFIX));
    try {
      return await runAuthenticationChild(
        executable,
        profile,
        new URL(normalizedEntry),
        browserProxy,
        active,
      );
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
        console.warn('[BrowserAuthentication] Could not remove the temporary browser profile.');
      });
    }
  })().finally(() => processes.delete(controller));
  processes.set(controller, operation);
  return operation;
}

export async function stopBrowserAuthenticationProcesses(): Promise<void> {
  stopping = true;
  for (const controller of processes.keys()) controller.abort();
  await Promise.allSettled([...processes.values(), ...cookieCommits]);
}

export function commitBrowserAuthenticationCookies(
  browserSession: Electron.Session,
  entryUrl: string,
  cookies: readonly BrowserAuthenticationCookie[],
  isCurrent: () => boolean,
): Promise<void> {
  const operation = commitAuthenticationCookies(
    browserSession,
    entryUrl,
    cookies,
    isCurrent,
  ).finally(() => cookieCommits.delete(operation));
  cookieCommits.add(operation);
  return operation;
}

async function commitAuthenticationCookies(
  browserSession: Electron.Session,
  entryUrl: string,
  cookies: readonly BrowserAuthenticationCookie[],
  isCurrent: () => boolean,
): Promise<void> {
  const normalizedEntry = normalizeBrowserAuthenticationEntry(entryUrl);
  if (stopping || !normalizedEntry || !isCurrent())
    throw new Error('Browser authentication has expired.');
  const entry = new URL(normalizedEntry);
  const scoped = validateBrowserAuthenticationCookies(cookies, entry);
  const keys = new Set(scoped.map(browserAuthenticationCookieKey));
  if (keys.size !== scoped.length) {
    throw new Error('Browser authentication cookie scope is unsupported.');
  }
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const contents = view.webContents;
  const cdp = contents.debugger;
  const urls = browserAuthenticationCookieUrls(entry, scoped);
  const hasPartitionedCookie = scoped.some(cookie => cookie.partitionKey);
  const readCookies = async (): Promise<Map<string, BrowserAuthenticationCookie>> => {
    // The blank target cannot supply a page top-level partition key. CDP can
    // enumerate its exact Session here, and only the scoped identities survive.
    const result = hasPartitionedCookie
      ? await cdp.sendCommand('Network.getAllCookies')
      : await cdp.sendCommand('Network.getCookies', { urls });
    return readExistingBrowserAuthenticationCookies(result.cookies, entry, keys);
  };
  const assertCurrent = (): void => {
    if (
      stopping ||
      !isCurrent() ||
      contents.isDestroyed() ||
      !isSameBrowserSession(contents.session, browserSession)
    ) {
      throw new Error('Browser authentication has expired.');
    }
  };
  try {
    await contents.loadURL('about:blank');
    assertCurrent();
    cdp.attach('1.3');
    const before = await readCookies();
    assertCurrent();
    if (
      scoped.some(cookie => cookie.expires !== undefined && cookie.expires <= Date.now() / 1000)
    ) {
      throw new Error('Browser authentication cookies have expired.');
    }
    try {
      await cdp.sendCommand('Network.setCookies', { cookies: scoped });
      assertCurrent();
      const stored = await readCookies();
      assertCurrent();
      if (
        !scoped.every(cookie => {
          const actual = stored.get(browserAuthenticationCookieKey(cookie));
          return actual && matchesBrowserAuthenticationCookie(cookie, actual);
        })
      )
        throw new Error('Browser authentication cookies could not be verified.');
    } catch (error) {
      let rollbackUnconfirmed = false;
      for (const cookie of scoped) {
        try {
          // A new login or logout on another tab may supersede this write. Restore
          // only a value that still exactly matches what this handoff attempted.
          const key = browserAuthenticationCookieKey(cookie);
          const actual = (await readCookies()).get(key);
          if (!actual || !matchesBrowserAuthenticationCookie(cookie, actual)) continue;
          const previous = before.get(key);
          await cdp.sendCommand('Network.setCookies', {
            cookies: [previous ?? { ...cookie, expires: 0 }],
          });
          const restored = (await readCookies()).get(key);
          if (
            previous
              ? !restored || !matchesBrowserAuthenticationCookie(previous, restored)
              : restored
          )
            rollbackUnconfirmed = true;
        } catch {
          rollbackUnconfirmed = true;
        }
      }
      if (rollbackUnconfirmed)
        console.warn('[BrowserAuthentication] Could not confirm cookie rollback.');
      throw error;
    }
  } finally {
    if (!contents.isDestroyed()) contents.close();
  }
}
