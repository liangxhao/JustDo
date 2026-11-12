import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { app, BrowserWindow, session, WebContentsView } from 'electron';

import { registerBackgroundBrowserGuest } from '../../../src/main/browser/backgroundBrowserGuestRegistry';
import { BrowserAuthenticationNavigation } from '../../../src/main/browser/browserAuthenticationNavigation';
import {
  configureBrowserAuthenticationNavigation,
  configureBrowserSessionUi,
  ensureBrowserSessionPolicy,
} from '../../../src/main/browser/browserSessionPolicy';
import { reserveBackgroundBrowserStorageClear } from '../../../src/main/browser/data/backgroundBrowserStorage';
import { applyBrowserProxyPreference } from '../../../src/main/core/network/systemProxyPreference';
import { BROWSER_AUTHENTICATION_SWITCH } from '../../../src/shared/browser/browserAuthentication';

type Scenario = {
  name: string;
  url: string;
  businessUrl: string;
  providerUrl: string;
  headless?: boolean;
  show?: boolean;
};
type Fixture = {
  certificatePin: string;
  helper: string;
  helperAgent: string;
  profile: string;
  temp: string;
  scenarios: Scenario[];
};
type NavigationResult = { outcome: 'authenticated' | 'login-page'; elapsedMs: number };

const fixture = JSON.parse(process.env.BROWSER_AUTHENTICATION_FIXTURE ?? '') as Fixture;
app.commandLine.appendSwitch('ignore-certificate-errors-spki-list', fixture.certificatePin);
app.setPath('temp', fixture.temp);
if (
  basename(process.execPath).toLowerCase() === fixture.helper &&
  process.argv.includes(BROWSER_AUTHENTICATION_SWITCH)
) {
  // The fake SPES service uses this marker to simulate its different replies.
  app.userAgentFallback += ` ${fixture.helperAgent}`;
} else {
  for (const key of ['appData', 'userData', 'sessionData', 'home'] as const)
    app.setPath(key, fixture.profile);
  app.on('window-all-closed', () => {});
  process.on('disconnect', () => app.exit(1));
}

const directProxy = { browserProxy: { mode: 'direct' as const } };

function navigate(guest: Electron.WebContents, scenario: Scenario, url?: string) {
  const startedAt = performance.now();
  return new Promise<NavigationResult>((resolve, reject) => {
    const finish = async () => {
      const currentUrl = guest.getURL();
      if (currentUrl === scenario.businessUrl) {
        const authenticated = await guest
          .executeJavaScript('document.body.textContent.includes("模拟自动登录成功")')
          .catch(() => false);
        if (!authenticated || guest.getURL() !== currentUrl) return;
      }
      const outcome =
        currentUrl === scenario.providerUrl
          ? 'login-page'
          : currentUrl === scenario.businessUrl
            ? 'authenticated'
            : null;
      if (outcome) {
        clearTimeout(timeout);
        guest.off('did-finish-load', finish);
        resolve({ outcome, elapsedMs: Math.round(performance.now() - startedAt) });
      }
    };
    const timeout = setTimeout(() => {
      guest.off('did-finish-load', finish);
      reject(new Error(`Fixture page did not finish: ${scenario.name}`));
    }, 42_000);
    guest.on('did-finish-load', finish);
    if (url === undefined) {
      guest.reload();
      return;
    }
    void guest.loadURL(url).catch(error => {
      if (!String(error).includes('ERR_ABORTED')) {
        clearTimeout(timeout);
        guest.off('did-finish-load', finish);
        reject(error);
      }
    });
  });
}

async function openScenario(scenario: Scenario) {
  const partition = `auth-fixture-${scenario.name}`;
  const browserSession = session.fromPartition(partition);
  if (scenario.headless) {
    ensureBrowserSessionPolicy(browserSession);
    const view = new WebContentsView({
      webPreferences: { session: browserSession, sandbox: true },
    });
    registerBackgroundBrowserGuest(view.webContents);
    return { guest: view.webContents, close: () => view.webContents.close() };
  }

  const owned = new Set<Electron.WebContents>();
  configureBrowserSessionUi(browserSession, Symbol(partition), {
    ownsGuest: guest => Boolean(guest && owned.has(guest) && !guest.isDestroyed()),
  });
  const window = new BrowserWindow({
    show: false,
    width: 920,
    height: 620,
    webPreferences: { sandbox: true, webviewTag: true },
  });
  window.removeMenu();
  const closed = new Promise<void>(resolve => window.once('closed', resolve));
  const attached = new Promise<Electron.WebContents>(resolve => {
    window.webContents.once('did-attach-webview', (_event, guest) => {
      owned.add(guest);
      guest.once('destroyed', () => owned.delete(guest));
      resolve(guest);
    });
  });
  try {
    await window.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<!doctype html><meta charset="utf-8"><title>本地企业自动登录测试</title>' +
            '<style>html,body,webview{display:flex;width:100%;height:100%;margin:0}</style>' +
            `<webview src="about:blank" partition="${partition}"></webview>`,
        ),
    );
    return { guest: await attached, close: () => window.destroy(), window, closed };
  } catch (error) {
    window.destroy();
    throw error;
  }
}

async function waitForAuthenticationCleanup(): Promise<void> {
  const deadline = performance.now() + 5_000;
  do {
    const release = reserveBackgroundBrowserStorageClear();
    if (release) {
      release();
      return;
    }
    await delay(50);
  } while (performance.now() < deadline);
  throw new Error('The timed-out helper still holds the browser session');
}

/** Replaces only the product storage/UI startup in the fixture bundle. */
export async function runFixtureBrowser(): Promise<void> {
  await app.whenReady();
  if (!app.isPackaged || !(await applyBrowserProxyPreference(directProxy)))
    throw new Error('Could not start the packaged browser fixture');
  const authentication = new BrowserAuthenticationNavigation(() => directProxy);
  configureBrowserAuthenticationNavigation(authentication);
  const results: (NavigationResult & {
    name: string;
    retry: NavigationResult['outcome'] | null;
    reload: NavigationResult['outcome'] | null;
  })[] = [];
  let visible: Awaited<ReturnType<typeof openScenario>> | undefined;
  try {
    for (const scenario of fixture.scenarios) {
      console.log(`[local-auth] ${scenario.name}`);
      const surface = await openScenario(scenario);
      try {
        const result = await navigate(surface.guest, scenario, scenario.url);
        let retry: NavigationResult['outcome'] | null = null;
        if (scenario.name === 'helper-timeout') {
          await waitForAuthenticationCleanup();
          retry = (await navigate(surface.guest, scenario, scenario.url)).outcome;
        }
        const reload =
          (retry ?? result.outcome) === 'authenticated'
            ? (await navigate(surface.guest, scenario)).outcome
            : null;
        results.push({ name: scenario.name, ...result, retry, reload });
        if (scenario.show) visible = surface;
      } finally {
        if (visible !== surface) surface.close();
      }
    }
    await new Promise<void>((resolve, reject) => {
      process.send?.({ results }, error => (error ? reject(error) : resolve()));
      if (!process.send) reject(new Error('Fixture report channel is unavailable'));
    });
    if (visible?.window && !visible.window.isDestroyed()) {
      visible.window.show();
      await visible.closed;
    }
    await authentication.stop();
    app.exit(0);
  } catch (error) {
    if (visible?.window && !visible.window.isDestroyed()) visible.close();
    await authentication.stop();
    console.error(error instanceof Error ? error.message : 'Fixture failed');
    app.exit(1);
  }
}
