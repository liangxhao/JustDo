import { createRequire } from 'node:module';

import {
  AppInitializationActivity,
  AppInitializationPhase,
  AppInitializationStep,
} from '@shared/app/initialization';
import { StartupRoute } from '@shared/app/startup/routing';
import { StartupCompatibilityErrorCode } from '@shared/app/startup/versionPolicy';
import { afterEach, expect, test, vi } from 'vitest';

import {
  createPreviewState,
  installPreviewBridge,
  parsePreviewOptions,
  PREVIEW_DOWNGRADE_REQUEST_ID,
  PreviewFailureKind,
  previewSteps,
} from './state';

const require = createRequire(import.meta.url);
const {
  parsePreviewArguments,
  createPreviewServer,
} = require('../../../scripts/startup/run-preview.cjs');
afterEach(() => vi.unstubAllEnvs());

test.each([
  [PreviewFailureKind.Generic, undefined],
  [PreviewFailureKind.VersionUnknown, StartupCompatibilityErrorCode.VersionUnconfirmed],
  [PreviewFailureKind.DataUnsupported, StartupCompatibilityErrorCode.NativeSchemaUnsupported],
])(
  'simulated failure %s uses the exact structured Main code without an extra business route',
  (kind, code) => {
    const state = createPreviewState(
      { route: StartupRoute.Upgrade, language: 'en', theme: 'light' },
      0,
      AppInitializationPhase.Failed,
      1000,
      AppInitializationActivity.NativeInspect,
      kind,
    );
    expect(state.route).toBe(StartupRoute.Upgrade);
    expect(state.failure).toMatchObject({ source: 'main', context: {}, error: { code } });
    expect(state.error).toContain('Simulated error');
  },
);

test('downgrade rehearsal waits for explicit in-memory confirmation instead of manufacturing a failure or completion', async () => {
  const options = { route: StartupRoute.Upgrade, language: 'en', theme: 'light' } as const;
  const state = createPreviewState(
    options,
    0,
    AppInitializationPhase.Failed,
    1000,
    AppInitializationActivity.NativeInspect,
    PreviewFailureKind.Downgrade,
  );
  expect(state.phase).toBe(AppInitializationPhase.Preparing);
  expect(state.downgradeConfirmation?.requestId).toBe(PREVIEW_DOWNGRADE_REQUEST_ID);
  expect(state.failure).toBeUndefined();
  expect(state.completedSteps).toBe(0);
  const target = {} as Pick<Window, 'electron'>;
  const notify = vi.fn();
  const dispose = installPreviewBridge(target, true, options, notify);
  try {
    await expect(
      target.electron.initialization.confirmDowngrade({ requestId: 'wrong-request' }),
    ).resolves.toEqual({ confirmed: false });
    expect(notify).not.toHaveBeenCalled();
    await expect(
      target.electron.initialization.confirmDowngrade({ requestId: PREVIEW_DOWNGRADE_REQUEST_ID }),
    ).resolves.toEqual({ confirmed: true });
    expect(notify).toHaveBeenCalledWith('confirmDowngrade');
    expect(target.electron).not.toHaveProperty('openclaw');
  } finally {
    dispose();
  }
});

test.each(['--profile', '--user-data-dir', '--route', '--unknown', '--theme'])(
  'CLI refuses invalid or profile-bearing input %s',
  key => {
    expect(() => parsePreviewArguments([key, '/user/profile'])).toThrow();
  },
);
test('CLI accepts only closed options and rejects repeated flags without creating a profile', () => {
  expect(parsePreviewArguments([])).toEqual({ route: 'fresh', language: 'zh', theme: 'light' });
  expect(
    parsePreviewArguments(['--route', 'upgrade', '--language', 'en', '--theme', 'dark']),
  ).toEqual({ route: 'upgrade', language: 'en', theme: 'dark' });
  expect(() => parsePreviewArguments(['--route', 'fresh', '--route', 'normal'])).toThrow();
});

test.each([
  '?profile=C:/users/profile',
  '?route=unknown',
  '?route=fresh&route=normal',
  '?theme=secret',
  '?language=fr',
])('browser entry rejects %s', search => {
  expect(() => parsePreviewOptions(search)).toThrow();
});

test.each(Object.values(StartupRoute))(
  'four-route state for %s has exact steps and no real data path',
  route => {
    const options = { route, language: 'en', theme: 'light' } as const;
    const state = createPreviewState(options, 0, AppInitializationPhase.Preparing, 1000);
    expect(state.route).toBe(route);
    expect(state.totalSteps).toBe(route === 'migration' ? 6 : route === 'upgrade' ? 5 : 4);
    expect(state.userDataPath).toContain('no real directory');
    if (route === StartupRoute.Upgrade) {
      expect(state.step).toBe(AppInitializationStep.DatabaseUpgrade);
      expect(state.activity).toBe(AppInitializationActivity.NativeInspect);
      expect(state).not.toHaveProperty('historySummary');
    }
    expect(createPreviewState(options, 0, AppInitializationPhase.Ready, 1000).completedSteps).toBe(
      previewSteps(route).length,
    );
  },
);

test('preview bridge refuses production and existing Electron instead of replacing native capabilities', () => {
  const options = parsePreviewOptions('');
  const empty = {} as Pick<Window, 'electron'>;
  expect(() => installPreviewBridge(empty, false, options, vi.fn())).toThrow();
  expect(empty).not.toHaveProperty('electron');
  const native = Object.freeze({ store: 'real-store-sentinel' });
  const existing = { electron: native } as unknown as Pick<Window, 'electron'>;
  expect(() => installPreviewBridge(existing, true, options, vi.fn())).toThrow();
  expect(existing.electron).toBe(native);
});

test('frozen in-memory bridge has no RPC, profile, filesystem or store capability and actions stay simulated', async () => {
  const target = {} as Pick<Window, 'electron'>;
  const notify = vi.fn();
  const dispose = installPreviewBridge(target, true, parsePreviewOptions('?route=upgrade'), notify);
  expect(Object.keys(target.electron)).toEqual(['platform', 'window', 'initialization', 'log']);
  expect(Object.isFrozen(target.electron)).toBe(true);
  expect(Object.isFrozen(target.electron.initialization)).toBe(true);
  expect(target.electron).not.toHaveProperty('openclaw');
  expect(target.electron).not.toHaveProperty('store');
  await target.electron.initialization.relaunch();
  await target.electron.initialization.openSupport('openData');
  expect(notify.mock.calls).toEqual([['restart'], ['support']]);
  dispose();
  expect(target).not.toHaveProperty('electron');
});

test('server rejects production mode before opening a listener', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  await expect(createPreviewServer(parsePreviewArguments([]))).rejects.toThrow(/development/);
});

test('actual standalone Vite server serves only preview HTML on a unique loopback listener', async () => {
  const server = await createPreviewServer(parsePreviewArguments(['--route', 'upgrade']));
  try {
    const url = new URL(server.url);
    expect(url.hostname).toBe('127.0.0.1');
    expect(Number(url.port)).toBe(server.port);
    expect(Number(url.port)).not.toBe(5173);
    expect(url.pathname).toBe('/startup-preview.html');
    expect(url.searchParams.get('route')).toBe('upgrade');
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('/startup-preview/main.tsx');
    expect((await fetch(new URL('/index.html', url))).status).toBe(404);
    expect((await fetch(new URL('/workspace.html', url))).status).toBe(404);
    const entry = await fetch(new URL('/startup-preview/main.tsx', url));
    expect(entry.status).toBe(200);
    const transformed = await entry.text();
    expect(transformed).toContain('installPreviewBridge');
    expect(transformed).not.toContain('dist-electron');
  } finally {
    await server.close();
  }
}, 60_000);
